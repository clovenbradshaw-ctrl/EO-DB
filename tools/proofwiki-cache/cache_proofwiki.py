"""
ProofWiki corpus cacher.

Fetches pages from ProofWiki's MediaWiki API, extracts proof bodies, splits
them into declarative clauses (5-40 words), and writes:

  <cache_dir>/pages/<sha1>.json    — one raw API response per page
  <cache_dir>/index.json           — {page_title: cache_filename, ...}
  <cache_dir>/raw_clauses.jsonl    — pipeline-ready clauses

The cache is incremental: re-running skips pages already on disk. Downstream
analysis pipelines (eo-lexical-analysis-2.0) can then read raw_clauses.jsonl
directly without hitting the live API.

Why this exists: the live ProofWiki pipeline started returning 403 Forbidden
from Cloudflare for default Python user-agents. This cacher sets a compliant
User-Agent per MediaWiki policy (with contact info) and rate-limits requests.

Usage:
  python cache_proofwiki.py                         # default categories
  python cache_proofwiki.py --limit 200             # stop after 200 pages
  python cache_proofwiki.py --cache-dir data/pw     # custom cache location
  python cache_proofwiki.py --contact you@host.tld  # override UA contact
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Iterable, Iterator

API_URL = "https://proofwiki.org/w/api.php"
DEFAULT_CATEGORIES = ("Proven Results", "Theorems")
DEFAULT_CACHE_DIR = "data/proofwiki"
DEFAULT_CONTACT = "https://github.com/clovenbradshaw-ctrl/eo-db"
USER_AGENT_TEMPLATE = "EO-DB-Corpus-Cacher/1.0 ({contact}) python-urllib/{py}"

MIN_WORDS = 5
MAX_WORDS = 40
REQUEST_SPACING_S = 1.0
MAX_RETRIES = 5


@dataclass
class FetchError(Exception):
    status: int
    url: str
    body: str

    def __str__(self) -> str:
        return f"HTTP {self.status} for {self.url}"


def user_agent(contact: str) -> str:
    return USER_AGENT_TEMPLATE.format(
        contact=contact,
        py=".".join(str(v) for v in sys.version_info[:3]),
    )


def api_get(params: dict, ua: str) -> dict:
    """GET the MediaWiki API with retry/backoff."""
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    url = f"{API_URL}?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": ua,
            "Accept": "application/json",
            "Accept-Encoding": "identity",
        },
    )
    attempt = 0
    while True:
        attempt += 1
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8", errors="replace")
            return json.loads(body)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:400] if e.fp else ""
            if e.code in (429, 500, 502, 503, 504) and attempt <= MAX_RETRIES:
                wait = min(60.0, 2 ** attempt + random.random())
                print(f"  ! HTTP {e.code} on {params.get('list') or params.get('titles') or 'api'} — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
                time.sleep(wait)
                continue
            if e.code == 403 and attempt == 1:
                print(f"  ! 403 Forbidden. Confirm your User-Agent includes contact info per https://meta.wikimedia.org/wiki/User-Agent_policy")
            raise FetchError(status=e.code, url=url, body=body) from e
        except urllib.error.URLError as e:
            if attempt <= MAX_RETRIES:
                wait = min(30.0, 2 ** attempt)
                print(f"  ! Network error ({e.reason}) — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
                time.sleep(wait)
                continue
            raise


def list_category_members(category: str, ua: str) -> Iterator[str]:
    """Yield page titles in main namespace for a category, following continuation."""
    cont: dict = {}
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmlimit": "500",
            "cmnamespace": "0",
        }
        params.update(cont)
        data = api_get(params, ua)
        for m in data.get("query", {}).get("categorymembers", []):
            yield m["title"]
        if "continue" not in data:
            return
        cont = data["continue"]
        time.sleep(REQUEST_SPACING_S)


def fetch_page_parse(title: str, ua: str) -> dict:
    """Return the MediaWiki `parse` result (HTML + wikitext) for a page."""
    params = {
        "action": "parse",
        "page": title,
        "prop": "wikitext|text",
        "redirects": "1",
    }
    return api_get(params, ua)


SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")
TAG_RE = re.compile(r"<[^>]+>")
REF_RE = re.compile(r"<ref[^>]*>.*?</ref>|<ref[^/]*/>", re.DOTALL)
MATH_RE = re.compile(r"<math[^>]*>.*?</math>", re.DOTALL)
WS_RE = re.compile(r"\s+")
PROOF_SECTION_RE = re.compile(
    r"==\s*Proof[^=]*==\s*(.*?)(?=\n==[^=]|\Z)",
    re.DOTALL | re.IGNORECASE,
)
WIKI_LINK_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]")
TEMPLATE_RE = re.compile(r"\{\{[^{}]*\}\}")


def strip_wikitext(wt: str) -> str:
    """Flatten wikitext to plain prose. Conservative: drops templates/links/math."""
    prev = None
    while prev != wt:
        prev = wt
        wt = TEMPLATE_RE.sub(" ", wt)
    wt = MATH_RE.sub(" ", wt)
    wt = REF_RE.sub(" ", wt)
    wt = WIKI_LINK_RE.sub(r"\1", wt)
    wt = TAG_RE.sub(" ", wt)
    wt = html.unescape(wt)
    wt = wt.replace("'''", "").replace("''", "")
    wt = WS_RE.sub(" ", wt)
    return wt.strip()


def extract_proof_text(wikitext: str) -> str:
    """Concatenate every ==Proof== section, or fall back to the whole body."""
    matches = PROOF_SECTION_RE.findall(wikitext)
    if matches:
        return "\n\n".join(strip_wikitext(m) for m in matches)
    return strip_wikitext(wikitext)


DECLARATIVE_END = (".", "!")


def split_clauses(text: str) -> Iterable[str]:
    for sent in SENT_SPLIT_RE.split(text):
        sent = sent.strip()
        if not sent:
            continue
        if not sent.endswith(DECLARATIVE_END):
            continue
        if sent.endswith("?"):
            continue
        words = sent.split()
        if not (MIN_WORDS <= len(words) <= MAX_WORDS):
            continue
        if not re.search(r"[A-Za-z]{3,}", sent):
            continue
        yield sent


def cache_key(title: str) -> str:
    return hashlib.sha1(title.encode("utf-8")).hexdigest()[:16] + ".json"


def load_index(cache_dir: str) -> dict:
    path = os.path.join(cache_dir, "index.json")
    if os.path.isfile(path):
        with open(path) as f:
            return json.load(f)
    return {}


def save_index(cache_dir: str, index: dict) -> None:
    path = os.path.join(cache_dir, "index.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(index, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def cache_page(cache_dir: str, title: str, payload: dict) -> str:
    pages_dir = os.path.join(cache_dir, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    fname = cache_key(title)
    with open(os.path.join(pages_dir, fname), "w") as f:
        json.dump({"title": title, "parse": payload.get("parse", {})}, f)
    return fname


def read_cached_page(cache_dir: str, fname: str) -> dict:
    with open(os.path.join(cache_dir, "pages", fname)) as f:
        return json.load(f)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    ap.add_argument("--categories", nargs="+", default=list(DEFAULT_CATEGORIES))
    ap.add_argument("--limit", type=int, default=0, help="max pages to fetch (0 = all)")
    ap.add_argument("--contact", default=DEFAULT_CONTACT, help="User-Agent contact")
    ap.add_argument("--refresh", action="store_true", help="ignore cache and re-fetch")
    args = ap.parse_args()

    ua = user_agent(args.contact)
    os.makedirs(args.cache_dir, exist_ok=True)
    index = {} if args.refresh else load_index(args.cache_dir)

    titles: list[str] = []
    seen: set[str] = set()
    for cat in args.categories:
        print(f"  - Listing Category:{cat}")
        try:
            for title in list_category_members(cat, ua):
                if title in seen:
                    continue
                seen.add(title)
                titles.append(title)
                if args.limit and len(titles) >= args.limit:
                    break
        except FetchError as e:
            print(f"  ! Category {cat}: {e} — body: {e.body[:160]}")
        if args.limit and len(titles) >= args.limit:
            break

    print(f"  - {len(titles)} unique page titles")
    if not titles:
        print("  ! No titles retrieved. Aborting without overwriting raw_clauses.jsonl.")
        return 2

    fetched_new = 0
    for i, title in enumerate(titles, 1):
        if title in index and not args.refresh:
            continue
        try:
            data = fetch_page_parse(title, ua)
        except FetchError as e:
            print(f"  ! {title}: {e}")
            continue
        fname = cache_page(args.cache_dir, title, data)
        index[title] = fname
        fetched_new += 1
        if fetched_new % 25 == 0:
            save_index(args.cache_dir, index)
            print(f"  · {i}/{len(titles)} (fetched {fetched_new} new)")
        time.sleep(REQUEST_SPACING_S)
    save_index(args.cache_dir, index)
    print(f"  - Fetched {fetched_new} new pages (total cached: {len(index)})")

    clauses_path = os.path.join(args.cache_dir, "raw_clauses.jsonl")
    written = 0
    with open(clauses_path, "w") as out:
        for title, fname in sorted(index.items()):
            page = read_cached_page(args.cache_dir, fname)
            parse = page.get("parse", {})
            wikitext = parse.get("wikitext") or ""
            if isinstance(wikitext, dict):
                wikitext = wikitext.get("*", "")
            if not wikitext:
                continue
            proof = extract_proof_text(wikitext)
            for clause in split_clauses(proof):
                out.write(json.dumps({
                    "text": clause,
                    "lang": "en",
                    "source": "proofwiki",
                    "page": title,
                    "url": f"https://proofwiki.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
                }) + "\n")
                written += 1
    print(f"  - Wrote {written} clauses to {clauses_path}")
    return 0 if written > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
