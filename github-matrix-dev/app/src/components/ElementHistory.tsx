import { useEffect, useState } from 'react';
import { useEoStore } from '../store/eo-store';
import { readLogForTarget } from '../db/log';
import { useTheme, type Theme } from '../theme';
import type { EoEvent } from '../db/types';

const OP_COLORS: Record<string, { bg: string; text: string }> = {
  INS: { bg: '#EAF3DE', text: '#3B6D11' },
  DEF: { bg: '#FAEEDA', text: '#854F0B' },
  CON: { bg: '#E6F1FB', text: '#185FA5' },
  SEG: { bg: '#FFF3E0', text: '#E65100' },
  SYN: { bg: '#FCE4EC', text: '#C62828' },
  EVA: { bg: '#FAEEDA', text: '#854F0B' },
  NUL: { bg: '#F0F0F0', text: '#888' },
  REC: { bg: '#FCEBEB', text: '#A32D2D' },
};

interface ElementHistoryProps {
  target: string;
  onRevert?: (event: EoEvent) => void;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getAgentName(agent: string): string {
  if (agent === 'system' || agent === 'system:eva') return 'system';
  if (agent.startsWith('@')) return agent.slice(1).split(':')[0];
  return agent;
}

/** Short ID from a target path: "import.cases.CASE-001" -> "CASE-001" */
function shortTarget(target: string): string {
  return target.split('.').pop() || target;
}

function summarizeOperand(op: string, operand: any): string {
  if (!operand) return '';
  if (op === 'INS') {
    const keys = Object.keys(operand).filter(k => !k.startsWith('_'));
    if (keys.length === 0) return 'created';
    return `created with ${keys.join(', ')}`;
  }
  if (op === 'DEF') {
    const keys = Object.keys(operand).filter(k => !k.startsWith('_'));
    if (keys.length === 0) return 'updated';
    // Show which fields changed and the new values
    const parts = keys.map(k => {
      const v = operand[k];
      const display = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k} updated`;
    });
    return parts.join(', ');
  }
  if (op === 'CON') {
    const added = operand.added || [];
    const removed = operand.removed || [];
    const parts: string[] = [];
    if (added.length > 0) {
      const names = added.map((t: string) => shortTarget(t));
      parts.push(`linked to ${names.join(', ')}`);
    }
    if (removed.length > 0) {
      const names = removed.map((t: string) => shortTarget(t));
      parts.push(`unlinked ${names.join(', ')}`);
    }
    if (operand.edge_type) parts.push(`(${operand.edge_type})`);
    if (parts.length === 0 && added.length > 0) {
      return `linked ${added.length} target${added.length !== 1 ? 's' : ''}`;
    }
    return parts.join(' ') || 'connection changed';
  }
  if (op === 'SEG') {
    return `${operand.boundary || 'boundary'}${operand.reason ? `: ${operand.reason}` : ''}`;
  }
  if (op === 'SYN') return 'merged';
  if (op === 'EVA') return operand.strategy || 'evaluated';
  return '';
}

/** Render before/after diff for DEF operand changes */
function renderDefDiff(operand: any, theme: any): React.ReactNode {
  if (!operand || typeof operand !== 'object') return null;
  const keys = Object.keys(operand).filter(k => !k.startsWith('_'));
  if (keys.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
      {keys.map(k => {
        const newVal = operand[k];
        const display = typeof newVal === 'string' ? newVal : JSON.stringify(newVal);
        const meta = operand._prev?.[k];
        const oldDisplay = meta !== undefined
          ? (typeof meta === 'string' ? meta : JSON.stringify(meta))
          : null;
        return (
          <div key={k} style={{
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap' as const,
          }}>
            <span style={{ color: theme.textMuted, minWidth: 60 }}>{k}</span>
            {oldDisplay !== null && (
              <>
                <span style={{
                  color: theme.danger,
                  textDecoration: 'line-through',
                  opacity: 0.7,
                }}>{oldDisplay}</span>
                <span style={{ color: theme.textMuted }}>{'\u2192'}</span>
              </>
            )}
            <span style={{ color: theme.success }}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Reconstruct current value for each field by scanning events newest-first */
function getCurrentValues(events: EoEvent[], fields: string[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const field of fields) {
    for (const evt of events) {
      if (evt.operand && typeof evt.operand === 'object' && field in (evt.operand as object)) {
        result[field] = (evt.operand as Record<string, any>)[field];
        break;
      }
    }
  }
  return result;
}

interface RevertConfirmProps {
  event: EoEvent;
  events: EoEvent[];
  theme: any;
  s: Record<string, React.CSSProperties>;
  onConfirm: () => void;
  onCancel: () => void;
}

function RevertConfirm({ event, events, theme, s, onConfirm, onCancel }: RevertConfirmProps) {
  const isRevertOfRevert = !!(event.meta as any)?.reverted_from_seq;
  const affectedFields = event.operand && typeof event.operand === 'object'
    ? Object.keys(event.operand).filter(k => !k.startsWith('_'))
    : [];
  const currentValues = getCurrentValues(events, affectedFields);
  const changedFields = affectedFields.filter(f =>
    JSON.stringify(currentValues[f]) !== JSON.stringify((event.operand as Record<string, any>)[f])
  );
  const noChange = affectedFields.length > 0 && changedFields.length === 0;

  return (
    <div style={{
      marginTop: 8,
      padding: '10px 12px',
      background: theme.warningBg || '#FFF8E1',
      border: `1px solid ${theme.warningBorder || '#F9A825'}`,
      borderRadius: 6,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ fontWeight: 600, color: theme.warning || '#854F0B', marginBottom: 6 }}>
        Confirm revert
      </div>
      {noChange ? (
        <div style={{ color: theme.textMuted || '#888', marginBottom: 8, lineHeight: 1.5 }}>
          No change — current values already match this snapshot.
        </div>
      ) : (
        <>
          <div style={{ color: theme.textSecondary || '#555', marginBottom: 6, lineHeight: 1.5 }}>
            {isRevertOfRevert
              ? 'This event is itself a revert. Applying it adds a new change on top — previous history is preserved.'
              : 'This adds a new event restoring the values from this snapshot. Previous history is preserved.'}
          </div>
          {changedFields.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <span style={{ color: theme.textMuted }}>Fields affected: </span>
              <span style={{ color: theme.text || '#333' }}>{changedFields.join(', ')}</span>
            </div>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        {!noChange && (
          <button
            style={{ ...s.revertBtn, background: theme.warning || '#854F0B', color: '#fff', border: 'none' }}
            onClick={(e) => { e.stopPropagation(); onConfirm(); }}
          >
            Confirm revert
          </button>
        )}
        <button
          style={{ ...s.revertBtn, background: 'transparent', color: theme.textMuted }}
          onClick={(e) => { e.stopPropagation(); onCancel(); }}
        >
          {noChange ? 'Dismiss' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

export function ElementHistory({ target, onRevert }: ElementHistoryProps) {
  const store = useEoStore((s) => s.store);
  const dispatch = useEoStore((s) => s.dispatch);
  const [events, setEvents] = useState<EoEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [reverting, setReverting] = useState<number | null>(null);
  const [pendingRevert, setPendingRevert] = useState<EoEvent | null>(null);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  useEffect(() => {
    if (!store) return;
    setLoading(true);
    readLogForTarget(store, target).then((evts) => {
      setEvents(evts.reverse()); // newest first
      setLoading(false);
    });
  }, [store, target]);

  function handleRevert(event: EoEvent) {
    if (onRevert) {
      onRevert(event);
      return;
    }
    setPendingRevert(event);
  }

  async function confirmRevert(event: EoEvent) {
    setPendingRevert(null);
    setReverting(event.seq);
    try {
      await dispatch({
        op: 'DEF',
        target,
        operand: event.operand,
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        meta: { reverted_from_seq: event.seq },
      });
      // Refresh history
      if (store) {
        const evts = await readLogForTarget(store, target);
        setEvents(evts.reverse());
      }
    } finally {
      setReverting(null);
    }
  }

  if (loading) {
    return <div style={s.empty}>Loading history...</div>;
  }

  if (events.length === 0) {
    return <div style={s.empty}>No history for this target</div>;
  }

  return (
    <div style={s.container}>
      <div style={s.timeline}>
        {events.map((event, i) => {
          const colors = OP_COLORS[event.op] || OP_COLORS.NUL;
          const isExpanded = expandedSeq === event.seq;
          const isFirst = i === 0;
          const canRevert = !isFirst && (event.op === 'DEF' || event.op === 'INS');

          return (
            <div key={event.seq} style={s.entry}>
              {/* Timeline connector */}
              <div style={s.timelineTrack}>
                <div style={{
                  ...s.dot,
                  background: colors.bg,
                  border: `2px solid ${colors.text}`,
                }} />
                {i < events.length - 1 && <div style={s.line} />}
              </div>

              {/* Content */}
              <div style={s.entryContent}>
                <div
                  style={s.entryHeader}
                  onClick={() => setExpandedSeq(isExpanded ? null : event.seq)}
                >
                  <div style={s.entryTop}>
                    <span style={{
                      ...s.opBadge,
                      background: colors.bg,
                      color: colors.text,
                    }}>
                      {event.op}
                    </span>
                    <span style={s.summary}>{summarizeOperand(event.op, event.operand)}</span>
                    <span style={s.timeLabel}>{formatTime(event.ts)}</span>
                  </div>
                  {/* Before/after for DEF changes — shown inline */}
                  {event.op === 'DEF' && renderDefDiff(event.operand, theme)}
                  {/* CON detail — show linked targets */}
                  {event.op === 'CON' && event.operand?.added && (
                    <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
                      {(event.operand.added as string[]).map((t: string) => shortTarget(t)).join(', ')}
                    </div>
                  )}
                  <div style={s.entryMeta}>
                    <span>{getAgentName(event.agent)}</span>
                    {canRevert && (
                      <>
                        <span style={s.metaSep}>·</span>
                        <span
                          role="button"
                          tabIndex={0}
                          style={s.revertLink}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (pendingRevert?.seq === event.seq) {
                              setPendingRevert(null);
                            } else {
                              handleRevert(event);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.stopPropagation();
                              if (pendingRevert?.seq === event.seq) {
                                setPendingRevert(null);
                              } else {
                                handleRevert(event);
                              }
                            }
                          }}
                        >
                          {reverting === event.seq ? 'reverting...' : pendingRevert?.seq === event.seq ? 'cancel' : 'revert'}
                        </span>
                      </>
                    )}
                  </div>
                  {/* Inline revert confirmation */}
                  {pendingRevert?.seq === event.seq && (
                    <RevertConfirm
                      event={event}
                      events={events}
                      theme={theme}
                      s={s}
                      onConfirm={() => confirmRevert(event)}
                      onCancel={() => setPendingRevert(null)}
                    />
                  )}
                </div>

                {/* Expanded detail — raw operand JSON */}
                {isExpanded && (
                  <div style={s.detail}>
                    <pre style={s.operandPre}>
                      {JSON.stringify(event.operand, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      padding: '8px 0',
    },
    empty: {
      padding: '16px 0',
      fontSize: 12,
      color: t.textMuted,
      textAlign: 'center',
    },
    timeline: {
      display: 'flex',
      flexDirection: 'column',
    },
    entry: {
      display: 'flex',
      gap: 12,
      minHeight: 40,
    },
    timelineTrack: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      width: 16,
      flexShrink: 0,
    },
    dot: {
      width: 12,
      height: 12,
      borderRadius: '50%',
      flexShrink: 0,
      marginTop: 4,
    },
    line: {
      width: 2,
      flex: 1,
      background: t.border,
      marginTop: 4,
    },
    entryContent: {
      flex: 1,
      paddingBottom: 12,
      minWidth: 0,
    },
    entryHeader: {
      cursor: 'pointer',
    },
    entryTop: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap' as const,
    },
    opBadge: {
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 3,
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
    },
    summary: {
      fontSize: 12,
      color: t.text,
    },
    timeLabel: {
      fontSize: 10,
      color: t.textMuted,
      marginLeft: 'auto',
      fontFamily: "'JetBrains Mono', monospace",
      flexShrink: 0,
    },
    entryMeta: {
      fontSize: 10,
      color: t.textMuted,
      marginTop: 4,
      fontFamily: "'JetBrains Mono', monospace",
    },
    metaSep: {
      margin: '0 4px',
      color: t.border,
    },
    seqLabel: {
      color: t.textMuted,
    },
    detail: {
      marginTop: 8,
      padding: 10,
      background: t.bgMuted,
      borderRadius: 6,
      border: `1px solid ${t.border}`,
    },
    operandPre: {
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      margin: 0,
      whiteSpace: 'pre-wrap' as const,
      wordBreak: 'break-all' as const,
      overflowWrap: 'break-word' as const,
      lineHeight: 1.5,
      maxHeight: 200,
      overflow: 'auto',
    },
    revertLink: {
      color: t.warning,
      cursor: 'pointer',
      fontWeight: 500,
    },
    revertBtn: {
      marginTop: 8,
      padding: '5px 12px',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.warningBorder}`,
      borderRadius: 4,
      background: t.warningBg,
      color: t.warning,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
    },
  };
}
