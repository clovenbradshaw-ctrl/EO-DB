/**
 * ResolutionPolicyComposer — 3×3 grid for composing EVA resolution policies.
 *
 * Uses the Resolution face (Mode × Object):
 *   Rows: Differentiating / Relating / Generating
 *   Cols: Ground / Figure / Pattern
 *
 * Policies are compositions of stances, not single selections.
 * Composition type is derived from the stances array:
 *   Same Mode row  →  parallel
 *   Different rows with order  →  fallback
 *   Cultivating present alongside anything  →  parallel_background
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import { useTheme, type Theme } from '../theme';
import type { Resolution } from '../db/types';

// Identity color for the resolution composer — distinguishes it visually from
// the Constraint composer, which uses a green identity bar.
const RESOLUTION_IDENTITY_COLOR = '#6B21A8';

// Width (px) below which the grid switches to compact mode — description and
// example text move out of each cell and into a single detail strip.
const COMPACT_WIDTH_THRESHOLD = 560;

// ─── Types ──────────────────────────────────────────────────────────────

export interface StanceEntry {
  /**
   * Canonical titlecase resolution stance from the shared lattice taxonomy
   * in db/types.ts. The `'unspecified'` value is nominally allowed by the
   * Resolution union but the UI never produces it — STANCES only holds the
   * nine authored stances. Persisted legacy policies that were written with
   * lowercase keys (pre-A.6/2) are normalized by normalizeResolvePolicy at
   * the deserialization boundary.
   */
  stance: Resolution;
  subType?: string;
  formula?: string;
  order?: number;
}

export interface ResolvePolicy {
  stances: StanceEntry[];
}

// ─── Stance Definitions ─────────────────────────────────────────────────

interface StanceDef {
  key: Resolution;
  name: string;
  cell: string;        // e.g. "Diff × Ground"
  description: string;
  example: string;     // concrete usage example
  output: string;       // output tag text
  outputColor: string;  // tag color
  row: 'diff' | 'relate' | 'gen';
  col: 'ground' | 'figure' | 'pattern';
  gpu?: boolean;        // GPU-acceleratable
  hasSubTypes?: boolean;
  hasFormula?: boolean;
}

const STANCES: StanceDef[] = [
  // ── Differentiating ──
  {
    key: 'Clearing', name: 'Clearing', cell: 'Diff × Ground',
    description: 'Neither value wins. Conflict voids the field entirely.',
    example: '"status": ["active", "archived"] → null',
    output: '→ null', outputColor: '#7a756d',
    row: 'diff', col: 'ground',
  },
  {
    key: 'Dissecting', name: 'Dissecting', cell: 'Diff × Figure',
    description: 'One value selected by explicit rule. All picker strategies live here.',
    example: '"price": [9.99, 12.99] → pick latest write → 12.99',
    output: '→ one value by rule', outputColor: '#9A3412',
    row: 'diff', col: 'figure', hasSubTypes: true,
  },
  {
    key: 'Unraveling', name: 'Unraveling', cell: 'Diff × Pattern',
    description: 'No value returned. The pattern of disagreement is the output — who conflicts, how often.',
    example: '"region": EU vs US → {sources: 2, diverged_at: "2024-03"}',
    output: '→ conflict structure', outputColor: '#6B21A8',
    row: 'diff', col: 'pattern', gpu: true,
  },
  // ── Relating ──
  {
    key: 'Tending', name: 'Tending', cell: 'Relate × Ground',
    description: 'Return last uncontested value. Hold pre-conflict ground while conflict sits in the log.',
    example: '"email" was "a@b.com" before fork → returns "a@b.com"',
    output: '→ pre-conflict value', outputColor: '#166534',
    row: 'relate', col: 'ground',
  },
  {
    key: 'Binding', name: 'Binding', cell: 'Relate × Figure',
    description: 'All values returned with full provenance. The conflict itself is the datum — no scalar.',
    example: '"name" → {A: "Jon", B: "John", sources: […]}',
    output: '→ structured conflict', outputColor: '#1E40AF',
    row: 'relate', col: 'figure',
  },
  {
    key: 'Tracing', name: 'Tracing', cell: 'Relate × Pattern',
    description: 'Follow the historical resolution pattern. Precedent on this path determines the output.',
    example: '"priority" → resolved same way as last 5 conflicts on this path',
    output: '→ precedent-based', outputColor: '#115E59',
    row: 'relate', col: 'pattern', gpu: true,
  },
  // ── Generating ──
  {
    key: 'Cultivating', name: 'Cultivating', cell: 'Gen × Ground',
    description: 'No value returned. A review workflow is triggered — creates conditions for resolution.',
    example: '"owner" conflict → queued for human arbitration',
    output: '→ workflow triggered', outputColor: '#92400E',
    row: 'gen', col: 'ground',
  },
  {
    key: 'Making', name: 'Making', cell: 'Gen × Figure',
    description: 'New value computed from conflicting values — average, merge, consensus. Not in either source.',
    example: '"score": [88, 92] → AVERAGE(88, 92) = 90',
    output: '→ new computed value', outputColor: '#3730A3',
    row: 'gen', col: 'figure', hasFormula: true,
  },
  {
    key: 'Composing', name: 'Composing', cell: 'Gen × Pattern',
    description: 'New policy written for this conflict class. Future conflicts of this class auto-resolve.',
    example: 'recurring "currency" conflict → writes: prefer reporting currency',
    output: '→ new policy written', outputColor: '#9D174D',
    row: 'gen', col: 'pattern', gpu: true,
  },
];

