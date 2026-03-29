import { useState, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import type { EoEvent, LoggableOperator } from '../db/types';

// --- Operator colors (dark theme, rgba-based) ---
const OP_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  NUL: { bg: 'rgba(148,163,184,0.12)', text: '#94a3b8', border: 'rgba(148,163,184,0.25)' },
  SIG: { bg: 'rgba(56,189,248,0.12)', text: '#38bdf8', border: 'rgba(56,189,248,0.25)' },
  INS: { bg: 'rgba(34,197,94,0.12)', text: '#22c55e', border: 'rgba(34,197,94,0.25)' },
  SEG: { bg: 'rgba(249,115,22,0.12)', text: '#f97316', border: 'rgba(249,115,22,0.25)' },
  CON: { bg: 'rgba(168,85,247,0.12)', text: '#a855f7', border: 'rgba(168,85,247,0.25)' },
  SYN: { bg: 'rgba(236,72,153,0.12)', text: '#ec4899', border: 'rgba(236,72,153,0.25)' },
  DEF: { bg: 'rgba(59,130,246,0.12)', text: '#3b82f6', border: 'rgba(59,130,246,0.25)' },
  EVA: { bg: 'rgba(234,179,8,0.12)', text: '#eab308', border: 'rgba(234,179,8,0.25)' },
  REC: { bg: 'rgba(239,68,68,0.12)', text: '#ef4444', border: 'rgba(239,68,68,0.25)' },
};

const ALL_OPS: LoggableOperator[] = ['NUL', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];

// --- Agent icons ---
const AGENT_ICONS: Record<string, JSX.Element> = {
  human: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="4.5" r="2.5" stroke="currentColor" strokeWidth="1.3"/>
      <path d="M2.5 12.5C2.5 10 4.5 8 7 8s4.5 2 4.5 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  ),
  system: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="7" cy="7" r="1.5" fill="currentColor"/>
      <path d="M7 2.5v1M7 10.5v1M2.5 7h1M10.5 7h1" stroke="currentColor" strokeWidth="1"/>
    </svg>
  ),
  llm: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
      <rect x="2.5" y="2.5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.3"/>
      <circle cx="5.5" cy="6" r="0.8" fill="currentColor"/>
      <circle cx="8.5" cy="6" r="0.8" fill="currentColor"/>
      <path d="M5.5 9c0-.8.7-1.2 1.5-1.2s1.5.4 1.5 1.2" stroke="currentColor" strokeWidth="0.9"/>
    </svg>
  ),
};

function getAgentType(agent: string): 'human' | 'system' | 'llm' {
  if (agent === 'system') return 'system';
  if (agent.startsWith('llm:') || agent.includes('bot') || agent.includes('llm')) return 'llm';
  return 'human';
}

function getAgentName(agent: string): string {
  if (agent === 'system') return 'system';
  // Extract display name from Matrix user ID like @user:server
  if (agent.startsWith('@')) {
    const name = agent.slice(1).split(':')[0];
    return name || agent;
  }
  return agent;
}

// --- Relative time formatting ---
function formatTime(ts: string): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60000);
  const diffHr = Math.floor((now - d.getTime()) / 3600000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffHr < 24) return `${diffHr}h`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// --- OpBadge ---
function OpBadge({ op }: { op: string }) {
  const c = OP_COLORS[op] || OP_COLORS.NUL;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      borderRadius: 3, fontSize: 9.5, fontWeight: 700,
      fontFamily: 'var(--mono)', padding: '2px 7px',
      letterSpacing: '0.04em', lineHeight: 1.3, minWidth: 32, textAlign: 'center' as const,
    }}>
      {op}
    </span>
  );
}

// --- LevelBadge ---
function LevelBadge({ level }: { level: number }) {
  if (level <= 1) return null;
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, fontFamily: 'var(--mono)',
      color: level >= 3 ? '#ef4444' : '#eab308',
      background: level >= 3 ? 'rgba(239,68,68,0.1)' : 'rgba(234,179,8,0.1)',
      border: `1px solid ${level >= 3 ? 'rgba(239,68,68,0.2)' : 'rgba(234,179,8,0.2)'}`,
      borderRadius: 3, padding: '1px 4px', marginLeft: 6,
    }}>
      L{level}
    </span>
  );
}

