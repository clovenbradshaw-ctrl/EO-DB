/**
 * Document Explorer — query a single ingested document across three
 * lattice positions (paragraph / sentence / clause).
 *
 * Resolution isn't a UI filter. It's a position in S, and γ determines
 * what's visible from that position. Dragging the slider physically
 * contracts the highlighted regions in the document pane — paragraph
 * amber blocks → amber sentences → tight amber clauses. Where the
 * paragraph-level match and the clause-level match fall in the same
 * region but disagree on cell_id, that's a structural-divergence
 * signal worth surfacing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../theme';
import { OP_COLORS } from './LogView';
import type { SegmentedDocument } from '../nl/segment';
import { segmentFromExtracted } from '../nl/segment';
import type { ExtractedDocument } from '../nl/clause-extractor';
import {
  runQuery,
  annotateParents,
  type QueryHit,
  type QueryMode,
} from '../nl/query';
import type { ResolutionTier } from '../nl/eo-classifier';

const DEBOUNCE_MS = 250;
const OPERATORS: string[] = ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];

interface DocumentExplorerProps {
  /** The document currently loaded in the upload pane. Explorer is a child view. */
  doc: ExtractedDocument | null;
}

export function DocumentExplorer({ doc }: DocumentExplorerProps) {
  const { theme } = useTheme();
  const [query, setQuery] = useState('');
  const [resolution, setResolution] = useState<ResolutionTier>('paragraph');
  const [mode, setMode] = useState<QueryMode>('semantic');
  const [operatorFilter, setOperatorFilter] = useState<string>('');
  const [hits, setHits] = useState<QueryHit[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(0);

  // Derive the SegmentedDocument once per doc — paragraph + sentence tiers
  // are a pure function of the raw text + clause list.
  const segmented: SegmentedDocument | null = useMemo(
    () => (doc ? segmentFromExtracted(doc) : null),
    [doc],
  );

  // Debounced query + resolution change → re-run.
  useEffect(() => {
    if (!segmented || !query.trim()) {
      setHits([]);
      return;
    }
    const myId = ++runIdRef.current;
    const t = window.setTimeout(async () => {
      setRunning(true);
      setError(null);
      try {
        const effectiveMode: QueryMode =
          mode === 'operator_targeted' && !operatorFilter ? 'semantic' : mode;
        const resp = await runQuery({
          doc: segmented,
          query_text: query.trim(),
          resolution,
          mode: effectiveMode,
          operator_filter: operatorFilter || undefined,
        });
        if (myId !== runIdRef.current) return;
        if (resp.not_implemented) {
          setError(resp.not_implemented);
          setHits([]);
          return;
        }
        // For sub-paragraph tiers, enrich with parent cell for divergence UI.
        const annotated =
          resolution === 'paragraph'
            ? resp.hits
            : await annotateParents(resp.hits, segmented);
        if (myId !== runIdRef.current) return;
        setHits(annotated);
      } catch (err) {
        if (myId !== runIdRef.current) return;
        setError((err as Error).message);
        setHits([]);
      } finally {
        if (myId === runIdRef.current) setRunning(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, resolution, mode, operatorFilter, segmented]);

  if (!doc || !segmented) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: theme.textMuted,
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          padding: 24,
          textAlign: 'center',
        }}
      >
        Upload and ingest a document to explore it across paragraph, sentence,
        and clause resolution.
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        height: '100%',
        overflow: 'hidden',
        background: theme.bg,
        color: theme.text,
      }}
    >
      {/* Top control bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          padding: 12,
          borderBottom: `1px solid ${theme.border}`,
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="Ask the document (e.g. 'authorization chain')"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            minWidth: 260,
            padding: '6px 10px',
            fontSize: 13,
            fontFamily: "'JetBrains Mono', monospace",
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
            background: theme.bgMuted,
            color: theme.text,
          }}
        />

        <ResolutionSlider value={resolution} onChange={setResolution} theme={theme} />

        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as QueryMode)}
          style={selectStyle(theme)}
          title="Query mode"
        >
          <option value="semantic">semantic</option>
          <option value="operator_targeted">operator-targeted</option>
          <option value="contrastive" disabled>
            contrastive (soon)
          </option>
        </select>

        <select
          value={operatorFilter}
          onChange={(e) => setOperatorFilter(e.target.value)}
          style={{
            ...selectStyle(theme),
            opacity: mode === 'operator_targeted' ? 1 : 0.5,
          }}
          disabled={mode !== 'operator_targeted'}
          title="Operator lens"
        >
          <option value="">any operator</option>
          {OPERATORS.map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>

        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: theme.textMuted,
            minWidth: 60,
            textAlign: 'right',
          }}
        >
          {running ? 'running…' : hits.length ? `${hits.length} hit${hits.length === 1 ? '' : 's'}` : ''}
        </div>
      </div>

      {/* Split pane: doc on left, result cards on right */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 1fr) minmax(280px, 420px)',
          overflow: 'hidden',
        }}
      >
        <DocumentPane doc={segmented} hits={hits} resolution={resolution} theme={theme} />
        <ResultsPane doc={segmented} hits={hits} resolution={resolution} theme={theme} error={error} />
      </div>
    </div>
  );
}