// Dissecting sub-types — two kinds of selection criteria.
const DISSECTING_SUBTYPES = [
  // Provenance-based (pick by who/when):
  { value: 'latest', label: 'Latest', group: 'provenance', description: 'Pick the most recently written value.', example: '"updated_at": [T+2, T+5] → pick T+5' },
  { value: 'first', label: 'First', group: 'provenance', description: 'Pick the value that arrived first.', example: '"created_by": [SrcA@T+1, SrcB@T+3] → pick SrcA' },
  { value: 'priority', label: 'Priority', group: 'provenance', description: 'Pick from the highest-priority source.', example: '"tier": CRM=2, ERP=1 → pick CRM value' },
  // Quality-based (pick by data fitness):
  { value: 'type_validity', label: 'Type validity', group: 'quality', description: 'Pick the value that matches the declared field type.', example: '"count": ["five", 5] → pick 5 (integer)' },
  { value: 'referential_integrity', label: 'Referential integrity', group: 'quality', description: 'Pick the value whose foreign key exists in the target table.', example: '"dept_id": [42, 999] → 42 exists in depts table → pick 42' },
] as const;

const ROW_LABELS: Record<string, { label: string; subtitle: string }> = {
  diff: { label: 'Differentiating', subtitle: 'cuts to less' },
  relate: { label: 'Relating', subtitle: 'maintains connection' },
  gen: { label: 'Generating', subtitle: 'produces something new' },
};

const COL_LABELS: Record<string, { label: string; subtitle: string }> = {
  ground: { label: 'Ground', subtitle: 'ambient condition' },
  figure: { label: 'Figure', subtitle: 'specific value' },
  pattern: { label: 'Pattern', subtitle: 'recurring structure' },
};

const ROWS = ['diff', 'relate', 'gen'] as const;
const COLS = ['ground', 'figure', 'pattern'] as const;

// ─── Composition Derivation ─────────────────────────────────────────────

export function deriveCompositionType(stances: StanceEntry[]): string {
  if (stances.length <= 1) return 'single';
  const hasCultivating = stances.some(s => s.stance === 'Cultivating');
  const rows = new Set(stances.map(s => STANCES.find(d => d.key === s.stance)?.row));
  if (hasCultivating && stances.length > 1) return 'parallel_background';
  if (rows.size === 1) return 'parallel';
  return 'fallback';
}