// --- Operand formatting ---
function formatOperand(op: string, operand: any): JSX.Element | null {
  if (!operand || (typeof operand === 'object' && Object.keys(operand).length === 0)) return null;

  if (op === 'DEF') {
    const from = operand.from ?? operand.old_value;
    const to = operand.to ?? operand.new_value;
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
        {operand.field && <span style={{ color: '#64748b' }}>{operand.field}: </span>}
        <span style={{ color: '#64748b', textDecoration: 'line-through', opacity: 0.7 }}>{JSON.stringify(from)}</span>
        <span style={{ color: '#334155', margin: '0 5px' }}>{'\u2192'}</span>
        <span style={{ color: '#22c55e' }}>{JSON.stringify(to)}</span>
      </span>
    );
  }
  if (op === 'CON') {
    const dest = operand.link_to ?? operand.dest;
    const edgeType = operand.type ?? operand.edge_type;
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#a855f7' }}>
        {'\u2192'} {dest}
        {edgeType && <span style={{ color: '#475569', marginLeft: 5 }}>({edgeType})</span>}
      </span>
    );
  }
  if (op === 'REC') {
    const status = operand.converged ? 'converged' : 'oscillation';
    const statusColor = operand.converged ? '#22c55e' : '#eab308';
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
        <span style={{ color: statusColor }}>{status}</span>
        <span style={{ color: '#334155', margin: '0 5px' }}>|</span>
        <span style={{ color: '#64748b' }}>{operand.iterations} iterations</span>
        {operand.cycle_length && (
          <>
            <span style={{ color: '#334155', margin: '0 5px' }}>|</span>
            <span style={{ color: '#64748b' }}>cycle: {operand.cycle_length}</span>
          </>
        )}
      </span>
    );
  }
  if (op === 'NUL') {
    return (
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#94a3b8' }}>
        nullified{operand.reason ? ` — ${operand.reason}` : ''}
      </span>
    );
  }

  // Default: key-value pairs
  const entries = Object.entries(operand).filter(([k]) => !['type'].includes(k)).slice(0, 3);
  if (entries.length === 0) return null;
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#64748b' }}>
      {entries.map(([k, v], i) => (
        <span key={k}>
          <span style={{ color: '#475569' }}>{k}:</span>{' '}
          <span style={{ color: '#94a3b8' }}>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          {i < entries.length - 1 && <span style={{ color: '#1e293b', margin: '0 6px' }}>|</span>}
        </span>
      ))}
    </span>
  );
}

