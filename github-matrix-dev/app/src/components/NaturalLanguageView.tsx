/**
 * Document explorer — upload a document, watch its clauses classify against
 * the 27 EO cells, correct individual classifications (cascades via REC),
 * inspect links to neighboring clauses through the brain database.
 *
 * Feature-gated by useNLPrefs().enabled; mounted from Layout's view switch.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTheme } from '../theme';
import { OP_COLORS } from './LogView';
import { EOCellPicker } from './EOCellPicker';
import { cellById } from '../nl/eo-cells';
import {
  extractDocument,
  type ExtractedDocument,
  type RawClause,
} from '../nl/clause-extractor';
import {
  ingestDocument,
  recordCorrection,
  type IngestProgress,
} from '../nl/ingest-queue';
import {
  initClassifier,
  subscribeClassifierStatus,
  getClassifierStatus,
  type ClassifierStatus,
  type Classification,
} from '../nl/eo-classifier';
import {
  subscribeSpoExtractorStatus,
  getSpoExtractorStatus,
  type SpoExtractorStatus,
  type ExtractedTriple,
} from '../nl/spo-extractor';
import { useNLPrefs } from '../lib/nl-prefs';
import { DocumentExplorer } from './DocumentExplorer';

interface NaturalLanguageViewProps {
  userId: string;
}

type ViewMode = 'upload' | 'explore';

export function NaturalLanguageView({ userId }: NaturalLanguageViewProps) {
  const { theme } = useTheme();
  const [prefs] = useNLPrefs();
  const [viewMode, setViewMode] = useState<ViewMode>('upload');
  const [doc, setDoc] = useState<ExtractedDocument | null>(null);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [status, setStatus] = useState<ClassifierStatus>(getClassifierStatus);
  const [spoStatus, setSpoStatus] = useState<SpoExtractorStatus>(getSpoExtractorStatus);
  const [selectedIx, setSelectedIx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Status subscription.
  useEffect(() => subscribeClassifierStatus(setStatus), []);
  useEffect(() => subscribeSpoExtractorStatus(setSpoStatus), []);

  // Prewarm classifier the moment this view mounts so the model download
  // happens before the user picks a file.
  useEffect(() => {
    if (prefs.enabled) void initClassifier();
  }, [prefs.enabled]);

  const classificationsByIx = progress?.classificationsByIx ?? {};
  const triplesByIx = progress?.triplesByIx ?? {};
  const tripleClassifications = progress?.tripleClassifications ?? {};
  const clauses: RawClause[] = doc?.clauses ?? [];

  const virtualizer = useVirtualizer({
    count: clauses.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 16,
  });

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setSelectedIx(null);
      setProgress(null);
      try {
        const extracted = await extractDocument(file);
        setDoc(extracted);
        if (!prefs.autoClassifyOnUpload) return;
        setIsIngesting(true);
        try {
          await ingestDocument(extracted, userId, (p) => {
            setProgress({ ...p, classificationsByIx: { ...p.classificationsByIx } });
          });
        } finally {
          setIsIngesting(false);
        }
      } catch (err) {
        setError((err as Error).message);
        setIsIngesting(false);
      }
    },
    [prefs.autoClassifyOnUpload, userId],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile],
  );

  const selectedClause = selectedIx !== null ? clauses[selectedIx] : null;
  const selectedClassification =
    selectedIx !== null ? classificationsByIx[selectedIx] : undefined;
  const selectedTriples: ExtractedTriple[] =
    selectedIx !== null ? triplesByIx[selectedIx] ?? [] : [];

  const handleCorrect = useCallback(
    async (toCellId: string) => {
      if (!selectedClause || !selectedClassification || !doc) return;
      await recordCorrection({
        doc_id: doc.doc_id,
        clause_ix: selectedClause.clause_ix,
        from_cell_id: selectedClassification.cell_id,
        to_cell_id: toCellId,
        text: selectedClause.text,
        agent: userId,
      });
      // Reflect the correction locally by overwriting the top cell.
      if (progress) {
        const overwritten: Classification = {
          ...selectedClassification,
          cell_id: toCellId,
          cell_key: cellById(toCellId)?.cell_key ?? selectedClassification.cell_key,
          operator: cellById(toCellId)?.operator ?? selectedClassification.operator,
          flags: [...selectedClassification.flags, 'user_corrected'],
        };
        setProgress({
          ...progress,
          classificationsByIx: {
            ...progress.classificationsByIx,
            [selectedClause.clause_ix]: overwritten,
          },
        });
      }
    },
    [doc, progress, selectedClassification, selectedClause, userId],
  );

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  const modeToggle = (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.border}`,
        alignItems: 'center',
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: theme.textMuted,
          marginRight: 8,
        }}
      >
        NL
      </div>
      {(['upload', 'explore'] as ViewMode[]).map((m) => (
        <button
          key={m}
          onClick={() => setViewMode(m)}
          style={{
            padding: '4px 12px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            background: viewMode === m ? theme.accent : theme.bgMuted,
            color: viewMode === m ? theme.bg : theme.text,
            border: `1px solid ${theme.border}`,
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          {m}
        </button>
      ))}
      {doc && (
        <div
          style={{
            marginLeft: 'auto',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: theme.textMuted,
          }}
        >
          {doc.title} · {doc.clauses.length} clauses
        </div>
      )}
    </div>
  );

  if (viewMode === 'explore') {
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
        {modeToggle}
        <DocumentExplorer doc={doc} />
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        gridTemplateColumns: '100%',
        height: '100%',
        overflow: 'hidden',
        background: theme.bg,
        color: theme.text,
      }}
    >
      {modeToggle}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(260px, 320px) 1fr minmax(320px, 420px)',
          overflow: 'hidden',
        }}
      >
      {/* ── Left: upload + status ─────────────────────────────────────── */}
      <aside
        style={{
          borderRight: `1px solid ${theme.border}`,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflow: 'auto',
        }}
      >
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: theme.textMuted,
          }}
        >
          Natural Language
        </div>

        <div
          onDrop={onDrop}
          onDragOver={(e) => e.preventDefault()}
          style={{
            border: `1.5px dashed ${theme.border}`,
            borderRadius: 6,
            padding: 16,
            textAlign: 'center',
            background: theme.bgMuted,
            cursor: 'pointer',
          }}
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.txt,.md,.markdown,.pdf,.docx';
            input.onchange = () => {
              const f = input.files?.[0];
              if (f) void handleFile(f);
            };
            input.click();
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
            Drop a document
          </div>
          <div style={{ fontSize: 10, color: theme.textMuted }}>
            .txt · .md · .pdf · .docx
          </div>
        </div>

        <StatusPanel status={status} theme={theme} />
        <SpoStatusPanel status={spoStatus} theme={theme} />

        {doc && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
            }}
          >
            <div style={{ color: theme.textMuted }}>DOC</div>
            <div style={{ color: theme.text, fontWeight: 600 }}>{doc.title}</div>
            <div style={{ color: theme.textMuted }}>
              {doc.clauses.length} clauses · {doc.char_count.toLocaleString()} chars
            </div>
          </div>
        )}

        {isIngesting && progress && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: theme.textMuted,
              }}
            >
              {progress.phase.toUpperCase()} · {progress.processed}/{progress.total}
            </div>
            <div
              style={{
                height: 4,
                background: theme.bgActive,
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${progressPct}%`,
                  height: '100%',
                  background: theme.accent,
                  transition: 'width 0.2s',
                }}
              />
            </div>
          </div>
        )}

        {error && (
          <div
            style={{
              fontSize: 11,
              color: theme.danger,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {error}
          </div>
        )}
      </aside>

      {/* ── Center: clause list ──────────────────────────────────────── */}
      <main
        ref={parentRef}
        style={{
          overflow: 'auto',
          padding: '0 0 40px',
        }}
      >
        {clauses.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: theme.textMuted,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
          >
            Drop a document to begin.
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const c = clauses[vi.index];
              const cls = classificationsByIx[c.clause_ix];
              const color = cls ? OP_COLORS[cls.operator] : null;
              const isSelected = selectedIx === c.clause_ix;
              const tripleCount = (triplesByIx[c.clause_ix] ?? []).length;
              return (
                <div
                  key={vi.key}
                  onClick={() => setSelectedIx(c.clause_ix)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                    padding: '10px 16px',
                    borderBottom: `1px solid ${theme.borderLight}`,
                    background: isSelected ? theme.bgActive : 'transparent',
                    cursor: 'pointer',
                    display: 'grid',
                    gridTemplateColumns: '80px 1fr 80px',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: color ? color.text : theme.textMuted,
                      background: color ? color.bg : 'transparent',
                      border: color ? `1px solid ${color.border}40` : `1px solid ${theme.border}`,
                      borderRadius: 3,
                      padding: '2px 6px',
                      textAlign: 'center',
                      fontWeight: 700,
                    }}
                  >
                    {cls ? cls.operator : '···'}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.45,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.text}
                  </div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      color: theme.textMuted,
                      textAlign: 'right',
                    }}
                  >
                    {cls ? `gap ${cls.confidence_gap.toFixed(2)}` : ''}
                    {cls?.flags.includes('boundary') ? ' ⚑' : ''}
                    {tripleCount > 0 ? ` · ${tripleCount}△` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* ── Right: detail + correction ────────────────────────────── */}
      <aside
        style={{
          borderLeft: `1px solid ${theme.border}`,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          overflow: 'auto',
        }}
      >
        {!selectedClause && (
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              color: theme.textMuted,
            }}
          >
            Select a clause to inspect its classification.
          </div>
        )}
        {selectedClause && (
          <>
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                padding: 10,
                background: theme.bgMuted,
                borderRadius: 4,
                border: `1px solid ${theme.border}`,
              }}
            >
              {selectedClause.text}
            </div>
            {selectedClassification && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Label text="Top cell" theme={theme} />
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                  {selectedClassification.cell_key}
                </div>
                <Label text="Top-5 similarity" theme={theme} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {selectedClassification.similarity_profile.map((s) => (
                    <div
                      key={s.cell_id}
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        color: theme.textMuted,
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>{s.cell_id}</span>
                      <span>{s.score.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Label text="Correct to" theme={theme} />
              <EOCellPicker
                selected={selectedClassification?.cell_id}
                disabled={
                  selectedClassification ? [selectedClassification.cell_id] : []
                }
                onPick={(cell) => void handleCorrect(cell.cell_id)}
              />
            </div>

            <TriplesPanel
              triples={selectedTriples}
              classifications={tripleClassifications}
              spoStatus={spoStatus}
              theme={theme}
            />
          </>
        )}
      </aside>
      </div>
    </div>
  );
}

function SpoStatusPanel({
  status,
  theme,
}: {
  status: SpoExtractorStatus;
  theme: any;
}) {
  const color =
    status.state === 'ready'
      ? theme.success
      : status.state === 'error'
      ? theme.danger
      : theme.textMuted;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 8,
        borderRadius: 4,
        border: `1px solid ${theme.border}`,
        background: theme.bgMuted,
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: theme.textMuted,
        }}
      >
        SPO Extractor
      </div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color,
        }}
      >
        {status.state === 'ready'
          ? `ready (${status.backend})`
          : status.state === 'loading'
          ? status.message ?? 'loading…'
          : status.state === 'error'
          ? status.message ?? 'error'
          : status.state === 'disabled'
          ? 'disabled'
          : 'idle'}
      </div>
      {status.state === 'loading' && (
        <div
          style={{
            height: 3,
            background: theme.bgActive,
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.round(status.progress * 100)}%`,
              height: '100%',
              background: theme.accent,
              transition: 'width 0.2s',
            }}
          />
        </div>
      )}
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.textMuted,
        }}
      >
        REBEL · English-only
      </div>
    </div>
  );
}