function selectStyle(theme: any): React.CSSProperties {
  return {
    padding: '5px 8px',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    background: theme.bgMuted,
    color: theme.text,
  };
}

function ResolutionSlider({
  value,
  onChange,
  theme,
}: {
  value: ResolutionTier;
  onChange: (v: ResolutionTier) => void;
  theme: any;
}) {
  const tiers: ResolutionTier[] = ['paragraph', 'sentence', 'clause'];
  return (
    <div style={{ display: 'flex', gap: 0, border: `1px solid ${theme.border}`, borderRadius: 4 }}>
      {tiers.map((t, i) => (
        <button
          key={t}
          onClick={() => onChange(t)}
          style={{
            padding: '5px 10px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            background: value === t ? theme.accent : theme.bgMuted,
            color: value === t ? theme.bg : theme.text,
            border: 'none',
            borderLeft: i === 0 ? 'none' : `1px solid ${theme.border}`,
            cursor: 'pointer',
            textTransform: 'lowercase',
          }}
          title={
            t === 'paragraph'
              ? 'What is this region about?'
              : t === 'sentence'
              ? 'What does this document assert?'
              : 'What functional unit changed what?'
          }
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/**
 * Render the full document text with <mark>-style overlays on hit spans.
 * Opacity of the highlight = similarity score.
 */
function DocumentPane({
  doc,
  hits,
  resolution,
  theme,
}: {
  doc: SegmentedDocument;
  hits: QueryHit[];
  resolution: ResolutionTier;
  theme: any;
}) {
  // Map each hit span to a color based on its operator. Sort descending
  // by span length so shorter (nested) spans render over longer ones.
  const segments = useMemo(() => renderSegments(doc.raw_text, hits), [doc.raw_text, hits]);
  void resolution; // resolution is already expressed in hit spans
  return (
    <div
      style={{
        padding: 20,
        overflow: 'auto',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        borderRight: `1px solid ${theme.border}`,
      }}
    >
      {segments.length === 0 ? (
        <span style={{ color: theme.textMuted }}>{doc.raw_text}</span>
      ) : (
        segments.map((seg, i) => {
          if (!seg.hit) {
            return (
              <span key={i} style={{ color: theme.text }}>
                {seg.text}
              </span>
            );
          }
          const color = seg.hit.operator ? OP_COLORS[seg.hit.operator] : null;
          const alpha = Math.max(0.15, Math.min(1, seg.hit.similarity));
          return (
            <span
              key={i}
              title={`${seg.hit.cell_id ?? '?'} · sim ${seg.hit.similarity.toFixed(3)}`}
              style={{
                background: color
                  ? hexToRgba(color.border, alpha * 0.35)
                  : hexToRgba('#F59E0B', alpha * 0.35),
                color: theme.text,
                borderBottom: color ? `2px solid ${color.border}` : '2px solid #F59E0B',
                padding: '0 1px',
              }}
            >
              {seg.text}
            </span>
          );
        })
      )}
    </div>
  );
}

interface RenderSegment {
  text: string;
  hit?: QueryHit;
}

/**
 * Project a list of (char_span, hit) into non-overlapping segments covering
 * the full document. Overlapping hits at different resolutions are resolved
 * by picking the highest-similarity hit at each character.
 */
function renderSegments(fullText: string, hits: QueryHit[]): RenderSegment[] {
  if (hits.length === 0) {
    return [{ text: fullText }];
  }
  const n = fullText.length;
  const assignment: (QueryHit | undefined)[] = new Array(n);
  const scores: number[] = new Array(n).fill(-Infinity);
  for (const h of hits) {
    const [s, e] = h.char_span;
    if (s < 0 || e <= s || s >= n) continue;
    const end = Math.min(e, n);
    for (let i = s; i < end; i++) {
      if (h.similarity > scores[i]) {
        scores[i] = h.similarity;
        assignment[i] = h;
      }
    }
  }
  const out: RenderSegment[] = [];
  let cursor = 0;
  while (cursor < n) {
    const currentHit = assignment[cursor];
    let end = cursor + 1;
    while (end < n && assignment[end] === currentHit) end++;
    out.push({
      text: fullText.slice(cursor, end),
      hit: currentHit,
    });
    cursor = end;
  }
  return out;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

function ResultsPane({
  doc,
  hits,
  resolution,
  theme,
  error,
}: {
  doc: SegmentedDocument;
  hits: QueryHit[];
  resolution: ResolutionTier;
  theme: any;
  error: string | null;
}) {
  return (
    <div
      style={{
        overflow: 'auto',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {error && (
        <div
          style={{
            padding: 10,
            border: `1px solid ${theme.danger ?? '#F87171'}`,
            color: theme.danger ?? '#F87171',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            borderRadius: 4,
          }}
        >
          {error}
        </div>
      )}
      {hits.length === 0 && !error && (
        <div
          style={{
            fontSize: 11,
            color: theme.textMuted,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          Type a query above. Drag resolution to see the same question answered
          at different grains.
        </div>
      )}
      {hits.map((h) => (
        <ResultCard key={h.target} doc={doc} hit={h} resolution={resolution} theme={theme} />
      ))}
    </div>
  );
}

function ResultCard({
  doc,
  hit,
  resolution,
  theme,
}: {
  doc: SegmentedDocument;
  hit: QueryHit;
  resolution: ResolutionTier;
  theme: any;
}) {
  const color = hit.operator ? OP_COLORS[hit.operator] : null;
  // Divergence: paragraph top cell disagrees with this hit's top cell.
  const divergent =
    hit.parent_cell_id && hit.cell_id && hit.parent_cell_id !== hit.cell_id;

  // Presentation varies by tier. See plan §E.
  let body: JSX.Element;
  if (resolution === 'paragraph') {
    const preview = hit.text.length > 180 ? hit.text.slice(0, 180) + '…' : hit.text;
    body = (
      <div style={{ fontSize: 12, lineHeight: 1.5, color: theme.text }}>
        {preview}
      </div>
    );
  } else if (resolution === 'sentence') {
    body = (
      <div style={{ fontSize: 12, lineHeight: 1.5, color: theme.text }}>
        {hit.text}
      </div>
    );
  } else {
    // Clause in context: show containing sentence muted, clause bolded.
    const sentText = findContainingSentenceText(doc, hit.char_span);
    if (sentText) {
      const relStart = sentText.indexOf(hit.text);
      if (relStart >= 0) {
        body = (
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>
            <span style={{ color: theme.textMuted }}>{sentText.slice(0, relStart)}</span>
            <span style={{ color: theme.text, fontWeight: 600 }}>{hit.text}</span>
            <span style={{ color: theme.textMuted }}>
              {sentText.slice(relStart + hit.text.length)}
            </span>
          </div>
        );
      } else {
        body = (
          <div style={{ fontSize: 12, lineHeight: 1.5, color: theme.text }}>{hit.text}</div>
        );
      }
    } else {
      body = (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: theme.text }}>{hit.text}</div>
      );
    }
  }

  return (
    <div
      style={{
        padding: 10,
        border: `1px solid ${theme.border}`,
        borderRadius: 4,
        background: theme.bgMuted,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          color: theme.textMuted,
        }}
      >
        {hit.cell_id && (
          <span
            style={{
              padding: '1px 5px',
              borderRadius: 3,
              fontWeight: 700,
              color: color ? color.text : theme.text,
              background: color ? color.bg : 'transparent',
              border: color ? `1px solid ${color.border}40` : `1px solid ${theme.border}`,
            }}
          >
            {hit.cell_id}
          </span>
        )}
        <span>sim {hit.similarity.toFixed(3)}</span>
        {typeof hit.confidence_gap === 'number' && (
          <span>gap {hit.confidence_gap.toFixed(2)}</span>
        )}
        {divergent && (
          <span
            style={{
              padding: '1px 5px',
              border: `1px solid ${theme.danger ?? '#F87171'}`,
              color: theme.danger ?? '#F87171',
              borderRadius: 3,
              fontWeight: 700,
            }}
            title={`Paragraph top cell is ${hit.parent_cell_id} — the high-confidence ${resolution} inside disagrees.`}
          >
            ⟂ divergence
          </span>
        )}
      </div>
      {body}
    </div>
  );
}

function findContainingSentenceText(
  doc: SegmentedDocument,
  span: [number, number],
): string | null {
  const [s] = span;
  for (const sent of doc.sentences) {
    if (sent.char_span[0] <= s && sent.char_span[1] >= s) {
      return sent.text;
    }
  }
  return null;
}
