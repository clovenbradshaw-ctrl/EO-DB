import { useState, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import type { EoEvent, LoggableOperator } from '../db/types';

// --- Operator colors (rgba-based, works on light and dark backgrounds) ---
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
  if (agent.startsWith('@')) {
    const name = agent.slice(1).split(':')[0];
    return name || agent;
  }
  return agent;
}

// --- Time formatting (HH:MM:SS) ---
function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// --- OpBadge ---
function OpBadge({ op }: { op: string }) {
  const c = OP_COLORS[op] || OP_COLORS.NUL;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      borderRadius: 3, fontSize: 9.5, fontWeight: 700,
      fontFamily: "'JetBrains Mono', monospace", padding: '2px 7px',
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
      fontSize: 8, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
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
function formatOperand(op: string, operand: any, t: { textSecondary: string; textMuted: string; text: string; border: string; success: string; purple: string; warning: string }): JSX.Element | null {
  if (!operand || (typeof operand === 'object' && Object.keys(operand).length === 0)) return null;

  if (op === 'DEF') {
    const from = operand.from ?? operand.old_value;
    const to = operand.to ?? operand.new_value;
    return (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        {operand.field && <span style={{ color: t.textSecondary }}>{operand.field}: </span>}
        <span style={{ color: t.textSecondary, textDecoration: 'line-through', opacity: 0.7 }}>{JSON.stringify(from)}</span>
        <span style={{ color: t.textMuted, margin: '0 5px' }}>{'\u2192'}</span>
        <span style={{ color: t.success }}>{JSON.stringify(to)}</span>
      </span>
    );
  }
  if (op === 'CON') {
    const dest = operand.link_to ?? operand.dest;
    const edgeType = operand.type ?? operand.edge_type;
    return (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.purple }}>
        {'\u2192'} {dest}
        {edgeType && <span style={{ color: t.textMuted, marginLeft: 5 }}>({edgeType})</span>}
      </span>
    );
  }
  if (op === 'REC') {
    const status = operand.converged ? 'converged' : 'oscillation';
    const statusColor = operand.converged ? t.success : t.warning;
    return (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
        <span style={{ color: statusColor }}>{status}</span>
        <span style={{ color: t.textMuted, margin: '0 5px' }}>|</span>
        <span style={{ color: t.textSecondary }}>{operand.iterations} iterations</span>
        {operand.cycle_length && (
          <>
            <span style={{ color: t.textMuted, margin: '0 5px' }}>|</span>
            <span style={{ color: t.textSecondary }}>cycle: {operand.cycle_length}</span>
          </>
        )}
      </span>
    );
  }
  if (op === 'NUL') {
    return (
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textMuted }}>
        nullified{operand.reason ? ` \u2014 ${operand.reason}` : ''}
      </span>
    );
  }

  // Default: key-value pairs
  const entries = Object.entries(operand).filter(([k]) => !['type'].includes(k)).slice(0, 3);
  if (entries.length === 0) return null;
  return (
    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>
      {entries.map(([k, v], i) => (
        <span key={k}>
          <span style={{ color: t.textMuted }}>{k}:</span>{' '}
          <span style={{ color: t.textSecondary }}>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
          {i < entries.length - 1 && <span style={{ color: t.border, margin: '0 6px' }}>|</span>}
        </span>
      ))}
    </span>
  );
}