export function summarizePolicy(policy: ResolvePolicy | null): string {
  if (!policy || policy.stances.length === 0) return '—';
  const names = policy.stances.map(s => {
    const def = STANCES.find(d => d.key === s.stance);
    const name = def?.name ?? s.stance;
    if (s.subType) return `${name} (${s.subType})`;
    return name;
  });
  const comp = deriveCompositionType(policy.stances);
  if (comp === 'fallback') return names.join(' → ');
  if (comp === 'parallel_background') return names.join(' + ');
  if (comp === 'parallel') return names.join(' + ');
  return names[0];
}

// ─── Resolution policy normalization ────────────────────────────────────

/**
 * Lowercase → titlecase map for legacy StanceEntry.stance values written
 * before Phase A.6/2. Persisted policies predate the rename and use keys
 * like `'clearing'`; the composer and the lattice both use `'Clearing'`.
 * This map is the single migration surface — add a new key here if a
 * further case-sensitivity drift ever ships.
 */
const LEGACY_STANCE_TO_RESOLUTION: Record<string, Resolution> = {
  clearing: 'Clearing',
  dissecting: 'Dissecting',
  unraveling: 'Unraveling',
  tending: 'Tending',
  binding: 'Binding',
  tracing: 'Tracing',
  cultivating: 'Cultivating',
  making: 'Making',
  composing: 'Composing',
};

/**
 * Titlecase resolution values the composer recognizes. Derived from STANCES
 * so this stays in sync with the grid as new stances are added.
 */
const VALID_RESOLUTIONS: ReadonlySet<Resolution> = new Set(STANCES.map(s => s.key));

function normalizeStanceKey(raw: unknown): Resolution | null {
  if (typeof raw !== 'string') return null;
  if (VALID_RESOLUTIONS.has(raw as Resolution)) return raw as Resolution;
  const migrated = LEGACY_STANCE_TO_RESOLUTION[raw];
  return migrated ?? null;
}

/**
 * Take raw `fs.resolve.value` off a persisted FieldSchema and return a
 * ResolvePolicy the composer can consume, or null if the input is not a
 * recognizable policy shape.
 *
 * Handles two legacy shapes plus the canonical shape:
 *
 *   1. `{ strategy: 'latest' }`           — pre-composer single-strategy
 *                                           form. Converted to a one-entry
 *                                           Dissecting policy carrying the
 *                                           strategy name as subType.
 *   2. `{ stances: [{ stance: 'clearing', ... }] }` — lowercase-keyed
 *                                           policy from before A.6/2.
 *                                           Each stance is mapped to its
 *                                           titlecase counterpart; entries
 *                                           whose stance cannot be mapped
 *                                           are dropped.
 *   3. `{ stances: [{ stance: 'Clearing', ... }] }` — canonical form.
 *                                           Passes through unchanged
 *                                           (still validated so junk is
 *                                           filtered out).
 *
 * Unknown shapes, null / undefined, and empty `{ stances: [] }` all return
 * null so consumers can treat "no policy" as a single case.
 */
export function normalizeResolvePolicy(raw: unknown): ResolvePolicy | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as { stances?: unknown; strategy?: unknown };

  // Legacy single-strategy shape.
  if (!obj.stances && typeof obj.strategy === 'string') {
    return {
      stances: [{ stance: 'Dissecting', subType: obj.strategy }],
    };
  }

  if (!Array.isArray(obj.stances)) return null;

  const normalized: StanceEntry[] = [];
  for (const rawEntry of obj.stances) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as {
      stance?: unknown;
      subType?: unknown;
      formula?: unknown;
      order?: unknown;
    };
    const stance = normalizeStanceKey(entry.stance);
    if (!stance) continue;
    const out: StanceEntry = { stance };
    if (typeof entry.subType === 'string') out.subType = entry.subType;
    if (typeof entry.formula === 'string') out.formula = entry.formula;
    if (typeof entry.order === 'number') out.order = entry.order;
    normalized.push(out);
  }

  if (normalized.length === 0) return null;
  return { stances: normalized };
}

// ─── GPU check ──────────────────────────────────────────────────────────

function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

// ─── Component ──────────────────────────────────────────────────────────