// --- Detail Panel ---
function DetailPanel({ event, onClose }: { event: EoEvent; onClose: () => void }) {
  const agentType = getAgentType(event.agent);
  const agentName = getAgentName(event.agent);
  const level = event.level ?? 1;

  const rows: { label: string; value: JSX.Element }[] = [
    {
      label: 'TARGET',
      value: <span style={{ color: '#94a3b8' }}>{event.target}</span>,
    },
    {
      label: 'AGENT',
      value: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: agentType === 'system' ? '#eab308' : '#64748b' }}>
            {AGENT_ICONS[agentType]}
          </span>
          <span style={{ color: '#cbd5e1' }}>{agentName}</span>
          <span style={{
            fontSize: 8, color: '#475569', background: '#111827',
            borderRadius: 2, padding: '1px 4px', border: '1px solid #1e293b',
          }}>{agentType}</span>
        </span>
      ),
    },
    {
      label: 'HASH',
      value: (
        <span style={{ color: '#475569', letterSpacing: '0.05em' }}>
          {event.meta?.hash || `t_${event.seq}`}
        </span>
      ),
    },
    {
      label: 'LEVEL',
      value: (
        <span style={{ color: level > 1 ? '#eab308' : '#64748b' }}>
          {level}
          {level > 1 && <span style={{ color: '#475569', marginLeft: 6, fontSize: 10 }}>derived</span>}
        </span>
      ),
    },
    {
      label: 'TIME',
      value: <span style={{ color: '#64748b' }}>{new Date(event.ts).toLocaleString()}</span>,
    },
  ];

  return (
    <div style={{
      width: 300, borderLeft: '1px solid #141a24',
      background: '#0a0f16', overflowY: 'auto' as const,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid #141a24',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <OpBadge op={event.op} />
          <span style={{ fontSize: 10, color: '#334155', fontFamily: 'var(--mono)' }}>
            #{event.seq}
          </span>
          <LevelBadge level={level} />
        </div>
        <button onClick={onClose} style={{
          background: '#111827', border: '1px solid #1e293b',
          borderRadius: 3, color: '#475569', cursor: 'pointer',
          width: 20, height: 20, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 11,
        }}>x</button>
      </div>

      {/* Body */}
      <div style={{ padding: '10px 14px' }}>
        {rows.map(({ label, value }) => (
          <div key={label} style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: '#334155',
              letterSpacing: '0.1em', marginBottom: 3, fontFamily: 'var(--mono)',
            }}>{label}</div>
            <div style={{
              fontSize: 11.5, fontFamily: 'var(--mono)',
              wordBreak: 'break-all' as const, lineHeight: 1.5,
            }}>{value}</div>
          </div>
        ))}

        {/* Operand */}
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 8, fontWeight: 700, color: '#334155',
            letterSpacing: '0.1em', marginBottom: 3, fontFamily: 'var(--mono)',
          }}>OPERAND</div>
          <pre style={{
            fontSize: 10.5, color: '#64748b', fontFamily: 'var(--mono)',
            background: '#080c12', borderRadius: 4, padding: 8, margin: 0,
            border: '1px solid #141a24',
            whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, lineHeight: 1.6,
          }}>
            {JSON.stringify(event.operand, null, 2)}
          </pre>
        </div>

        {/* Constituents for REC/derived events */}
        {level > 1 && event.operand?.constituents && (
          <div style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: '#334155',
              letterSpacing: '0.1em', marginBottom: 3, fontFamily: 'var(--mono)',
            }}>CONSTITUENTS</div>
            {(event.operand.constituents as string[]).map((c: string, i: number) => (
              <div key={i} style={{
                fontSize: 11, fontFamily: 'var(--mono)',
                color: '#3b82f6', padding: '3px 0', cursor: 'pointer',
              }}>{c}</div>
            ))}
          </div>
        )}

        {/* Footer links */}
        <div style={{ borderTop: '1px solid #141a24', paddingTop: 10, marginTop: 4 }}>
          <div style={{
            fontSize: 10.5, color: '#3b82f6', cursor: 'pointer',
            fontFamily: 'var(--mono)', padding: '4px 0',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{ fontSize: 11 }}>{'\u2193'}</span> target history
          </div>
          {level > 1 && (
            <div style={{
              fontSize: 10.5, color: '#a855f7', cursor: 'pointer',
              fontFamily: 'var(--mono)', padding: '4px 0',
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span style={{ fontSize: 11 }}>{'\u2191'}</span> dependency graph
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main LogView ---
export function LogView() {
  const recentEvents = useEoStore((s) => s.recentEvents);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<EoEvent | null>(null);
  const [filterText, setFilterText] = useState('');

  // Count events by operator
  const opCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const op of ALL_OPS) m[op] = 0;
    for (const e of recentEvents) m[e.op] = (m[e.op] || 0) + 1;
    return m;
  }, [recentEvents]);

  // Filtered events (newest first)
  const filtered = useMemo(() => {
    const sorted = [...recentEvents].reverse();
    return sorted.filter((e) => {
      if (activeFilters.size > 0 && !activeFilters.has(e.op)) return false;
      if (filterText && !e.target.toLowerCase().includes(filterText.toLowerCase())) return false;
      return true;
    });
  }, [recentEvents, activeFilters, filterText]);

  function toggleFilter(op: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(op)) next.delete(op);
      else next.add(op);
      return next;
    });
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, background: '#080c12' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, minWidth: 0 }}>
        {/* Filters */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 16px', borderBottom: '1px solid #0f1520',
        }}>
          {ALL_OPS.map((op) => {
            const c = OP_COLORS[op];
            const active = activeFilters.has(op);
            const count = opCounts[op];
            return (
              <button key={op} onClick={() => toggleFilter(op)} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: active ? c.bg : 'transparent',
                border: `1px solid ${active ? c.border : '#151c28'}`,
                color: active ? c.text : count > 0 ? '#3e4a5a' : '#1e293b',
                borderRadius: 3, padding: '2px 6px', cursor: 'pointer',
                fontSize: 9, fontWeight: 600, fontFamily: 'var(--mono)',
                letterSpacing: '0.03em', transition: 'all 0.1s',
              }}>
                {op}
                <span style={{ fontSize: 8, opacity: 0.5 }}>{count}</span>
              </button>
            );
          })}
          <div style={{ flex: 1 }} />
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="filter targets..."
            style={{
              background: '#0d1117', border: '1px solid #1a2030',
              borderRadius: 3, padding: '4px 8px', color: '#94a3b8',
              fontSize: 10, fontFamily: 'var(--mono)', width: 160, outline: 'none',
            }}
          />
        </div>

        {/* Event rows */}
        <div style={{ flex: 1, overflowY: 'auto' as const }}>
          {filtered.map((event) => {
            const sel = selectedEvent?.seq === event.seq;
            const c = OP_COLORS[event.op];
            const isSystem = event.agent === 'system';
            const parts = event.target.split('.');
            const level = event.level ?? 1;
            const agentType = getAgentType(event.agent);
            const operandEl = formatOperand(event.op, event.operand);

            return (
              <div
                key={event.seq}
                onClick={() => setSelectedEvent(sel ? null : event)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '9px 16px', cursor: 'pointer',
                  background: sel ? '#0e1420' : 'transparent',
                  borderBottom: '1px solid #0c1018',
                  borderLeft: sel ? `2px solid ${c.text}` : '2px solid transparent',
                  transition: 'background 0.08s',
                }}
                onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = '#0b0f18'; }}
                onMouseLeave={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
              >
                {/* Seq */}
                <span style={{
                  fontSize: 9, color: '#252d38', fontFamily: 'var(--mono)',
                  minWidth: 18, textAlign: 'right' as const, paddingTop: 3, fontWeight: 500,
                }}>{event.seq}</span>

                {/* Agent icon */}
                <span style={{
                  paddingTop: 2, color: isSystem ? '#eab308' : '#3e4a5a',
                  display: 'flex', alignItems: 'center',
                }}>
                  {AGENT_ICONS[agentType]}
                </span>

                {/* Op badge */}
                <OpBadge op={event.op} />

                {/* Content: target + operand */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 500 }}>
                      {parts.map((seg, i) => (
                        <span key={i}>
                          {i < parts.length - 1 ? (
                            <>
                              <span style={{ color: '#3e4a5a' }}>{seg}</span>
                              <span style={{ color: '#252d38' }}>.</span>
                            </>
                          ) : (
                            <span style={{ color: '#e2e8f0' }}>{seg}</span>
                          )}
                        </span>
                      ))}
                    </span>
                    <LevelBadge level={level} />
                  </div>
                  {operandEl && (
                    <div style={{ marginTop: 3, lineHeight: 1.3 }}>
                      {operandEl}
                    </div>
                  )}
                </div>

                {/* Timestamp */}
                <span style={{
                  fontSize: 9, color: '#252d38', fontFamily: 'var(--mono)',
                  whiteSpace: 'nowrap' as const, paddingTop: 3,
                }}>{formatTime(event.ts)}</span>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{
              padding: 48, textAlign: 'center' as const, color: '#1e293b',
              fontSize: 11, fontFamily: 'var(--mono)',
            }}>
              {recentEvents.length === 0 ? 'no events yet' : 'no events match'}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedEvent && (
        <DetailPanel event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}
