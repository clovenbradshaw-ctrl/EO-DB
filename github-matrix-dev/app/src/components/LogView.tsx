import { useState, useMemo, useEffect, Fragment } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import type { EoEvent, LoggableOperator, NulState, Resolution } from '../db/types';
import { resolutionToNulState, nulStateToResolution } from '../db/types';

// --- Operator colors — three triads ---
export const OP_COLORS: Record<string, { bg: string; text: string; border: string; fill: string }> = {
  // Identity triad (warm)
  NUL: { bg: '#FEF3C7', text: '#92400E', border: '#F59E0B', fill: '#FBBF24' },
  INS: { bg: '#DCFCE7', text: '#166534', border: '#22C55E', fill: '#4ADE80' },
  // Structure triad (cool)
  SEG: { bg: '#DBEAFE', text: '#1E40AF', border: '#3B82F6', fill: '#60A5FA' },
  CON: { bg: '#E0E7FF', text: '#3730A3', border: '#6366F1', fill: '#818CF8' },
  SYN: { bg: '#F3E8FF', text: '#6B21A8', border: '#A855F7', fill: '#C084FC' },
  // Interpretation triad (earth)
  DEF: { bg: '#FFF7ED', text: '#9A3412', border: '#F97316', fill: '#FB923C' },
  EVA: { bg: '#F0FDFA', text: '#115E59', border: '#14B8A6', fill: '#2DD4BF' },
  REC: { bg: '#FDF2F8', text: '#9D174D', border: '#EC4899', fill: '#F472B6' },
  // Identity triad (ephemeral)
  SIG: { bg: '#E6F1FB', text: '#185FA5', border: '#A8CCE8', fill: '#5B9BD5' },
};

export const TRIAD_LABELS: { label: string; ops: string[] }[] = [
  { label: 'Identity', ops: ['NUL', 'SIG', 'INS'] },
  { label: 'Structure', ops: ['SEG', 'CON', 'SYN'] },
  { label: 'Interpretation', ops: ['DEF', 'EVA', 'REC'] },
];

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