// --- Detail Panel ---
function DetailPanel({ event, onClose }: { event: EoEvent; onClose: () => void }) {
  const { theme: t } = useTheme();
  const agentType = getAgentType(event.agent);
  const agentName = getAgentName(event.agent);
  const level = event.level ?? 1;

  const rows: { label: string; value: JSX.Element }[] = [
    {
      label: 'TARGET',
      value: <span style={{ color: t.textSecondary }}>{event.target}</span>,
    },
    {
      label: 'AGENT',
      value: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ color: agentType === 'system' ? t.warning : t.textSecondary }}>
            {AGENT_ICONS[agentType]}
          </span>
          <span style={{ color: t.text }}>{agentName}</span>
          <span style={{
            fontSize: 8, color: t.textMuted, background: t.bgMuted,
            borderRadius: 2, padding: '1px 4px', border: `1px solid ${t.border}`,
          }}>{agentType}</span>
        </span>
      ),
    },
    {
      label: 'HASH',
      value: (
        <span style={{ color: t.textMuted, letterSpacing: '0.05em' }}>
          {event.meta?.hash || `t_${event.seq}`}
        </span>
      ),
    },
    {
      label: 'LEVEL',
      value: (
        <span style={{ color: level > 1 ? t.warning : t.textSecondary }}>
          {level}
          {level > 1 && <span style={{ color: t.textMuted, marginLeft: 6, fontSize: 10 }}>derived</span>}
        </span>
      ),
    },
    {
      label: 'TIME',
      value: <span style={{ color: t.textSecondary }}>{new Date(event.ts).toLocaleString()}</span>,
    },
  ];

  return (
    <div style={{
      width: 300, borderLeft: `1px solid ${t.border}`,
      background: t.bgCard, overflowY: 'auto' as const,
    }}>
      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <OpBadge op={event.op} />
          <span style={{ fontSize: 10, color: t.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
            #{event.seq}
          </span>
          <LevelBadge level={level} />
        </div>
        <button onClick={onClose} style={{
          background: t.bgMuted, border: `1px solid ${t.border}`,
          borderRadius: 3, color: t.textMuted, cursor: 'pointer',
          width: 20, height: 20, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 11,
        }}>x</button>
      </div>

      {/* Body */}
      <div style={{ padding: '10px 14px' }}>
        {rows.map(({ label, value }) => (
          <div key={label} style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: t.textMuted,
              letterSpacing: '0.1em', marginBottom: 3, fontFamily: "'JetBrains Mono', monospace",
            }}>{label}</div>
            <div style={{
              fontSize: 11.5, fontFamily: "'JetBrains Mono', monospace",
              wordBreak: 'break-all' as const, lineHeight: 1.5,
            }}>{value}</div>
          </div>
        ))}

        {/* Operand */}
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 8, fontWeight: 700, color: t.textMuted,
            letterSpacing: '0.1em', marginBottom: 3, fontFamily: "'JetBrains Mono', monospace",
          }}>OPERAND</div>
          <pre style={{
            fontSize: 10.5, color: t.textSecondary, fontFamily: "'JetBrains Mono', monospace",
            background: t.bg, borderRadius: 4, padding: 8, margin: 0,
            border: `1px solid ${t.border}`,
            whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, lineHeight: 1.6,
          }}>
            {JSON.stringify(event.operand, null, 2)}
          </pre>
        </div>

        {/* Constituents for REC/derived events */}
        {level > 1 && event.operand?.constituents && (
          <div style={{ marginBottom: 12 }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: t.textMuted,
              letterSpacing: '0.1em', marginBottom: 3, fontFamily: "'JetBrains Mono', monospace",
            }}>CONSTITUENTS</div>
            {(event.operand.constituents as string[]).map((c: string, i: number) => (
              <div key={i} style={{
                fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
                color: t.accent, padding: '3px 0', cursor: 'pointer',
              }}>{c}</div>
            ))}
          </div>
        )}

        {/* Footer links */}
        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 10, marginTop: 4 }}>
          <div style={{
            fontSize: 10.5, color: t.accent, cursor: 'pointer',
            fontFamily: "'JetBrains Mono', monospace", padding: '4px 0',
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{ fontSize: 11 }}>{'\u2193'}</span> target history
          </div>
          {level > 1 && (
            <div style={{
              fontSize: 10.5, color: t.purple, cursor: 'pointer',
              fontFamily: "'JetBrains Mono', monospace", padding: '4px 0',
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

// --- Table cell styles ---
function thStyle(t: { bg: string; textMuted: string; border: string }): React.CSSProperties {
  return {
    position: 'sticky' as const, top: 0, background: t.bg,
    padding: '10px 16px', textAlign: 'left' as const,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const,
    letterSpacing: '0.04em', color: t.textMuted,
    fontFamily: "'JetBrains Mono', monospace",
    borderBottom: `2px solid ${t.border}`, whiteSpace: 'nowrap' as const, zIndex: 2,
  };
}

function tdStyle(t: { border: string; bgCard: string; borderLight: string }): React.CSSProperties {
  return {
    padding: '10px 16px', borderBottom: `1px solid ${t.borderLight}`,
    verticalAlign: 'middle' as const, background: t.bgCard,
  };
}

// --- Main LogView ---
export function LogView({ targetFilter }: { targetFilter?: string | null }) {
  const recentEvents = useEoStore((s) => s.recentEvents);
  const { theme: t } = useTheme();
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<EoEvent | null>(null);
  const [filterText, setFilterText] = useState('');
  const [opMenuOpen, setOpMenuOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);

  // Filtered events (newest first)
  const filtered = useMemo(() => {
    const sorted = [...recentEvents].reverse();
    return sorted.filter((e) => {
      if (activeFilters.size > 0 && !activeFilters.has(e.op)) return false;
      if (targetFilter && !e.target.startsWith(targetFilter)) return false;
      if (filterText && !e.target.toLowerCase().includes(filterText.toLowerCase())) return false;
      return true;
    });
  }, [recentEvents, activeFilters, filterText, targetFilter]);

  const visible = filtered.slice(0, visibleCount);

  function toggleFilter(op: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(op)) next.delete(op);
      else next.add(op);
      return next;
    });
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, minWidth: 0, background: t.bgCard }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 24px', borderBottom: `1px solid ${t.border}`, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <span style={{
              fontFamily: "'Source Serif 4', Georgia, serif", fontSize: 20,
              fontWeight: 600, color: t.textHeading,
            }}>Event log</span>
            <span style={{
              fontSize: 12, color: t.textMuted,
              fontFamily: "'JetBrains Mono', monospace",
            }}>{filtered.length} events</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter by target..."
              style={{
                background: t.bgMuted, border: `1px solid ${t.border}`,
                borderRadius: 4, padding: '6px 10px', color: t.text,
                fontSize: 12, fontFamily: "'JetBrains Mono', monospace",
                width: 200, outline: 'none',
              }}
            />
            <div style={{ position: 'relative' as const }}>
              <button
                onClick={() => setOpMenuOpen(!opMenuOpen)}
                style={{
                  padding: '6px 12px', fontSize: 12, fontWeight: 500,
                  border: `1px solid ${t.border}`, borderRadius: 4,
                  background: activeFilters.size > 0 ? t.accentBg : t.bgCard,
                  color: t.text, cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                Op{activeFilters.size > 0 ? ` (${activeFilters.size})` : ''}
              </button>
              {opMenuOpen && (
                <>
                  <div style={{ position: 'fixed' as const, inset: 0, zIndex: 99 }} onClick={() => setOpMenuOpen(false)} />
                  <div style={{
                    position: 'absolute' as const, right: 0, top: '100%', marginTop: 4,
                    background: t.bgCard, border: `1px solid ${t.border}`,
                    borderRadius: 6, padding: 6, zIndex: 100, minWidth: 100,
                    boxShadow: `0 4px 16px ${t.shadow}`,
                  }}>
                    {ALL_OPS.map((op) => {
                      const c = OP_COLORS[op];
                      const active = activeFilters.has(op);
                      return (
                        <button key={op} onClick={() => toggleFilter(op)} style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                          padding: '5px 8px', border: 'none', borderRadius: 3,
                          background: active ? c.bg : 'transparent',
                          color: active ? c.text : t.textSecondary,
                          cursor: 'pointer', fontSize: 11, fontWeight: 600,
                          fontFamily: "'JetBrains Mono', monospace",
                        }}>
                          <OpBadge op={op} />
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto' as const, overflowX: 'auto' as const }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, color: t.textHeading }}>
            <thead>
              <tr>
                <th style={{ ...thStyle(t), minWidth: 50, textAlign: 'right' as const }}>SEQ</th>
                <th style={{ ...thStyle(t), minWidth: 60 }}>OP</th>
                <th style={{ ...thStyle(t), minWidth: 200 }}>TARGET</th>
                <th style={{ ...thStyle(t), minWidth: 140 }}>AGENT</th>
                <th style={{ ...thStyle(t), minWidth: 80, textAlign: 'right' as const }}>TIME</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} style={{
                    padding: 48, textAlign: 'center' as const, color: t.textMuted,
                    fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
                  }}>
                    {recentEvents.length === 0 ? 'no events yet' : 'no events match'}
                  </td>
                </tr>
              )}
              {visible.map((event) => {
                const sel = selectedEvent?.seq === event.seq;
                const agentName = getAgentName(event.agent);
                return (
                  <tr
                    key={event.seq}
                    onClick={() => setSelectedEvent(sel ? null : event)}
                    style={{
                      cursor: 'pointer',
                      background: sel ? t.bgHover : 'transparent',
                    }}
                    onMouseEnter={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = t.bgHover; }}
                    onMouseLeave={(e) => { if (!sel) (e.currentTarget as HTMLElement).style.background = sel ? t.bgHover : 'transparent'; }}
                  >
                    <td style={{
                      ...tdStyle(t), textAlign: 'right' as const,
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
                      color: t.textMuted, fontWeight: 500,
                    }}>{event.seq}</td>
                    <td style={tdStyle(t)}><OpBadge op={event.op} /></td>
                    <td style={{
                      ...tdStyle(t), fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 12, color: t.accent,
                    }}>{event.target}</td>
                    <td style={{
                      ...tdStyle(t), fontSize: 12, color: t.textSecondary,
                      maxWidth: 180, overflow: 'hidden' as const,
                      textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const,
                    }}>{agentName}</td>
                    <td style={{
                      ...tdStyle(t), textAlign: 'right' as const,
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
                      color: t.textMuted, whiteSpace: 'nowrap' as const,
                    }}>{formatTime(event.ts)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination footer */}
          {filtered.length > 0 && (
            <div style={{
              padding: '16px 24px', textAlign: 'center' as const, fontSize: 11,
              color: t.textMuted, fontFamily: "'JetBrains Mono', monospace",
              borderTop: `1px solid ${t.borderLight}`,
            }}>
              Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} events
              {filtered.length > visibleCount && (
                <button
                  onClick={() => setVisibleCount((c) => c + 50)}
                  style={{
                    marginLeft: 12, padding: '2px 10px', fontSize: 10,
                    border: `1px solid ${t.border}`, borderRadius: 3,
                    background: 'transparent', color: t.accent, cursor: 'pointer',
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  show more
                </button>
              )}
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