function TriplesPanel({
  triples,
  classifications,
  spoStatus,
  theme,
}: {
  triples: ExtractedTriple[];
  classifications: Record<string, Classification>;
  spoStatus: SpoExtractorStatus;
  theme: any;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Label text="Triples (S → P → O)" theme={theme} />
      {triples.length === 0 ? (
        <div
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: theme.textMuted,
          }}
        >
          {spoStatus.state === 'ready'
            ? 'No triples extracted for this clause.'
            : spoStatus.state === 'loading'
            ? 'Waiting for SPO model…'
            : spoStatus.state === 'error'
            ? `SPO unavailable: ${spoStatus.message ?? 'error'}`
            : 'SPO extraction pending.'}
        </div>
      ) : (
        triples.map((t) => {
          const key = `${t.clause_ix}:${t.triple_ix}`;
          const cls = classifications[key];
          const predColor = cls ? OP_COLORS[cls.operator] : null;
          return (
            <div
              key={key}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: 6,
                borderRadius: 4,
                border: `1px solid ${theme.border}`,
                background: theme.bgMuted,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ color: theme.accent, fontWeight: 600 }}>
                  {t.subject}
                </span>
                <span style={{ color: theme.textMuted }}>→</span>
                <span
                  style={{
                    color: predColor ? predColor.text : theme.text,
                    background: predColor ? predColor.bg : 'transparent',
                    border: predColor
                      ? `1px solid ${predColor.border}40`
                      : `1px solid ${theme.border}`,
                    borderRadius: 3,
                    padding: '0 4px',
                    fontWeight: 600,
                  }}
                >
                  {t.predicate}
                </span>
                <span style={{ color: theme.textMuted }}>→</span>
                <span style={{ color: theme.accent, fontWeight: 600 }}>
                  {t.object}
                </span>
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9,
                  color: theme.textMuted,
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>
                  {cls ? cls.cell_id : 'predicate unclassified'}
                  {t.flags.length > 0 ? ` · ${t.flags.join(',')}` : ''}
                </span>
                <span>conf {t.confidence.toFixed(2)}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function StatusPanel({ status, theme }: { status: ClassifierStatus; theme: any }) {
  const color =
    status.state === 'ready'
      ? theme.success
      : status.state === 'error'
      ? theme.danger
      : theme.textMuted;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 8,
        borderRadius: 4,
        border: `1px solid ${theme.border}`,
        background: theme.bgMuted,
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: theme.textMuted,
        }}
      >
        Classifier
      </div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color,
        }}
      >
        {status.state === 'ready'
          ? `ready (${status.backend})`
          : status.state === 'loading'
          ? status.message ?? 'loading…'
          : status.state === 'error'
          ? status.message ?? 'error'
          : 'idle'}
      </div>
      {status.state === 'loading' && (
        <div
          style={{
            height: 3,
            background: theme.bgActive,
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.round(status.progress * 100)}%`,
              height: '100%',
              background: theme.accent,
              transition: 'width 0.2s',
            }}
          />
        </div>
      )}
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.textMuted,
        }}
      >
        {status.centroidCount}/27 cells
      </div>
    </div>
  );
}

function Label({ text, theme }: { text: string; theme: any }) {
  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: theme.textMuted,
      }}
    >
      {text}
    </div>
  );
}
