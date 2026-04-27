/**
 * Three-tier segmentation: paragraph → sentence → clause.
 *
 * Resolution in EO isn't a UI filter on a neutral document — it's a position
 * in the Structure-Lattice S. Each tier asks a different question:
 *
 *   paragraph  "what is this region about?"          (thematic; INS/SYN)
 *   sentence   "what does this document assert?"     (claims; EVA/NUL)
 *   clause     "what functional unit changed what?"  (operator grain)
 *
 * Rule 5 (Restrictivity): a clause refines its containing sentence, which
 * refines its paragraph. Availability at clause level is a subset of
 * availability at sentence level. We preserve that containment as explicit
 * parent indices so the query layer can navigate the lattice.
 */
import {
  extractDocument as extractClauses,
  type ExtractedDocument,
  type RawClause,
} from './clause-extractor';

export type ResolutionTier = 'paragraph' | 'sentence' | 'clause';

type Script = RawClause['script'];

export interface RawParagraph {
  text: string;
  para_ix: number;
  char_span: [number, number];
  script: Script;
}

export interface RawSentence {
  text: string;
  sent_ix: number;
  /** Index of the paragraph this sentence falls inside. */
  para_ix: number;
  char_span: [number, number];
  script: Script;
}

/**
 * Extended clause with parent-tier linkage. Superset of RawClause — every
 * field on RawClause is preserved; `sent_ix` / `para_ix` are added.
 */
export interface LinkedClause extends RawClause {
  sent_ix: number;
  para_ix: number;
}

export interface SegmentedDocument extends ExtractedDocument {
  paragraphs: RawParagraph[];
  sentences: RawSentence[];
  /** Same list as `clauses` on ExtractedDocument, extended with parent indices. */
  linkedClauses: LinkedClause[];
}

const PARA_SPLIT_RE = /\n\s*\n+/g;
// Sentence boundary: strong punctuation followed by whitespace + an
// uppercase-ish character, OR end-of-input. Matches the boundary, not the
// punctuation itself, so we don't trim off terminal "." / "?" / "!".
const SENT_SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z\u00C0-\u024F\u0400-\u04FF])/g;

const MIN_PARA_LEN = 20;
const MIN_SENT_LEN = 8;

function detectScript(text: string): Script {
  const sample = text.slice(0, 400);
  if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(sample)) return 'cjk';
  if (/[\u0600-\u06FF]/.test(sample)) return 'arabic';
  if (/[\u0900-\u097F]/.test(sample)) return 'devanagari';
  if (/[\u0400-\u04FF]/.test(sample)) return 'cyrillic';
  if (/[A-Za-z]/.test(sample)) return 'latin';
  return 'unknown';
}

/**
 * Split on double-newline-ish boundaries, preserving original char spans.
 */
function splitParagraphs(text: string, script: Script): RawParagraph[] {
  const out: RawParagraph[] = [];
  let ix = 0;
  let cursor = 0;
  // Reset lastIndex — this regex carries `g` flag and is shared module-scope.
  PARA_SPLIT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARA_SPLIT_RE.exec(text)) !== null) {
    const chunk = text.slice(cursor, m.index);
    const trimmed = chunk.trim();
    if (trimmed.length >= MIN_PARA_LEN) {
      const start = cursor + chunk.indexOf(trimmed);
      out.push({
        text: trimmed,
        para_ix: ix++,
        char_span: [start, start + trimmed.length],
        script,
      });
    }
    cursor = m.index + m[0].length;
  }
  // Trailing paragraph after the final split.
  const tail = text.slice(cursor);
  const trimmedTail = tail.trim();
  if (trimmedTail.length >= MIN_PARA_LEN) {
    const start = cursor + tail.indexOf(trimmedTail);
    out.push({
      text: trimmedTail,
      para_ix: ix++,
      char_span: [start, start + trimmedTail.length],
      script,
    });
  }
  // Single-paragraph docs — PARA_SPLIT_RE never matched. Emit one paragraph.
  if (out.length === 0 && text.trim().length >= MIN_PARA_LEN) {
    const trimmed = text.trim();
    const start = text.indexOf(trimmed);
    out.push({
      text: trimmed,
      para_ix: 0,
      char_span: [start, start + trimmed.length],
      script,
    });
  }
  return out;
}

/**
 * Split one paragraph into sentences. Char spans are resolved against the
 * *original full document text* via the paragraph's span offset so that every
 * tier lives in the same coordinate space (callers just use `char_span`).
 */