// --- Time formatting ---
function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatFullTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { hour12: false, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelativeTime(ts: string): string {
  const now = Date.now();
  const then = new Date(ts).getTime();
  const diff = now - then;
  if (diff < 0) return 'just now';
  if (diff < 5000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 172800000) return 'yesterday';
  return `${Math.floor(diff / 86400000)}d ago`;
}

function getTimeGroup(ts: string): string {
  const now = Date.now();
  const then = new Date(ts).getTime();
  const diff = now - then;
  if (diff < 60000) return 'Just now';
  if (diff < 600000) return 'Last few minutes';
  if (diff < 3600000) return 'Last hour';
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (then >= todayStart.getTime()) return 'Earlier today';
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  if (then >= yesterdayStart.getTime()) return 'Yesterday';
  return 'Older';
}

// --- OpBadge ---
function OpBadge({ op, size = 'normal' }: { op: string; size?: 'normal' | 'small' }) {
  const c = OP_COLORS[op] || OP_COLORS.NUL;
  return (
    <span style={{
      display: 'inline-block',
      background: c.bg, color: c.text,
      border: `1px solid ${c.border}`,
      borderRadius: 3, fontSize: size === 'small' ? 9 : 10, fontWeight: 600,
      padding: size === 'small' ? '0px 4px' : '1px 6px',
      lineHeight: 1.4, textAlign: 'center' as const,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.02em',
    }}>
      {op}
    </span>
  );
}

// --- NulStateBadge (F1.2) ---
// NUL_STATE_COLORS is keyed by the legacy NulState vocabulary because the
// visual palette is already well-known in the UI. The Resolution axis is
// converted into the corresponding NulState via resolutionToNulState so the
// badge renders the same colors whether the upstream event carries the new
// `resolution` field or the legacy `nul_state` field.
const NUL_STATE_COLORS: Record<NulState, { bg: string; text: string }> = {
  'never-set':         { bg: '#6b7280', text: '#fff' },
  'unknown':           { bg: '#d97706', text: '#fff' },
  'cleared':           { bg: '#3b82f6', text: '#fff' },
  'promotion_blocked': { bg: '#ef4444', text: '#fff' },
};

/**
 * Resolution → color map for NUL events. Non-NUL operators currently have no
 * resolution surface in the UI — resolution display for the full operator
 * set is future work. Only NUL rows consult this map.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const RESOLUTION_COLORS: Partial<Record<Resolution, { bg: string; text: string }>> = {
  unspecified: { bg: '#6b7280', text: '#fff' },
  Clearing:    { bg: '#3b82f6', text: '#fff' },
  Tracing:     { bg: '#d97706', text: '#fff' },
  Unraveling:  { bg: '#ef4444', text: '#fff' },
};

function NulStateBadge({ resolution }: { resolution: Resolution }) {
  const legacy = resolutionToNulState(resolution);
  const c = NUL_STATE_COLORS[legacy];
  return (
    <span style={{
      display: 'inline-block',
      background: c.bg, color: c.text,
      borderRadius: 3, fontSize: 9, fontWeight: 600,
      padding: '1px 5px', lineHeight: 1.4,
      fontFamily: "'JetBrains Mono', monospace",
      letterSpacing: '0.02em',
    }}>
      {legacy}
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
      borderRadius: 3, padding: '1px 4px', marginLeft: 4,
    }}>
      L{level}
    </span>
  );
}

// Envelope metadata keys on DEF operands that aren't part of the diff itself.
// NOTE: keys like `_displayField`, `_label`, `_type` ARE diffed values (the DEF's
// intent) and must NOT be excluded — only pure envelope metadata goes here.
const DEF_METADATA_KEYS = new Set(['_airtable', '_prev', '_sigs']);

// A DEF operand uses the legacy explicit-diff shape when it has at least one
// of `from`/`to`/`old_value`/`new_value`. These are rendered as a single
// old → new arrow. All other DEF shapes are key-value diffs extracted via
// getDefDiffFields.
function isDefDiff(operand: any): boolean {
  return operand && (
    operand.from !== undefined ||
    operand.to !== undefined ||
    operand.old_value !== undefined ||
    operand.new_value !== undefined
  );
}

/**
 * Extract the diffed field entries from a DEF operand. DEF events carry only
 * the fields that were changed by the update, but they can arrive in several
 * shapes:
 *   - { fields: { ... }, _airtable: {...} }  (Airtable sync, cell edits)
 *   - { name: 'foo', type: 'bar' }           (direct top-level fields)
 */
function getDefDiffFields(operand: any): Array<[string, unknown]> {
  if (!operand || typeof operand !== 'object') return [];

  // Nested fields shape — only show the diffed fields, never the envelope metadata
  if (operand.fields && typeof operand.fields === 'object' && !Array.isArray(operand.fields)) {
    return Object.entries(operand.fields as Record<string, unknown>)
      .filter(([, v]) => v !== undefined);
  }

  // Top-level fields shape — exclude known envelope metadata
  return Object.entries(operand as Record<string, unknown>).filter(
    ([k, v]) => !DEF_METADATA_KEYS.has(k) && v !== undefined
  );
}

/** Look up the previous value for a field from a DEF operand's _prev snapshot. */
function getDefPrevValue(operand: any, key: string): unknown {
  if (!operand || typeof operand !== 'object' || !operand._prev || typeof operand._prev !== 'object') {
    return undefined;
  }
  return (operand._prev as Record<string, unknown>)[key];
}

function shortValue(v: unknown, max = 40): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length > max ? s.slice(0, max) + '\u2026' : s;
}

function genericOperandSummary(operand: any, maxEntries: number): string | null {
  const entries = Object.entries(operand)
    .filter(([k, v]) => !['type'].includes(k) && v !== undefined)
    .slice(0, maxEntries);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' | ');
}

