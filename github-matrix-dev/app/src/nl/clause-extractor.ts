/**
 * Extract clauses from an uploaded document.
 *
 * Supports: plain text, markdown, PDF (via lazy-loaded pdfjs), DOCX (via
 * lazy-loaded mammoth — dependency optional). Ported from
 * `/nl/natural_language.html`'s clause logic.
 *
 * A "clause" here is a sentence-ish span of text — split on strong
 * punctuation, semicolons, and line breaks, then trimmed. Classification
 * does not require perfect sentence boundaries; it only needs units short
 * enough that the embedding is dominated by a single semantic act.
 */

export interface RawClause {
  /** Text of the clause, trimmed. */
  text: string;
  /** 0-based index within the source document. */
  clause_ix: number;
  /** Character span in the source text. */
  char_span: [number, number];
  /** Detected script family — used to pick a confidence threshold. */
  script: 'latin' | 'cyrillic' | 'arabic' | 'devanagari' | 'cjk' | 'unknown';
}

export interface ExtractedDocument {
  /** Stable id (hash of the title + first 200 chars). */
  doc_id: string;
  /** User-supplied or inferred title. */
  title: string;
  /** MIME-ish source kind. */
  source: 'text' | 'markdown' | 'pdf' | 'docx';
  /** Total characters. */
  char_count: number;
  clauses: RawClause[];
}

const MIN_CLAUSE_LEN = 12;
const MAX_CLAUSE_LEN = 600;
const SPLIT_RE = /(?<=[.!?])\s+(?=[A-Z\u00C0-\u024F\u0400-\u04FF])|[;\n\r]+/;

function detectScript(text: string): RawClause['script'] {
  const sample = text.slice(0, 400);
  if (/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(sample)) return 'cjk';
  if (/[\u0600-\u06FF]/.test(sample)) return 'arabic';
  if (/[\u0900-\u097F]/.test(sample)) return 'devanagari';
  if (/[\u0400-\u04FF]/.test(sample)) return 'cyrillic';
  if (/[A-Za-z]/.test(sample)) return 'latin';
  return 'unknown';
}

function splitIntoClauses(text: string): RawClause[] {
  const script = detectScript(text);
  const clauses: RawClause[] = [];
  let cursor = 0;
  const parts = text.split(SPLIT_RE);
  let ix = 0;
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) {
      cursor += raw.length + 1;
      continue;
    }
    if (trimmed.length < MIN_CLAUSE_LEN) {
      cursor += raw.length + 1;
      continue;
    }
    const start = text.indexOf(trimmed, cursor);
    const safeStart = start >= 0 ? start : cursor;
    const end = safeStart + trimmed.length;
    if (trimmed.length > MAX_CLAUSE_LEN) {
      // Hard-split extra-long clauses at nearest space past the midpoint
      // instead of discarding them.
      let remaining = trimmed;
      let rStart = safeStart;
      while (remaining.length > MAX_CLAUSE_LEN) {
        const cut = remaining.lastIndexOf(' ', MAX_CLAUSE_LEN);
        const splitAt = cut > MAX_CLAUSE_LEN / 2 ? cut : MAX_CLAUSE_LEN;
        const head = remaining.slice(0, splitAt).trim();
        if (head.length >= MIN_CLAUSE_LEN) {
          clauses.push({
            text: head,
            clause_ix: ix++,
            char_span: [rStart, rStart + head.length],
            script,
          });
        }
        remaining = remaining.slice(splitAt).trim();
        rStart += splitAt;
      }
      if (remaining.length >= MIN_CLAUSE_LEN) {
        clauses.push({
          text: remaining,
          clause_ix: ix++,
          char_span: [rStart, rStart + remaining.length],
          script,
        });
      }
    } else {
      clauses.push({
        text: trimmed,
        clause_ix: ix++,
        char_span: [safeStart, end],
        script,
      });
    }
    cursor = end;
  }
  return clauses;
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function readPdf(file: File): Promise<string> {
  // pdfjs-dist is optional — added when the user wants PDF ingest. Fail
  // gracefully with a clear error rather than crashing the app. The
  // @vite-ignore comment plus variable indirection keeps TS from trying to
  // resolve the module at build time.
  const moduleName = 'pdfjs-dist';
  let pdfjs: any;
  try {
    pdfjs = await import(/* @vite-ignore */ moduleName);
  } catch {
    throw new Error(
      'PDF support requires pdfjs-dist. Install with: npm i pdfjs-dist',
    );
  }
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const chunks: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items.map((it: any) => ('str' in it ? it.str : '')).join(' ');
    chunks.push(line);
  }
  return chunks.join('\n\n');
}

async function readDocx(file: File): Promise<string> {
  const moduleName = 'mammoth';
  let mammoth: any;
  try {
    mammoth = await import(/* @vite-ignore */ moduleName);
  } catch {
    throw new Error(
      'DOCX support requires mammoth. Install with: npm i mammoth',
    );
  }
  const buf = await file.arrayBuffer();
  const { value } = await mammoth.extractRawText({ arrayBuffer: buf });
  return String(value ?? '');
}

function hash32(s: string): string {
  // Non-cryptographic 32-bit FNV-1a — enough to disambiguate docs in a UI.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Main entry: decide how to parse the file, extract raw text, split into
 * clauses, return a document summary.
 */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  const name = file.name;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  let text = '';
  let source: ExtractedDocument['source'] = 'text';
  if (ext === 'pdf') {
    text = await readPdf(file);
    source = 'pdf';
  } else if (ext === 'docx') {
    text = await readDocx(file);
    source = 'docx';
  } else if (ext === 'md' || ext === 'markdown') {
    text = await readFileAsText(file);
    source = 'markdown';
  } else {
    text = await readFileAsText(file);
    source = 'text';
  }
  const clauses = splitIntoClauses(text);
  const titleBase = name.replace(/\.[^.]+$/, '');
  const doc_id = `nl_doc:${hash32(titleBase + '|' + text.slice(0, 200))}`;
  return {
    doc_id,
    title: titleBase || 'Untitled',
    source,
    char_count: text.length,
    clauses,
  };
}