function splitSentences(
  paragraph: RawParagraph,
  startingSentIx: number,
): RawSentence[] {
  const paraText = paragraph.text;
  const paraStart = paragraph.char_span[0];
  const out: RawSentence[] = [];
  let ix = startingSentIx;
  SENT_SPLIT_RE.lastIndex = 0;
  let cursor = 0;
  let m: RegExpExecArray | null;
  const rawSegments: string[] = [];
  while ((m = SENT_SPLIT_RE.exec(paraText)) !== null) {
    rawSegments.push(paraText.slice(cursor, m.index + 1));
    // +1 to include the terminal punctuation (regex lookbehind keeps it in
    // the preceding sentence).
    cursor = m.index + m[0].length;
  }
  rawSegments.push(paraText.slice(cursor));

  let walk = 0;
  for (const raw of rawSegments) {
    const trimmed = raw.trim();
    const localStart = paraText.indexOf(trimmed, walk);
    const effectiveStart = localStart >= 0 ? localStart : walk;
    walk = effectiveStart + Math.max(trimmed.length, raw.length);
    if (trimmed.length < MIN_SENT_LEN) continue;
    out.push({
      text: trimmed,
      sent_ix: ix++,
      para_ix: paragraph.para_ix,
      char_span: [
        paraStart + effectiveStart,
        paraStart + effectiveStart + trimmed.length,
      ],
      script: paragraph.script,
    });
  }
  // Guard: a paragraph with no terminal punctuation collapses to one sentence.
  if (out.length === 0 && paraText.trim().length >= MIN_SENT_LEN) {
    const trimmed = paraText.trim();
    const localStart = paraText.indexOf(trimmed);
    out.push({
      text: trimmed,
      sent_ix: ix++,
      para_ix: paragraph.para_ix,
      char_span: [paraStart + localStart, paraStart + localStart + trimmed.length],
      script: paragraph.script,
    });
  }
  return out;
}

/**
 * Find which sentence / paragraph a clause's char_span falls inside.
 * Both arrays are sorted by start offset, so this is a linear two-pointer
 * walk across clauses. We anchor the clause to the containing sentence (or
 * its paragraph if no sentence contains it — possible for clauses split by
 * the clause extractor on semicolons that live inside one sentence).
 */
function linkClausesToParents(
  clauses: RawClause[],
  sentences: RawSentence[],
  paragraphs: RawParagraph[],
): LinkedClause[] {
  const out: LinkedClause[] = [];
  let sentPtr = 0;
  let paraPtr = 0;
  for (const c of clauses) {
    const [cs] = c.char_span;
    // Advance sentPtr past sentences that end before the clause starts.
    while (
      sentPtr < sentences.length &&
      sentences[sentPtr].char_span[1] <= cs
    ) {
      sentPtr++;
    }
    const sent =
      sentPtr < sentences.length &&
      sentences[sentPtr].char_span[0] <= cs &&
      sentences[sentPtr].char_span[1] >= cs
        ? sentences[sentPtr]
        : null;
    while (
      paraPtr < paragraphs.length &&
      paragraphs[paraPtr].char_span[1] <= cs
    ) {
      paraPtr++;
    }
    const para =
      paraPtr < paragraphs.length &&
      paragraphs[paraPtr].char_span[0] <= cs &&
      paragraphs[paraPtr].char_span[1] >= cs
        ? paragraphs[paraPtr]
        : null;
    out.push({
      ...c,
      sent_ix: sent?.sent_ix ?? -1,
      para_ix: para?.para_ix ?? sent?.para_ix ?? -1,
    });
  }
  return out;
}

/**
 * Extract the document (via clause-extractor) then derive paragraph and
 * sentence tiers from its raw_text field. Clauses are linked to their
 * parent sentence and paragraph indices for lattice navigation.
 */
export async function segmentDocument(file: File): Promise<SegmentedDocument> {
  const base = await extractClauses(file);
  return segmentFromExtracted(base);
}

/**
 * For callers that already have an ExtractedDocument — derive the tiers
 * without re-reading the file.
 */
export function segmentFromExtracted(
  base: ExtractedDocument,
): SegmentedDocument {
  const text = base.raw_text;
  const script = detectScript(text);
  const paragraphs = splitParagraphs(text, script);
  const sentences: RawSentence[] = [];
  for (const p of paragraphs) {
    const part = splitSentences(p, sentences.length);
    sentences.push(...part);
  }
  // `text` kept in scope so splitParagraphs has the coordinate; not needed
  // for sentences, whose spans are resolved within each paragraph.
  void text;
  const linkedClauses = linkClausesToParents(
    base.clauses,
    sentences,
    paragraphs,
  );
  return {
    ...base,
    paragraphs,
    sentences,
    linkedClauses,
  };
}