// --- Operand summary (short inline preview) ---
function operandSummary(op: string, operand: any): string | null {
  if (!operand || (typeof operand === 'object' && Object.keys(operand).length === 0)) return null;

  if (op === 'DEF') {
    // Legacy explicit-diff shape: show old → new on a single line
    if (isDefDiff(operand)) {
      const field = operand.field || '';
      const from = operand.from ?? operand.old_value;
      const to = operand.to ?? operand.new_value;
      return `${field ? field + ': ' : ''}${JSON.stringify(from)} \u2192 ${JSON.stringify(to)}`;
    }

    // Otherwise show only the fields that were diff'd, unwrapping the
    // { fields: { ... } } envelope when present and filtering envelope
    // metadata like _airtable/_prev/_sigs.
    const entries = getDefDiffFields(operand);
    if (entries.length === 0) return 'updated';

    const parts = entries.slice(0, 2).map(([k, v]) => `${k}: ${shortValue(v, 32)}`);
    const summary = parts.join(' | ');
    return entries.length > 2 ? `${summary} | +${entries.length - 2} more` : summary;
  }
  if (op === 'CON') {
    const dest = operand.link_to ?? operand.dest;
    const edgeType = operand.type ?? operand.edge_type;
    return `\u2192 ${dest}${edgeType ? ' (' + edgeType + ')' : ''}`;
  }
  if (op === 'REC') {
    const status = operand.converged ? 'converged' : 'oscillation';
    return `${status} | ${operand.iterations} iterations${operand.cycle_length ? ' | cycle: ' + operand.cycle_length : ''}`;
  }
  if (op === 'NUL') {
    return `nullified${operand.reason ? ' \u2014 ' + operand.reason : ''}`;
  }
  return genericOperandSummary(operand, 2);
}

// --- Operand formatting (rich, for detail panel) ---
function formatOperand(op: string, operand: any, t: { textSecondary: string; textMuted: string; text: string; border: string; success: string; purple: string; warning: string }): JSX.Element | null {
  if (!operand || (typeof operand === 'object' && Object.keys(operand).length === 0)) return null;

  if (op === 'DEF') {
    // Legacy explicit-diff shape
    if (isDefDiff(operand)) {
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

    // Otherwise show only the fields that were diff'd, unwrapping the
    // { fields: { ... } } envelope when present.
    const entries = getDefDiffFields(operand);
    if (entries.length === 0) {
      return (
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textMuted }}>
          updated
        </span>
      );
    }

    return (
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        display: 'flex', flexDirection: 'column' as const, gap: 3,
      }}>
        {entries.map(([k, v]) => {
          const newDisplay = typeof v === 'string' ? v : JSON.stringify(v);
          const prev = getDefPrevValue(operand, k);
          const oldDisplay = prev !== undefined
            ? (typeof prev === 'string' ? prev : JSON.stringify(prev))
            : null;
          return (
            <div key={k} style={{
              display: 'flex', gap: 6, alignItems: 'flex-start',
              flexWrap: 'wrap' as const, minWidth: 0,
            }}>
              <span style={{ color: t.textMuted, flexShrink: 0 }}>{k}:</span>
              {oldDisplay !== null && (
                <>
                  <span style={{
                    color: t.textSecondary, textDecoration: 'line-through', opacity: 0.7,
                    wordBreak: 'break-all' as const,
                  }}>{oldDisplay}</span>
                  <span style={{ color: t.textMuted }}>{'\u2192'}</span>
                </>
              )}
              <span style={{
                color: t.success, wordBreak: 'break-all' as const, minWidth: 0,
              }}>{newDisplay}</span>
            </div>
          );
        })}
      </div>
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


