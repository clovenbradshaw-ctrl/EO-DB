"""
ProofWiki corpus cacher.

Fetches pages from ProofWiki, extracts proof bodies, splits them into
declarative clauses (5-40 words), and writes:

  <cache_dir>/pages/<sha1>.json    — one cached page per title
  <cache_dir>/index.json           — {page_title: cache_filename, ...}
  <cache_dir>/raw_clauses.jsonl    — pipeline-ready clauses
  <run_dir>/raw_clauses.jsonl      — same clauses, staged for downstream
  <run_dir>/manifest.json          — run metadata

The cache is incremental: re-running skips pages already on disk.

Why this exists: the live ProofWiki pipeline returns 403 Forbidden from
Cloudflare for default Python user-agents. This cacher:
  - sends a MediaWiki-policy-compliant User-Agent with contact info
  - rate-limits to 1 req/s, retries 429/5xx with exponential backoff
  - falls back from api.php → action=raw wikitext → HTML render
  - falls back from list=categorymembers → HTML category page scraping
  - can accept a --titles-file if every live endpoint is blocked

Typical usage:
  # default — fetch Proven Results + Theorems, stage run dir, write clauses
  python cache_proofwiki.py

  # small smoke test (fetch 20 pages)
  python cache_proofwiki.py --limit 20

  # re-use an existing run dir (pipes into upstream --phase classify)
  python cache_proofwiki.py --run-dir ../eo-lexical-analysis-2.0/run_2026-04-20_234306

  # seed titles manually if live categorymembers is unreachable
  python cache_proofwiki.py --titles-file titles.txt

After a run, the last line of output is the path to hand to the upstream
pipeline (e.g. `--resume --run-dir <path>` or `--phase classify ...`).
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html as html_lib
import json
import os
import random
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator

BASE = "https://proofwiki.org"
API_URL = f"{BASE}/w/api.php"
INDEX_URL = f"{BASE}/w/index.php"
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


def _request(url: str, ua: str, accept: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": ua,
            "Accept": accept,
            "Accept-Encoding": "identity",
        },
    )
    attempt = 0
    while True:
        attempt += 1
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:400] if e.fp else ""
            if e.code in (429, 500, 502, 503, 504) and attempt <= MAX_RETRIES:
                wait = min(60.0, 2 ** attempt + random.random())
                print(f"  ! HTTP {e.code} — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
                time.sleep(wait)
                continue
            raise FetchError(status=e.code, url=url, body=body) from e
        except urllib.error.URLError as e:
            if attempt <= MAX_RETRIES:
                wait = min(30.0, 2 ** attempt)
                print(f"  ! Network error ({e.reason}) — retry {attempt}/{MAX_RETRIES} in {wait:.1f}s")
                time.sleep(wait)
                continue
            raise


def api_get_json(params: dict, ua: str) -> dict:
    query = urllib.parse.urlencode({**params, "format": "json", "formatversion": "2"})
    url = f"{API_URL}?{query}"
    raw = _request(url, ua, "application/json")
    return json.loads(raw.decode("utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# Category listing — api.php → HTML fallback
# ---------------------------------------------------------------------------

CATEGORY_LINK_RE = re.compile(
    r'<div[^>]*id="mw-pages".*?</div>\s*</div>',
    re.DOTALL,
)
CATEGORY_ITEM_RE = re.compile(r'<a href="/wiki/([^"#?]+)"[^>]*title="([^"]+)"')
NEXT_PAGE_RE = re.compile(r'<a href="([^"]*pagefrom=[^"]+)"[^>]*>next page</a>')


def _list_via_api(category: str, ua: str) -> Iterator[str]:
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
        data = api_get_json(params, ua)
        for m in data.get("query", {}).get("categorymembers", []):
            yield m["title"]
        if "continue" not in data:
            return
        cont = data["continue"]
        time.sleep(REQUEST_SPACING_S)


def _list_via_html(category: str, ua: str) -> Iterator[str]:
    path = f"/wiki/Category:{urllib.parse.quote(category.replace(' ', '_'))}"
    url = f"{BASE}{path}"
    while True:
        raw = _request(url, ua, "text/html").decode("utf-8", errors="replace")
        block_match = CATEGORY_LINK_RE.search(raw)
        block = block_match.group(0) if block_match else raw
        seen_here = set()
        for _, title in CATEGORY_ITEM_RE.findall(block):
            t = html_lib.unescape(title)
            if t.startswith(("Category:", "File:", "Template:", "Help:")):
                continue
            if t in seen_here:
                continue
            seen_here.add(t)
            yield t
        nxt = NEXT_PAGE_RE.search(raw)
        if not nxt:
            return
        url = f"{BASE}{html_lib.unescape(nxt.group(1))}" if nxt.group(1).startswith("/") else html_lib.unescape(nxt.group(1))
        time.sleep(REQUEST_SPACING_S)


def list_category_members(category: str, ua: str) -> Iterator[str]:
    try:
        yield from _list_via_api(category, ua)
        return
    except FetchError as e:
        if e.status != 403:
            raise
        print(f"  - api.php categorymembers 403'd — falling back to HTML scrape")
    yield from _list_via_html(category, ua)


# ---------------------------------------------------------------------------
# Page fetch — api.php parse → action=raw wikitext → HTML render
# ---------------------------------------------------------------------------

def _parse_via_api(title: str, ua: str) -> dict:
    params = {
        "action": "parse",
        "page": title,
        "prop": "wikitext",
        "redirects": "1",
    }
    data = api_get_json(params, ua)
    parse = data.get("parse", {})
    wt = parse.get("wikitext") or ""
    if isinstance(wt, dict):
        wt = wt.get("*", "")
    if not wt:
        raise FetchError(204, f"api.parse empty for {title}", "")
    return {"title": title, "wikitext": wt, "source": "api.parse"}


def _raw_wikitext(title: str, ua: str) -> dict:
    q = urllib.parse.urlencode({"title": title, "action": "raw"})
    url = f"{INDEX_URL}?{q}"
    raw = _request(url, ua, "text/plain").decode("utf-8", errors="replace")
    if not raw.strip():
        raise FetchError(204, f"action=raw empty for {title}", "")
    return {"title": title, "wikitext": raw, "source": "action=raw"}


HTML_PROOF_H2_RE = re.compile(
    r'<h2[^>]*>[^<]*<span[^>]*id="Proof[^"]*"[^>]*>.*?</h2>(.*?)(?=<h2|<div id="catlinks")',
    re.DOTALL | re.IGNORECASE,
)


def _html_render(title: str, ua: str) -> dict:
    url = f"{BASE}/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"
    raw = _request(url, ua, "text/html").decode("utf-8", errors="replace")
    sections = HTML_PROOF_H2_RE.findall(raw)
    if not sections:
        raise FetchError(204, f"html render has no proof section for {title}", "")
    joined = "\n\n== Proof ==\n".join(sections)
    return {"title": title, "wikitext": "== Proof ==\n" + joined, "source": "html"}


FETCH_STRATEGIES: tuple[Callable[[str, str], dict], ...] = (
    _parse_via_api,
    _raw_wikitext,
    _html_render,
)


def fetch_page(title: str, ua: str) -> dict:
    last_err: Exception | None = None
    for strat in FETCH_STRATEGIES:
        try:
            return strat(title, ua)
        except FetchError as e:
            last_err = e
            if e.status not in (403, 204, 404):
                raise
    assert last_err is not None
    raise last_err


# ---------------------------------------------------------------------------
# Wikitext → clauses
# ---------------------------------------------------------------------------

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
    prev = None
    while prev != wt:
        prev = wt
        wt = TEMPLATE_RE.sub(" ", wt)
    wt = MATH_RE.sub(" ", wt)
    wt = REF_RE.sub(" ", wt)
    wt = WIKI_LINK_RE.sub(r"\1", wt)
    wt = TAG_RE.sub(" ", wt)
    wt = html_lib.unescape(wt)
    wt = wt.replace("'''", "").replace("''", "")
    wt = WS_RE.sub(" ", wt)
    return wt.strip()


def extract_proof_text(wikitext: str) -> str:
    matches = PROOF_SECTION_RE.findall(wikitext)
    if matches:
        return "\n\n".join(strip_wikitext(m) for m in matches)
    return strip_wikitext(wikitext)


DECLARATIVE_END = (".", "!")


def split_clauses(text: str) -> Iterable[str]:
    for sent in SENT_SPLIT_RE.split(text):
        sent = sent.strip()
        if not sent or sent.endswith("?"):
            continue
        if not sent.endswith(DECLARATIVE_END):
            continue
        words = sent.split()
        if not (MIN_WORDS <= len(words) <= MAX_WORDS):
            continue
        if not re.search(r"[A-Za-z]{3,}", sent):
            continue
        yield sent


# ---------------------------------------------------------------------------
# Cache I/O
# ---------------------------------------------------------------------------

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
        json.dump(payload, f)
    return fname


def read_cached_page(cache_dir: str, fname: str) -> dict:
    with open(os.path.join(cache_dir, "pages", fname)) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Run dir staging
# ---------------------------------------------------------------------------

def resolve_run_dir(spec: str | None) -> str:
    if spec and spec != "auto":
        os.makedirs(spec, exist_ok=True)
        return spec
    stamp = dt.datetime.now().strftime("run_%Y-%m-%d_%H%M%S")
    path = os.path.join("runs", stamp)
    os.makedirs(path, exist_ok=True)
    return path


def write_manifest(run_dir: str, stats: dict) -> None:
    with open(os.path.join(run_dir, "manifest.json"), "w") as f:
        json.dump(stats, f, indent=2, sort_keys=True)


# ---------------------------------------------------------------------------
# Title sources
# ---------------------------------------------------------------------------

def read_titles_file(path: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    with open(path) as f:
        for line in f:
            t = line.strip()
            if not t or t.startswith("#") or t in seen:
                continue
            seen.add(t)
            out.append(t)
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--cache-dir", default=DEFAULT_CACHE_DIR)
    ap.add_argument("--categories", nargs="+", default=list(DEFAULT_CATEGORIES))
    ap.add_argument("--titles-file", help="newline-separated page titles (bypass category listing)")
    ap.add_argument("--limit", type=int, default=0, help="max pages (0 = all)")
    ap.add_argument("--contact", default=DEFAULT_CONTACT, help="User-Agent contact")
    ap.add_argument("--refresh", action="store_true", help="ignore cache, re-fetch")
    ap.add_argument("--run-dir", default="auto",
                    help="stage raw_clauses.jsonl into this dir (default: runs/run_<stamp>/); "
                         "pass an existing upstream run dir to fill it in place")
    args = ap.parse_args()

    ua = user_agent(args.contact)
    os.makedirs(args.cache_dir, exist_ok=True)
    index = {} if args.refresh else load_index(args.cache_dir)
    run_dir = resolve_run_dir(args.run_dir)

    # --- 1. title list -----------------------------------------------------
    titles: list[str] = []
    seen: set[str] = set()
    if args.titles_file:
        print(f"  - Loading titles from {args.titles_file}")
        for t in read_titles_file(args.titles_file):
            if t not in seen:
                seen.add(t)
                titles.append(t)
                if args.limit and len(titles) >= args.limit:
                    break
    else:
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

    # Fall back to already-cached titles if live listing failed and refresh
    # wasn't requested — lets us still re-emit raw_clauses.jsonl from cache.
    if not titles and index and not args.refresh:
        print(f"  - No live titles; using {len(index)} cached pages")
        titles = sorted(index.keys())

    print(f"  - {len(titles)} unique page titles")
    if not titles:
        print("  ! No titles available. Use --titles-file to seed manually.")
        return 2

    # --- 2. page fetch -----------------------------------------------------
    fetched_new = 0
    failed: list[tuple[str, str]] = []
    for i, title in enumerate(titles, 1):
        if title in index and not args.refresh:
            continue
        try:
            payload = fetch_page(title, ua)
        except FetchError as e:
            failed.append((title, str(e)))
            print(f"  ! {title}: {e}")
            time.sleep(REQUEST_SPACING_S)
            continue
        fname = cache_page(args.cache_dir, title, payload)
        index[title] = fname
        fetched_new += 1
        if fetched_new % 25 == 0:
            save_index(args.cache_dir, index)
            print(f"  · {i}/{len(titles)} (fetched {fetched_new} new, {len(failed)} failed)")
        time.sleep(REQUEST_SPACING_S)
    save_index(args.cache_dir, index)
    print(f"  - Fetched {fetched_new} new pages (total cached: {len(index)}, failed: {len(failed)})")

    # --- 3. clause extraction ---------------------------------------------
    clauses_path = os.path.join(args.cache_dir, "raw_clauses.jsonl")
    written = 0
    pages_with_clauses = 0
    with open(clauses_path, "w") as out:
        for title in sorted(index):
            fname = index[title]
            try:
                page = read_cached_page(args.cache_dir, fname)
            except FileNotFoundError:
                continue
            wikitext = page.get("wikitext") or ""
            if isinstance(wikitext, dict):
                wikitext = wikitext.get("*", "")
            if not wikitext:
                continue
            proof = extract_proof_text(wikitext)
            page_clauses = list(split_clauses(proof))
            if not page_clauses:
                continue
            pages_with_clauses += 1
            for clause in page_clauses:
                out.write(json.dumps({
                    "text": clause,
                    "lang": "en",
                    "source": "proofwiki",
                    "page": title,
                    "url": f"{BASE}/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
                }) + "\n")
                written += 1
    print(f"  - Wrote {written} clauses from {pages_with_clauses} pages to {clauses_path}")

    # --- 4. stage into run dir --------------------------------------------
    staged = os.path.join(run_dir, "raw_clauses.jsonl")
    shutil.copyfile(clauses_path, staged)
    write_manifest(run_dir, {
        "created": dt.datetime.now().isoformat(timespec="seconds"),
        "source": "proofwiki",
        "categories": args.categories if not args.titles_file else None,
        "titles_file": args.titles_file,
        "titles_seen": len(titles),
        "pages_cached": len(index),
        "pages_fetched_this_run": fetched_new,
        "pages_failed_this_run": len(failed),
        "clauses_written": written,
        "pages_with_clauses": pages_with_clauses,
        "cache_dir": os.path.abspath(args.cache_dir),
        "user_agent": ua,
    })
    print(f"  - Staged {staged}")

    if written == 0:
        print("  ! Zero clauses extracted — downstream phases will not have input.")
        return 1

    print()
    print(f"  Run dir: {run_dir}")
    print(f"  Next:    point the upstream pipeline at this run dir, e.g.:")
    print(f"           python app.py --resume --run-dir {run_dir}")
    print(f"           python app.py --phase classify --run-dir {run_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
