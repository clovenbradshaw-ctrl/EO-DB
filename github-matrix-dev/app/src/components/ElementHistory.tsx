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
    return `set ${keys.join(', ')}`;
  }
  if (op === 'CON') {
    const added = operand.added || [];
    return `linked ${added.length} target${added.length !== 1 ? 's' : ''}`;
  }
  if (op === 'SEG') {
    return `${operand.boundary || 'boundary'}${operand.reason ? `: ${operand.reason}` : ''}`;
  }
  if (op === 'SYN') return 'merged';
  if (op === 'EVA') return operand.strategy || 'evaluated';
  return '';
}

export function ElementHistory({ target, onRevert }: ElementHistoryProps) {
  const store = useEoStore((s) => s.store);
  const dispatch = useEoStore((s) => s.dispatch);
  const [events, setEvents] = useState<EoEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [reverting, setReverting] = useState<number | null>(null);
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

  async function handleRevert(event: EoEvent) {
    if (onRevert) {
      onRevert(event);
      return;
    }

    // Revert by dispatching a DEF with the event's operand
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
                    {isFirst && (
                      <span style={s.currentBadge}>current</span>
                    )}
                  </div>
                  <div style={s.entryMeta}>
                    <span>{getAgentName(event.agent)}</span>
                    <span style={s.metaSep}>·</span>
                    <span>{formatTime(event.ts)}</span>
                    <span style={s.metaSep}>·</span>
                    <span style={s.seqLabel}>#{event.seq}</span>
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div style={s.detail}>
                    <pre style={s.operandPre}>
                      {JSON.stringify(event.operand, null, 2)}
                    </pre>
                    {canRevert && (
                      <button
                        style={s.revertBtn}
                        onClick={() => handleRevert(event)}
                        disabled={reverting === event.seq}
                      >
                        {reverting === event.seq ? 'Reverting...' : 'Revert to this version'}
                      </button>
                    )}
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
    currentBadge: {
      fontSize: 9,
      fontWeight: 600,
      color: t.success,
      background: t.successBg,
      border: `1px solid ${t.successBorder}`,
      borderRadius: 8,
      padding: '1px 6px',
      fontFamily: "'JetBrains Mono', monospace",
    },
    entryMeta: {
      fontSize: 10,
      color: t.textMuted,
      marginTop: 2,
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
      lineHeight: 1.5,
      maxHeight: 200,
      overflowY: 'auto' as const,
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