interface ResolutionPolicyComposerProps {
  currentPolicy: ResolvePolicy | null;
  onApply: (policy: ResolvePolicy) => void;
  onClear: () => void;
  onClose: () => void;
  /** When true, renders without popup container styling (no shadow/border/minWidth). */
  embedded?: boolean;
  /** Field key this policy applies to — used for contextual labeling when embedded. */
  fieldKey?: string;
}

export function ResolutionPolicyComposer({
  currentPolicy,
  onApply,
  onClear,
  onClose,
  embedded,
  fieldKey,
}: ResolutionPolicyComposerProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const s = makeStyles(theme, embedded, compact);
  const gpuAvailable = useMemo(hasWebGPU, []);
  const [hoverCell, setHoverCell] = useState<Resolution | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCompact(entry.contentRect.width < COMPACT_WIDTH_THRESHOLD);
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Local editing state — initialize from currentPolicy. If the caller
  // forgot to normalize a legacy policy on the way in, normalize here so
  // the composer renders it correctly regardless. Idempotent on already-
  // normalized inputs.
  const [selected, setSelected] = useState<Map<Resolution, StanceEntry>>(() => {
    const m = new Map<Resolution, StanceEntry>();
    const normalized = normalizeResolvePolicy(currentPolicy);
    if (normalized) {
      for (const entry of normalized.stances) {
        m.set(entry.stance, entry);
      }
    }
    return m;
  });

  // Dissecting sub-type state
  const [dissectingSubType, setDissectingSubType] = useState<string>(
    currentPolicy?.stances.find(s => s.stance === 'Dissecting')?.subType ?? 'latest'
  );

  // Making formula state
  const [makingFormula, setMakingFormula] = useState<string>(
    currentPolicy?.stances.find(s => s.stance === 'Making')?.formula ?? ''
  );

  function toggleStance(key: Resolution) {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        const entry: StanceEntry = { stance: key };
        if (key === 'Dissecting') entry.subType = dissectingSubType;
        if (key === 'Making' && makingFormula) entry.formula = makingFormula;
        // Assign order for cross-mode fallback
        entry.order = next.size;
        next.set(key, entry);
      }
      return next;
    });
  }

  function handleApply() {
    // Update dissecting/making entries with latest values before applying
    const stances = Array.from(selected.values()).map(entry => {
      if (entry.stance === 'Dissecting') return { ...entry, subType: dissectingSubType };
      if (entry.stance === 'Making') return { ...entry, formula: makingFormula };
      return entry;
    });
    // Sort by order for deterministic fallback chains
    stances.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    onApply({ stances });
  }

  const compositionType = deriveCompositionType(Array.from(selected.values()));
  const stanceCount = selected.size;
  const isDissectingSelected = selected.has('Dissecting');
  const isMakingSelected = selected.has('Making');

  // Cell whose details the strip should show — prefer a hovered cell (fresh
  // intent) over any currently selected one, since selections already show as
  // highlighted tiles.
  const focusedKey: Resolution | null =
    hoverCell ?? (selected.size > 0 ? Array.from(selected.keys())[selected.size - 1] : null);
  const focusedDef = focusedKey ? STANCES.find(st => st.key === focusedKey) : null;

  return (
    <div ref={containerRef} style={embedded ? { padding: '0 16px 8px' } : s.container}>
      {/* Identity bar — distinguishes this composer from the Constraint one */}
      <div style={s.identityBar} />

      {/* Header — hidden when embedded (panel provides its own header) */}
      {!embedded && (
        <div style={s.header}>
          <span style={s.title}>⊨ RESOLUTION POLICY</span>
          <button style={s.closeBtn} onClick={onClose}>&times;</button>
        </div>
      )}

      <div style={s.subtitle}>
        Select one or more stances to compose a resolution policy{fieldKey ? ` for ${fieldKey}` : ''}.
      </div>

      {/* Detail strip — replaces in-cell description/example in compact mode. */}
      {compact && (
        <div
          style={{
            ...s.detailStrip,
            borderLeftColor: focusedDef?.outputColor ?? theme.borderLight,
            opacity: focusedDef ? 1 : 0.6,
          }}
        >
          {focusedDef ? (
            <>
              <div style={s.detailStripHead}>
                <span style={s.detailStripCell}>{focusedDef.cell}</span>
                <span style={{ ...s.detailStripName, color: focusedDef.outputColor }}>
                  {focusedDef.name}
                </span>
                <span style={{
                  ...s.detailStripOutput,
                  background: `${focusedDef.outputColor}18`,
                  color: focusedDef.outputColor,
                }}>
                  {focusedDef.output}
                </span>
              </div>
              <div style={s.detailStripDesc}>{focusedDef.description}</div>
              <div style={s.detailStripExample}>{focusedDef.example}</div>
            </>
          ) : (
            <div style={s.detailStripDesc}>Hover or tap a cell to see what it does.</div>
          )}
        </div>
      )}

      {/* Column headers */}
      <div style={s.gridContainer}>
        <div style={s.colHeaders}>
          <div style={s.rowLabelSpacer} />
          {COLS.map(col => (
            <div key={col} style={s.colHeader}>
              <span style={s.colHeaderLabel}>{COL_LABELS[col].label}</span>
              <span style={s.colHeaderSub}>{COL_LABELS[col].subtitle}</span>
            </div>
          ))}
        </div>

        {/* Grid rows */}
        {ROWS.map(row => (
          <div key={row} style={s.gridRow}>
            <div style={s.rowLabel}>
              <span style={s.rowLabelText}>{ROW_LABELS[row].label}</span>
              {!compact && (
                <span style={s.rowLabelSub}>{ROW_LABELS[row].subtitle}</span>
              )}
            </div>
            {COLS.map(col => {
              const stance = STANCES.find(st => st.row === row && st.col === col)!;
              const isSelected = selected.has(stance.key);
              return (
                <button
                  key={stance.key}
                  style={{
                    ...s.cell,
                    background: isSelected ? `${stance.outputColor}10` : theme.bgCard,
                    borderColor: isSelected ? stance.outputColor : theme.borderLight,
                  }}
                  onClick={() => toggleStance(stance.key)}
                  onMouseEnter={e => {
                    setHoverCell(stance.key);
                    if (!isSelected) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
                  }}
                  onMouseLeave={e => {
                    setHoverCell(null);
                    if (!isSelected) (e.currentTarget as HTMLElement).style.background = theme.bgCard;
                  }}
                >
                  <div style={s.cellLabel}>{stance.cell}</div>
                  <div style={{ ...s.cellName, color: isSelected ? stance.outputColor : theme.textHeading }}>
                    {stance.name}
                  </div>
                  {!compact && (
                    <>
                      <div style={s.cellDesc}>{stance.description}</div>
                      <div style={s.cellExample}>{stance.example}</div>
                    </>
                  )}
                  <div style={s.cellOutputRow}>
                    <span style={{
                      ...s.outputTag,
                      background: `${stance.outputColor}18`,
                      color: stance.outputColor,
                    }}>
                      {stance.output}
                    </span>
                    {/* GPU badge — informational only, does not gate selection */}
                    {stance.gpu && gpuAvailable && (
                      <span style={s.gpuBadge}>GPU</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Dissecting sub-type selector */}
      {isDissectingSelected && (
        <div style={s.subPanel}>
          <div style={s.subPanelLabel}>Dissecting rule</div>
          <div style={s.subTypeGroup}>
            <span style={s.subTypeGroupLabel}>Provenance</span>
            {DISSECTING_SUBTYPES.filter(st => st.group === 'provenance').map(st => (
              <button
                key={st.value}
                style={{
                  ...s.subTypeBtn,
                  background: dissectingSubType === st.value ? `${theme.accent}15` : 'transparent',
                  borderColor: dissectingSubType === st.value ? theme.accent : 'transparent',
                }}
                onClick={() => setDissectingSubType(st.value)}
              >
                {st.label}
              </button>
            ))}
          </div>
          <div style={s.subTypeGroup}>
            <span style={s.subTypeGroupLabel}>Quality</span>
            {DISSECTING_SUBTYPES.filter(st => st.group === 'quality').map(st => (
              <button
                key={st.value}
                style={{
                  ...s.subTypeBtn,
                  background: dissectingSubType === st.value ? `${theme.accent}15` : 'transparent',
                  borderColor: dissectingSubType === st.value ? theme.accent : 'transparent',
                }}
                onClick={() => setDissectingSubType(st.value)}
              >
                {st.label}
              </button>
            ))}
          </div>
          {(() => {
            const active = DISSECTING_SUBTYPES.find(st => st.value === dissectingSubType);
            return active ? (
              <div style={s.subTypeHint}>
                <span style={s.subTypeHintDesc}>{active.description}</span>
                <span style={s.subTypeHintExample}>{active.example}</span>
              </div>
            ) : null;
          })()}
        </div>
      )}

      {/* Making formula input */}
      {isMakingSelected && (
        <div style={s.subPanel}>
          <div style={s.subPanelLabel}>Making formula</div>
          <input
            style={s.formulaInput}
            value={makingFormula}
            onChange={e => setMakingFormula(e.target.value)}
            placeholder="e.g. AVERAGE(a, b) or UNION(a, b)"
          />
        </div>
      )}

      {/* Policy output summary */}
      <div style={s.policyOutput}>
        <div style={s.policyOutputLabel}>POLICY OUTPUT</div>
        {stanceCount === 0 ? (
          <div style={s.policyOutputEmpty}>Select cells above to compose a resolution policy.</div>
        ) : (
          <div style={s.policyOutputSummary}>
            <span style={s.compositionBadge}>{compositionType}</span>
            <span>{summarizePolicy({ stances: Array.from(selected.values()) })}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={s.actions}>
        {stanceCount > 0 && (
          <button style={s.applyBtn} onClick={handleApply}>
            Apply policy
          </button>
        )}
        {currentPolicy && currentPolicy.stances.length > 0 && (
          <button style={s.clearBtn} onClick={onClear}>
            Clear policy
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────

function makeStyles(t: Theme, embedded?: boolean, compact?: boolean): Record<string, React.CSSProperties> {
  const labelW = compact ? 0 : embedded ? 72 : 90;
  return {
    container: {
      padding: 16,
      minWidth: compact ? 280 : 640,
      maxWidth: 780,
      maxHeight: '80vh',
      overflowY: 'auto',
      background: t.bg,
      borderRadius: 12,
      border: `1px solid ${t.border}`,
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
    },
    identityBar: {
      height: 3,
      background: RESOLUTION_IDENTITY_COLOR,
      borderRadius: 2,
      marginBottom: 10,
    },
    detailStrip: {
      padding: '8px 10px',
      marginBottom: 10,
      background: t.bgMuted,
      borderRadius: 6,
      borderLeft: '3px solid',
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 3,
      transition: 'border-left-color 0.15s, opacity 0.15s',
    },
    detailStripHead: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      flexWrap: 'wrap' as const,
    },
    detailStripCell: {
      fontSize: 9,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    detailStripName: {
      fontSize: 13,
      fontWeight: 600,
    },
    detailStripOutput: {
      fontSize: 10,
      fontWeight: 500,
      padding: '1px 7px',
      borderRadius: 10,
      fontFamily: "'JetBrains Mono', monospace",
    },
    detailStripDesc: {
      fontSize: 11,
      color: t.textSecondary,
      lineHeight: 1.35,
    },
    detailStripExample: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    title: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 18,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 2px',
      lineHeight: 1,
    },
    subtitle: {
      fontSize: 11,
      color: t.textSecondary,
      marginBottom: 12,
    },
    gridContainer: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
    },
    colHeaders: {
      display: 'grid',
      gridTemplateColumns: compact ? '1fr 1fr 1fr' : `${labelW}px 1fr 1fr 1fr`,
      gap: 6,
      marginBottom: 2,
    },
    rowLabelSpacer: { width: labelW, display: compact ? 'none' : 'block' },
    colHeader: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 1,
    },
    colHeaderLabel: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textHeading,
    },
    colHeaderSub: {
      fontSize: 9,
      color: t.textMuted,
      fontStyle: 'italic',
    },
    gridRow: {
      display: 'grid',
      gridTemplateColumns: compact ? '1fr 1fr 1fr' : `${labelW}px 1fr 1fr 1fr`,
      gap: 6,
    },
    rowLabel: {
      display: compact ? 'none' : 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'flex-end',
      paddingRight: 8,
    },
    rowLabelText: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textHeading,
    },
    rowLabelSub: {
      fontSize: 9,
      color: t.textMuted,
      fontStyle: 'italic',
      textAlign: 'right' as const,
    },
    cell: {
      display: 'flex',
      flexDirection: 'column',
      gap: compact ? 2 : 4,
      padding: compact ? '6px 8px' : '10px 12px',
      border: '1px solid',
      borderRadius: 8,
      cursor: 'pointer',
      textAlign: 'left' as const,
      fontFamily: 'inherit',
      transition: 'background 0.1s, border-color 0.15s',
      minHeight: compact ? 60 : 100,
    },
    cellLabel: {
      fontSize: 9,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    cellName: {
      fontSize: 14,
      fontWeight: 600,
      lineHeight: 1.2,
    },
    cellDesc: {
      fontSize: 11,
      color: t.textSecondary,
      lineHeight: 1.35,
      flex: 1,
    },
    cellExample: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      lineHeight: 1.3,
      opacity: 0.8,
    },
    cellOutputRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 4,
    },
    outputTag: {
      fontSize: 10,
      fontWeight: 500,
      padding: '2px 8px',
      borderRadius: 10,
      fontFamily: "'JetBrains Mono', monospace",
    },
    gpuBadge: {
      fontSize: 8,
      fontWeight: 700,
      padding: '1px 5px',
      borderRadius: 4,
      background: '#10B98115',
      color: '#10B981',
      letterSpacing: '0.06em',
      fontFamily: "'JetBrains Mono', monospace",
    },
    subPanel: {
      marginTop: 10,
      padding: '10px 12px',
      background: t.bgMuted,
      borderRadius: 8,
      border: `1px solid ${t.borderLight}`,
    },
    subPanelLabel: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      marginBottom: 6,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      fontFamily: "'JetBrains Mono', monospace",
    },
    subTypeGroup: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      marginBottom: 4,
    },
    subTypeGroupLabel: {
      fontSize: 9,
      fontWeight: 500,
      color: t.textMuted,
      width: 72,
      flexShrink: 0,
      fontStyle: 'italic',
    },
    subTypeBtn: {
      fontSize: 11,
      padding: '3px 10px',
      border: '1px solid transparent',
      borderRadius: 5,
      cursor: 'pointer',
      fontFamily: 'inherit',
      color: t.text,
      background: 'transparent',
      transition: 'background 0.1s',
    },
    subTypeHint: {
      marginTop: 6,
      paddingTop: 6,
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 2,
    },
    subTypeHintDesc: {
      fontSize: 11,
      color: t.textSecondary,
    },
    subTypeHintExample: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    formulaInput: {
      width: '100%',
      padding: '6px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bg,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    policyOutput: {
      marginTop: 12,
      padding: '10px 14px',
      background: t.bgMuted,
      borderRadius: 8,
      border: `1px solid ${t.borderLight}`,
    },
    policyOutputLabel: {
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: t.textMuted,
      marginBottom: 6,
      fontFamily: "'JetBrains Mono', monospace",
    },
    policyOutputEmpty: {
      fontSize: 12,
      color: t.textMuted,
    },
    policyOutputSummary: {
      fontSize: 12,
      color: t.text,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    compositionBadge: {
      fontSize: 9,
      fontWeight: 600,
      padding: '2px 7px',
      borderRadius: 4,
      background: `${t.accent}15`,
      color: t.accent,
      fontFamily: "'JetBrains Mono', monospace",
    },
    actions: {
      display: 'flex',
      gap: 8,
      marginTop: 10,
    },
    applyBtn: {
      fontSize: 12,
      fontWeight: 500,
      padding: '6px 16px',
      borderRadius: 6,
      border: 'none',
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
    clearBtn: {
      fontSize: 11,
      padding: '5px 12px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: t.danger,
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
  };
}