// --- Stats Bar ---
function StatsBar({ events, activeFilters, onToggleFilter }: {
  events: EoEvent[];
  activeFilters: Set<string>;
  onToggleFilter: (op: string) => void;
}) {
  const { theme: t } = useTheme();
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of events) c[e.op] = (c[e.op] || 0) + 1;
    return c;
  }, [events]);
  const total = events.length;
  if (total === 0) return null;

  return (
    <div style={{ padding: '0 20px 0 20px' }}>
      {/* Stacked bar */}
      <div style={{
        display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden',
        background: t.bgMuted, marginBottom: 10,
      }}>
        {ALL_OPS.map((op) => {
          const count = counts[op] || 0;
          if (count === 0) return null;
          const c = OP_COLORS[op];
          return (
            <div key={op} style={{
              width: `${(count / total) * 100}%`, background: c.text,
              opacity: activeFilters.size === 0 || activeFilters.has(op) ? 0.7 : 0.15,
              transition: 'opacity 0.15s',
            }} title={`${op}: ${count}`} />
          );
        })}
      </div>

      {/* Op filter chips — grouped by triad */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const, alignItems: 'center' }}>
        {TRIAD_LABELS.map((triad, idx) => (
          <Fragment key={triad.label}>
            {idx > 0 && (
              <div style={{
                width: 1, height: 16, background: t.borderDivider,
                margin: '0 4px', flexShrink: 0,
              }} />
            )}
            {triad.ops.map((op) => {
              const count = counts[op] || 0;
              const active = activeFilters.has(op);
              const c = OP_COLORS[op];
              return (
                <button
                  key={op}
                  onClick={() => onToggleFilter(op)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
                    fontSize: 10, fontWeight: 600,
                    fontFamily: "'JetBrains Mono', monospace",
                    border: `1px solid ${active ? c.border : count > 0 ? c.border + '60' : t.border}`,
                    background: active ? c.bg : 'transparent',
                    color: active ? c.text : count > 0 ? c.text : t.textMuted,
                    opacity: count === 0 ? 0.4 : 1,
                    transition: 'all 0.15s',
                  }}
                >
                  {op}
                  {count > 0 && (
                    <span style={{
                      fontSize: 9, color: active ? c.text : t.textMuted,
                      fontWeight: 400, opacity: 0.8,
                    }}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// --- Detail Panel ---
function DetailPanel({ event, onClose }: { event: EoEvent; onClose: () => void }) {
  const { theme: t } = useTheme();
  const agentType = getAgentType(event.agent);
  const agentName = getAgentName(event.agent);
  const level = event.level ?? 1;

  const sections: { label: string; value: JSX.Element }[] = [
    {
      label: 'TARGET',
      value: <span style={{ color: t.accent, wordBreak: 'break-all' as const }}>{event.target}</span>,
    },
    {
      label: 'AGENT',
      value: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: agentType === 'system' ? t.warning : t.textSecondary, display: 'flex' }}>
            {AGENT_ICONS[agentType]}
          </span>
          <span style={{ color: t.text }}>{agentName}</span>
          <span style={{
            fontSize: 8, color: t.textMuted, background: t.bgMuted,
            borderRadius: 3, padding: '1px 5px', border: `1px solid ${t.border}`,
          }}>{agentType}</span>
        </span>
      ),
    },
    {
      label: 'TIMESTAMP',
      value: (
        <div>
          <div style={{ color: t.textSecondary }}>{formatFullTime(event.ts)}</div>
          <div style={{ fontSize: 10, color: t.textMuted, marginTop: 2 }}>{formatRelativeTime(event.ts)}</div>
        </div>
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
      label: 'HASH',
      value: (
        <span style={{ color: t.textMuted, letterSpacing: '0.05em', fontSize: 10 }}>
          {event.meta?.hash || `t_${event.seq}`}
        </span>
      ),
    },
  ];

  if (event.triggered_by) {
    sections.push({
      label: 'TRIGGERED BY',
      value: <span style={{ color: t.accent }}>#{event.triggered_by}</span>,
    });
  }

  return (
    <div style={{
      width: 360, borderLeft: `1px solid ${t.border}`,
      background: t.bgCard, overflowY: 'auto' as const,
      display: 'flex', flexDirection: 'column' as const,
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 18px', borderBottom: `1px solid ${t.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <OpBadge op={event.op} />
          <span style={{ fontSize: 12, color: t.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
            #{event.seq}
          </span>
          <LevelBadge level={level} />
        </div>
        <button onClick={onClose} style={{
          background: t.bgMuted, border: `1px solid ${t.border}`,
          borderRadius: 4, color: t.textMuted, cursor: 'pointer',
          width: 24, height: 24, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 12, lineHeight: 1,
        }}>{'\u00d7'}</button>
      </div>

      {/* Body */}
      <div style={{ padding: '14px 18px', flex: 1, overflowY: 'auto' as const }}>
        {/* Operand preview */}
        {event.operand && Object.keys(event.operand).length > 0 && (
          <div style={{
            marginBottom: 16, padding: '10px 12px', borderRadius: 6,
            background: t.bgMuted, border: `1px solid ${t.borderLight}`,
          }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: t.textMuted,
              letterSpacing: '0.1em', marginBottom: 6, fontFamily: "'JetBrains Mono', monospace",
            }}>OPERAND</div>
            <div style={{ marginBottom: 8 }}>
              {formatOperand(event.op, event.operand, t)}
            </div>
            <pre style={{
              fontSize: 10, color: t.textSecondary, fontFamily: "'JetBrains Mono', monospace",
              background: t.bg, borderRadius: 4, padding: 8, margin: 0,
              border: `1px solid ${t.border}`,
              whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, lineHeight: 1.6,
              maxHeight: 200, overflowY: 'auto' as const,
            }}>
              {JSON.stringify(event.operand, null, 2)}
            </pre>
          </div>
        )}

        {/* Meta fields */}
        {sections.map(({ label, value }) => (
          <div key={label} style={{ marginBottom: 14 }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: t.textMuted,
              letterSpacing: '0.1em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace",
            }}>{label}</div>
            <div style={{
              fontSize: 11.5, fontFamily: "'JetBrains Mono', monospace",
              lineHeight: 1.5,
            }}>{value}</div>
          </div>
        ))}

        {/* Constituents for REC/derived events */}
        {level > 1 && event.operand?.constituents && (
          <div style={{ marginBottom: 14 }}>
            <div style={{
              fontSize: 8, fontWeight: 700, color: t.textMuted,
              letterSpacing: '0.1em', marginBottom: 4, fontFamily: "'JetBrains Mono', monospace",
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
        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 12, marginTop: 4 }}>
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


// --- Time group divider ---
function TimeGroupDivider({ label }: { label: string }) {
  const { theme: t } = useTheme();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 20px 6px 20px',
    }}>
      <span style={{
        fontSize: 9, fontWeight: 600, color: t.textMuted,
        letterSpacing: '0.08em', textTransform: 'uppercase' as const,
        fontFamily: "'JetBrains Mono', monospace",
        whiteSpace: 'nowrap' as const,
      }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: t.borderLight }} />
    </div>
  );
}

// --- Event Row ---
function EventRow({ event, isSelected, onSelect }: {
  event: EoEvent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { theme: t } = useTheme();
  const agentType = getAgentType(event.agent);
  const agentName = getAgentName(event.agent);
  const level = event.level ?? 1;
  const summary = operandSummary(event.op, event.operand);
  const opColor = OP_COLORS[event.op] || OP_COLORS.NUL;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'stretch', cursor: 'pointer',
        background: isSelected ? t.bgActive : hovered ? t.bgHover : 'transparent',
        borderBottom: `1px solid ${t.borderLight}`,
        transition: 'background 0.1s',
        position: 'relative' as const,
      }}
    >
      {/* Left color accent */}
      <div style={{
        width: 3, flexShrink: 0,
        background: isSelected ? opColor.border : `${opColor.border}40`,
        borderRadius: '0 2px 2px 0',
        transition: 'background 0.15s',
      }} />

      {/* Main content */}
      <div style={{
        flex: 1, padding: '10px 16px 10px 14px',
        display: 'flex', flexDirection: 'column' as const, gap: 3,
        minWidth: 0,
      }}>
        {/* Top row: seq, op, target */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
        }}>
          <span style={{
            fontSize: 10, color: t.textMuted, fontFamily: "'JetBrains Mono', monospace",
            flexShrink: 0, width: 32, textAlign: 'right' as const,
          }}>{event.seq}</span>
          <OpBadge op={event.op} />
          <LevelBadge level={level} />
          {event.op === 'NUL' && (event.resolution || event.nul_state) && (
            <NulStateBadge
              resolution={event.resolution ?? (event.nul_state ? nulStateToResolution(event.nul_state) : 'unspecified')}
            />
          )}
          <span style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5,
            color: t.accent, overflow: 'hidden' as const,
            textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const,
            flex: 1, minWidth: 0,
          }}>
            {event.target}
          </span>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
            marginLeft: 8,
          }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              color: agentType === 'system' ? t.warning : t.textSecondary,
              fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
            }}>
              {AGENT_ICONS[agentType]}
              <span>{agentName}</span>
            </span>
            <span
              title={formatFullTime(event.ts)}
              style={{
                fontSize: 10, color: t.textMuted,
                fontFamily: "'JetBrains Mono', monospace",
                whiteSpace: 'nowrap' as const,
                minWidth: 48, textAlign: 'right' as const,
              }}
            >
              {formatRelativeTime(event.ts)}
            </span>
          </div>
        </div>

        {/* Bottom row: operand summary */}
        {summary && (
          <div style={{
            fontSize: 10.5, color: t.textMuted,
            fontFamily: "'JetBrains Mono', monospace",
            overflow: 'hidden' as const,
            textOverflow: 'ellipsis' as const,
            whiteSpace: 'nowrap' as const,
            paddingLeft: 40,
            lineHeight: 1.3,
          }}>
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Main LogView ---
export function LogView({ targetFilter }: { targetFilter?: string | null }) {
  const recentEvents = useEoStore((s) => s.recentEvents);
  const { theme: t } = useTheme();
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [selectedEvent, setSelectedEvent] = useState<EoEvent | null>(null);
  const [searchText, setSearchText] = useState('');
  const [visibleCount, setVisibleCount] = useState(50);
  const [systemOnly, setSystemOnly] = useState(false);
  const [agentFilter, setAgentFilter] = useState<string>('');

  // When the scope changes, op filters that made sense in the old scope may
  // produce zero results in the new one.  Reset them so the view never lands
  // in a "No matching events" dead-end solely because of a stale filter.
  useEffect(() => {
    setActiveFilters(new Set());
  }, [targetFilter]);

  // Events pre-filtered by scope (targetFilter only).  Used for StatsBar
  // counts so the chips reflect what is actually available in the current
  // scope, not in the entire log.
  const scopeFiltered = useMemo(() => {
    if (!targetFilter) return recentEvents;
    return recentEvents.filter((e) => e.target.startsWith(targetFilter));
  }, [recentEvents, targetFilter]);

  // Unique agents for the agent filter dropdown
  const uniqueAgents = useMemo(() => {
    const agents = new Set<string>();
    for (const e of recentEvents) agents.add(getAgentName(e.agent));
    return Array.from(agents).sort();
  }, [recentEvents]);

  // Filtered events (newest first)
  const filtered = useMemo(() => {
    const sorted = [...recentEvents].reverse();
    return sorted.filter((e) => {
      if (activeFilters.size > 0 && !activeFilters.has(e.op)) return false;
      if (targetFilter && !e.target.startsWith(targetFilter)) return false;
      if (systemOnly && e.agent !== 'system' && (e.level ?? 1) < 2) return false;
      if (agentFilter && getAgentName(e.agent) !== agentFilter) return false;
      if (searchText) {
        const q = searchText.toLowerCase();
        const inTarget = e.target.toLowerCase().includes(q);
        const inAgent = getAgentName(e.agent).toLowerCase().includes(q);
        const inOp = e.op.toLowerCase().includes(q);
        const inOperand = e.operand ? JSON.stringify(e.operand).toLowerCase().includes(q) : false;
        if (!inTarget && !inAgent && !inOp && !inOperand) return false;
      }
      return true;
    });
  }, [recentEvents, activeFilters, searchText, targetFilter, systemOnly, agentFilter]);

  const visible = filtered.slice(0, visibleCount);

  function toggleFilter(op: string) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(op)) next.delete(op);
      else next.add(op);
      return next;
    });
  }

  // Group visible events by time
  const groupedEvents = useMemo(() => {
    const groups: { label: string; events: EoEvent[] }[] = [];
    let currentLabel = '';
    for (const e of visible) {
      const label = getTimeGroup(e.ts);
      if (label !== currentLabel) {
        groups.push({ label, events: [e] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].events.push(e);
      }
    }
    return groups;
  }, [visible]);

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, minWidth: 0, background: t.bgCard }}>
        {/* Header */}
        <div style={{
          padding: '14px 20px 0 20px', flexShrink: 0,
          borderBottom: `1px solid ${t.border}`,
        }}>
          {/* Title row */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: t.textHeading }}>Event log</span>
              <span style={{
                fontSize: 11, color: t.textMuted, background: t.bgMuted,
                padding: '2px 8px', borderRadius: 10,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {filtered.length}{filtered.length !== scopeFiltered.length ? ` / ${scopeFiltered.length}` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* Search */}
              <div style={{ position: 'relative' as const }}>
                <input
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Search events…"
                  style={{
                    width: 180, height: 28, fontSize: 11,
                    padding: '0 8px 0 28px', color: t.text,
                    border: `1px solid ${searchText ? t.accent + '60' : t.border}`,
                    borderRadius: 6, background: t.bg,
                    outline: 'none', fontFamily: "'JetBrains Mono', monospace",
                    transition: 'border-color 0.15s',
                  }}
                />
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{
                  position: 'absolute' as const, left: 8, top: 7.5,
                  color: searchText ? t.accent : t.textMuted,
                }}>
                  <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M9 9l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
              </div>

              {/* Agent filter */}
              <select
                value={agentFilter}
                onChange={(e) => setAgentFilter(e.target.value)}
                style={{
                  height: 28, fontSize: 11, padding: '0 6px',
                  color: agentFilter ? t.text : t.textMuted,
                  border: `1px solid ${agentFilter ? t.accent + '60' : t.border}`,
                  borderRadius: 6, background: t.bg,
                  fontFamily: "'JetBrains Mono', monospace",
                  cursor: 'pointer', outline: 'none',
                }}
              >
                <option value="">All agents</option>
                {uniqueAgents.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>

              {/* System toggle */}
              <button
                onClick={() => setSystemOnly(!systemOnly)}
                style={{
                  padding: '4px 10px', height: 28, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${systemOnly ? 'rgba(239,68,68,0.3)' : t.border}`,
                  borderRadius: 6,
                  background: systemOnly ? 'rgba(239,68,68,0.1)' : t.bg,
                  color: systemOnly ? '#ef4444' : t.textMuted,
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                  transition: 'all 0.1s',
                }}
              >
                SYS
              </button>

              {/* Clear filters */}
              {(activeFilters.size > 0 || searchText || agentFilter || systemOnly) && (
                <button
                  onClick={() => {
                    setActiveFilters(new Set());
                    setSearchText('');
                    setAgentFilter('');
                    setSystemOnly(false);
                  }}
                  style={{
                    padding: '4px 8px', height: 28, fontSize: 10,
                    border: `1px solid ${t.border}`, borderRadius: 6,
                    background: 'transparent', color: t.textMuted,
                    cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace",
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Stats bar + op chips */}
          <StatsBar
            events={scopeFiltered}
            activeFilters={activeFilters}
            onToggleFilter={toggleFilter}
          />
          <div style={{ height: 12 }} />
        </div>

        {/* Event list */}
        <div style={{ flex: 1, overflowY: 'auto' as const }}>
          {visible.length === 0 ? (
            <div style={{
              padding: '60px 20px', textAlign: 'center' as const,
              display: 'flex', flexDirection: 'column' as const,
              alignItems: 'center', gap: 8,
            }}>
              {recentEvents.length === 0 ? (
                <>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ color: t.textMuted, opacity: 0.4 }}>
                    <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <div style={{ fontSize: 12, color: t.textMuted, fontWeight: 500 }}>No events yet</div>
                  <div style={{ fontSize: 11, color: t.textMuted, opacity: 0.7, maxWidth: 260, lineHeight: 1.5 }}>
                    Use <span style={{ color: t.accent }}>Compose</span> to create your first event, or <span style={{ color: t.accent }}>Import</span> to load data.
                  </div>
                </>
              ) : (
                <>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ color: t.textMuted, opacity: 0.4 }}>
                    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.5"/>
                    <path d="M16 16l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  <div style={{ fontSize: 12, color: t.textMuted, fontWeight: 500 }}>No matching events</div>
                  <div style={{ fontSize: 11, color: t.textMuted, opacity: 0.7, lineHeight: 1.5 }}>
                    Try adjusting your filters or search query.
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {groupedEvents.map((group) => (
                <div key={group.label}>
                  <TimeGroupDivider label={group.label} />
                  {group.events.map((event) => (
                    <EventRow
                      key={event.seq}
                      event={event}
                      isSelected={selectedEvent?.seq === event.seq}
                      onSelect={() => setSelectedEvent(
                        selectedEvent?.seq === event.seq ? null : event
                      )}
                    />
                  ))}
                </div>
              ))}

              {/* Pagination */}
              {filtered.length > visibleCount && (
                <div style={{
                  padding: '16px 20px', textAlign: 'center' as const,
                }}>
                  <button
                    onClick={() => setVisibleCount((c) => c + 50)}
                    style={{
                      padding: '6px 16px', fontSize: 11,
                      border: `1px solid ${t.border}`, borderRadius: 6,
                      background: 'transparent', color: t.accent, cursor: 'pointer',
                      fontFamily: "'JetBrains Mono', monospace", fontWeight: 500,
                    }}
                  >
                    Load more ({filtered.length - visibleCount} remaining)
                  </button>
                </div>
              )}

              {/* Footer count */}
              <div style={{
                padding: '8px 20px 16px', textAlign: 'center' as const,
                fontSize: 10, color: t.textMuted,
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {Math.min(visibleCount, filtered.length)} of {filtered.length} events
              </div>
            </>
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
