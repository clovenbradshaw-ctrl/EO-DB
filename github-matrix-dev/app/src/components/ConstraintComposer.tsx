/**
 * ConstraintComposer — 3×3 grid for composing schema constraints.
 *
 * Uses the Site face (Domain × Object):
 *   Rows: Existence / Structure / Significance
 *   Cols: Ground / Figure / Pattern
 *
 * A constraint validates and rejects — it never mutates or generates values.
 * Constraints compose naturally: each is its own DEF at its own target path,
 * individually addressable, auditable, and removable.
 *
 * Phase 1: Presence, Type, Cardinality, Immutability, Reference, Uniqueness
 * Phase 2 (deferred): Groundedness, Rule, Invariant (need expression editors)
 */

import { useState, useRef, useEffect } from 'react';
import { useTheme, type Theme } from '../theme';

// Identity color for the constraint composer — distinguishes it visually from
// the Resolution composer, which uses a different accent.
const CONSTRAINT_IDENTITY_COLOR = '#166534';

// Width (px) below which the grid switches to compact mode — description text
// moves out of each cell and into a single detail strip.
const COMPACT_WIDTH_THRESHOLD = 560;

// ─── Constraint Cell Definitions ────────────────────────────────────────

interface ConstraintCellDef {
  key: string;
  name: string;
  cell: string;
  description: string;
  row: 'existence' | 'structure' | 'significance';
  col: 'ground' | 'figure' | 'pattern';
  color: string;
  phase: 1 | 2;
  gpu?: boolean;
}

const CONSTRAINT_CELLS: ConstraintCellDef[] = [
  // ── Existence ──
  {
    key: 'presence', name: 'Presence', cell: 'Existence × Ground',
    description: 'Whether the field must exist. EO has three absence states: never-set, cleared, unknown.',
    row: 'existence', col: 'ground', color: '#166534', phase: 1,
  },
  {
    key: 'type', name: 'Type', cell: 'Existence × Figure',
    description: 'What kind of value is permitted. Range, format, enum, regex are all sub-types here.',
    row: 'existence', col: 'figure', color: '#3b82f6', phase: 1,
  },
  {
    key: 'cardinality', name: 'Cardinality', cell: 'Existence × Pattern',
    description: 'How many values can exist at this path. Min/max/exact count.',
    row: 'existence', col: 'pattern', color: '#9b59b6', phase: 1,
  },
  // ── Structure ──
  {
    key: 'immutability', name: 'Immutability', cell: 'Structure × Ground',
    description: 'No further DEFs permitted once set. Field is sealed. Correction path is REC.',
    row: 'structure', col: 'ground', color: '#92400E', phase: 1,
  },
  {
    key: 'reference', name: 'Reference', cell: 'Structure × Figure',
    description: 'Value must point to an existing record. Target must exist and may need specific attributes.',
    row: 'structure', col: 'figure', color: '#1E40AF', phase: 1,
  },
  {
    key: 'uniqueness', name: 'Uniqueness', cell: 'Structure × Pattern',
    description: 'Value must be singular across all instances of this path.',
    row: 'structure', col: 'pattern', color: '#115E59', phase: 1, gpu: true,
  },
  // ── Significance ──
  {
    key: 'groundedness', name: 'Groundedness', cell: 'Significance × Ground',
    description: 'Interpretive frame must be DEF\'d before Horizon returns the value. Returns ungrounded, not invalid.',
    row: 'significance', col: 'ground', color: '#6B21A8', phase: 2,
  },
  {
    key: 'rule', name: 'Rule', cell: 'Significance × Figure',
    description: 'Domain-specific condition evaluated against a specific value at a specific moment.',
    row: 'significance', col: 'figure', color: '#9D174D', phase: 2,
  },
  {
    key: 'invariant', name: 'Invariant', cell: 'Significance × Pattern',
    description: 'Relationship that must hold across the full lifetime of the record — never violated.',
    row: 'significance', col: 'pattern', color: '#DC2626', phase: 2, gpu: true,
  },
];

const ROW_LABELS: Record<string, { label: string; subtitle: string }> = {
  existence: { label: 'Existence', subtitle: 'does it exist correctly?' },
  structure: { label: 'Structure', subtitle: 'structural integrity' },
  significance: { label: 'Significance', subtitle: 'does it mean what it should?' },
};

const COL_LABELS: Record<string, { label: string; subtitle: string }> = {
  ground: { label: 'Ground', subtitle: 'ambient condition' },
  figure: { label: 'Figure', subtitle: 'specific value' },
  pattern: { label: 'Pattern', subtitle: 'recurring structure' },
};

const ROWS = ['existence', 'structure', 'significance'] as const;
const COLS = ['ground', 'figure', 'pattern'] as const;

// ─── Presence sub-types ─────────────────────────────────────────────────

const PRESENCE_RULES = [
  { value: 'required', label: 'Required' },
  { value: 'nullable', label: 'Nullable' },
  { value: 'conditionally_required', label: 'Conditional' },
] as const;

// ─── Type sub-types ─────────────────────────────────────────────────────

const TYPE_SUBTYPES = [
  { value: 'enum', label: 'Enum', placeholder: 'value1, value2, value3' },
  { value: 'format', label: 'Format', placeholder: '^[a-z]+@[a-z]+\\.[a-z]+$' },
  { value: 'range', label: 'Range', placeholder: '' },
] as const;

// ─── Uniqueness scopes ──────────────────────────────────────────────────

const UNIQUENESS_SCOPES = [
  { value: 'global', label: 'Global' },
  { value: 'scoped', label: 'Scoped' },
  { value: 'soft', label: 'Soft' },
  { value: 'composite', label: 'Composite' },
] as const;

// ─── Component ──────────────────────────────────────────────────────────

interface ConstraintComposerProps {
  fieldKey: string;
  existingConstraints: Array<{ name: string; value: any }>;
  onAdd: (name: string, value: any) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
  /** When true, renders without popup container styling (no shadow/border/minWidth). */
  embedded?: boolean;
}

export function ConstraintComposer({
  fieldKey,
  existingConstraints,
  onAdd,
  onRemove,
  onClose,
  embedded,
}: ConstraintComposerProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const s = makeStyles(theme, embedded, compact);

  const [activeCell, setActiveCell] = useState<string | null>(null);
  const [hoverCell, setHoverCell] = useState<string | null>(null);
  const existingSet = new Set(existingConstraints.map(c => c.name));

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

  // ─── Config state for each cell ──
  const [presenceRule, setPresenceRule] = useState<string>(
    existingConstraints.find(c => c.name === 'presence')?.value?.rule ?? 'required'
  );
  const [presenceCondition, setPresenceCondition] = useState<string>(
    existingConstraints.find(c => c.name === 'presence')?.value?.condition ?? ''
  );

  const [typeSubType, setTypeSubType] = useState<string>(
    existingConstraints.find(c => c.name === 'type')?.value?.subType ?? 'enum'
  );
  const [typeEnumValues, setTypeEnumValues] = useState<string>(
    (() => {
      const v = existingConstraints.find(c => c.name === 'type')?.value;
      if (v?.enum) return Array.isArray(v.enum) ? v.enum.join(', ') : String(v.enum);
      return '';
    })()
  );
  const [typeFormat, setTypeFormat] = useState<string>(
    existingConstraints.find(c => c.name === 'type')?.value?.format ?? ''
  );
  const [typeRangeMin, setTypeRangeMin] = useState<string>(
    existingConstraints.find(c => c.name === 'type')?.value?.gte?.toString() ?? ''
  );
  const [typeRangeMax, setTypeRangeMax] = useState<string>(
    existingConstraints.find(c => c.name === 'type')?.value?.lte?.toString() ?? ''
  );

  const [cardinalityMin, setCardinalityMin] = useState<string>(
    existingConstraints.find(c => c.name === 'cardinality')?.value?.min?.toString() ?? ''
  );
  const [cardinalityMax, setCardinalityMax] = useState<string>(
    existingConstraints.find(c => c.name === 'cardinality')?.value?.max?.toString() ?? ''
  );

  const [immutabilityCondition, setImmutabilityCondition] = useState<string>(
    existingConstraints.find(c => c.name === 'immutability')?.value?.condition ?? ''
  );

  const [referencePath, setReferencePath] = useState<string>(
    existingConstraints.find(c => c.name === 'reference')?.value?.target ?? ''
  );
  const [referenceAttributes, setReferenceAttributes] = useState<string>(
    existingConstraints.find(c => c.name === 'reference')?.value?.attributes ?? ''
  );

  const [uniquenessScope, setUniquenessScope] = useState<string>(
    existingConstraints.find(c => c.name === 'uniqueness')?.value?.scope ?? 'global'
  );
  const [uniquenessScopeField, setUniquenessScopeField] = useState<string>(
    existingConstraints.find(c => c.name === 'uniqueness')?.value?.scopeField ?? ''
  );

  function handleAddConstraint(cellKey: string) {
    switch (cellKey) {
      case 'presence': {
        const value: any = { rule: presenceRule };
        if (presenceRule === 'conditionally_required' && presenceCondition) {
          value.condition = presenceCondition;
        }
        onAdd('presence', value);
        break;
      }
      case 'type': {
        const value: any = { subType: typeSubType };
        if (typeSubType === 'enum' && typeEnumValues) {
          value.enum = typeEnumValues.split(',').map(v => v.trim()).filter(Boolean);
        } else if (typeSubType === 'format' && typeFormat) {
          value.format = typeFormat;
        } else if (typeSubType === 'range') {
          if (typeRangeMin) value.gte = Number(typeRangeMin);
          if (typeRangeMax) value.lte = Number(typeRangeMax);
        }
        onAdd('type', value);
        break;
      }
      case 'cardinality': {
        const value: any = {};
        if (cardinalityMin) value.min = Number(cardinalityMin);
        if (cardinalityMax) value.max = Number(cardinalityMax);
        onAdd('cardinality', value);
        break;
      }
      case 'immutability': {
        const value: any = { sealed: true };
        if (immutabilityCondition) value.condition = immutabilityCondition;
        onAdd('immutability', value);
        break;
      }
      case 'reference': {
        const value: any = {};
        if (referencePath) value.target = referencePath;
        if (referenceAttributes) value.attributes = referenceAttributes;
        onAdd('reference', value);
        break;
      }
      case 'uniqueness': {
        const value: any = { scope: uniquenessScope };
        if (uniquenessScope === 'scoped' && uniquenessScopeField) {
          value.scopeField = uniquenessScopeField;
        }
        onAdd('uniqueness', value);
        break;
      }
    }
    setActiveCell(null);
  }

  function renderConfigPanel(cellKey: string) {
    switch (cellKey) {
      case 'presence':
        return (
          <div style={s.configPanel}>
            <div style={s.configRow}>
              {PRESENCE_RULES.map(r => (
                <button
                  key={r.value}
                  style={{
                    ...s.configBtn,
                    background: presenceRule === r.value ? `${theme.accent}15` : 'transparent',
                    borderColor: presenceRule === r.value ? theme.accent : 'transparent',
                  }}
                  onClick={() => setPresenceRule(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {presenceRule === 'conditionally_required' && (
              <input
                style={s.configInput}
                value={presenceCondition}
                onChange={e => setPresenceCondition(e.target.value)}
                placeholder="e.g. status = 'issued'"
              />
            )}
            <button style={s.applyBtn} onClick={() => handleAddConstraint('presence')}>
              {existingSet.has('presence') ? 'Update' : 'Apply'}
            </button>
          </div>
        );

      case 'type':
        return (
          <div style={s.configPanel}>
            <div style={s.configRow}>
              {TYPE_SUBTYPES.map(st => (
                <button
                  key={st.value}
                  style={{
                    ...s.configBtn,
                    background: typeSubType === st.value ? `${theme.accent}15` : 'transparent',
                    borderColor: typeSubType === st.value ? theme.accent : 'transparent',
                  }}
                  onClick={() => setTypeSubType(st.value)}
                >
                  {st.label}
                </button>
              ))}
            </div>
            {typeSubType === 'enum' && (
              <input
                style={s.configInput}
                value={typeEnumValues}
                onChange={e => setTypeEnumValues(e.target.value)}
                placeholder="value1, value2, value3"
              />
            )}
            {typeSubType === 'format' && (
              <input
                style={s.configInput}
                value={typeFormat}
                onChange={e => setTypeFormat(e.target.value)}
                placeholder="^[a-z]+@[a-z]+\.[a-z]+$"
              />
            )}
            {typeSubType === 'range' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...s.configInput, flex: 1 }}
                  value={typeRangeMin}
                  onChange={e => setTypeRangeMin(e.target.value)}
                  placeholder="Min (gte)"
                  type="number"
                />
                <input
                  style={{ ...s.configInput, flex: 1 }}
                  value={typeRangeMax}
                  onChange={e => setTypeRangeMax(e.target.value)}
                  placeholder="Max (lte)"
                  type="number"
                />
              </div>
            )}
            <button style={s.applyBtn} onClick={() => handleAddConstraint('type')}>
              {existingSet.has('type') ? 'Update' : 'Apply'}
            </button>
          </div>
        );

      case 'cardinality':
        return (
          <div style={s.configPanel}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ ...s.configInput, flex: 1 }}
                value={cardinalityMin}
                onChange={e => setCardinalityMin(e.target.value)}
                placeholder="Min count"
                type="number"
              />
              <input
                style={{ ...s.configInput, flex: 1 }}
                value={cardinalityMax}
                onChange={e => setCardinalityMax(e.target.value)}
                placeholder="Max count"
                type="number"
              />
            </div>
            <button style={s.applyBtn} onClick={() => handleAddConstraint('cardinality')}>
              {existingSet.has('cardinality') ? 'Update' : 'Apply'}
            </button>
          </div>
        );

      case 'immutability':
        return (
          <div style={s.configPanel}>
            <div style={s.configLabel}>Once-set seal. Correction path is REC, not DEF.</div>
            <input
              style={s.configInput}
              value={immutabilityCondition}
              onChange={e => setImmutabilityCondition(e.target.value)}
              placeholder="Optional condition (e.g. billing_period = 'closed')"
            />
            <button style={s.applyBtn} onClick={() => handleAddConstraint('immutability')}>
              {existingSet.has('immutability') ? 'Update' : 'Apply'}
            </button>
          </div>
        );

      case 'reference':
        return (
          <div style={s.configPanel}>
            <input
              style={s.configInput}
              value={referencePath}
              onChange={e => setReferencePath(e.target.value)}
              placeholder="Target record path (e.g. contacts)"
            />
            <input
              style={{ ...s.configInput, marginTop: 6 }}
              value={referenceAttributes}
              onChange={e => setReferenceAttributes(e.target.value)}
              placeholder="Required attributes (e.g. role=attorney, status=active)"
            />
            <button style={s.applyBtn} onClick={() => handleAddConstraint('reference')}>
              {existingSet.has('reference') ? 'Update' : 'Apply'}
            </button>
          </div>
        );

      case 'uniqueness':
        return (
          <div style={s.configPanel}>
            <div style={s.configRow}>
              {UNIQUENESS_SCOPES.map(sc => (
                <button
                  key={sc.value}
                  style={{
                    ...s.configBtn,
                    background: uniquenessScope === sc.value ? `${theme.accent}15` : 'transparent',
                    borderColor: uniquenessScope === sc.value ? theme.accent : 'transparent',
                  }}
                  onClick={() => setUniquenessScope(sc.value)}
                >
                  {sc.label}
                </button>
              ))}
            </div>
            {uniquenessScope === 'scoped' && (
              <input
                style={s.configInput}
                value={uniquenessScopeField}
                onChange={e => setUniquenessScopeField(e.target.value)}
                placeholder="Scope field (e.g. jurisdiction)"
              />
            )}
            <button style={s.applyBtn} onClick={() => handleAddConstraint('uniqueness')}>
              {existingSet.has('uniqueness') ? 'Update' : 'Apply'}
            </button>
          </div>
        );

      default:
        return null;
    }
  }

  // GPU check
  const gpuAvailable = typeof navigator !== 'undefined' && !!navigator.gpu;

  // Cell whose details should be surfaced — prefer active (clicked) over hover
  // so the detail strip stays stable while the user moves toward the config
  // panel.
  const focusedKey = activeCell ?? hoverCell;
  const focusedDef = focusedKey ? CONSTRAINT_CELLS.find(c => c.key === focusedKey) : null;

  return (
    <div ref={containerRef} style={embedded ? { padding: '0 16px 8px' } : s.container}>
      {/* Identity bar — distinguishes this composer from the Resolution one */}
      <div style={s.identityBar} />

      {/* Header — hidden when embedded (panel provides its own header) */}
      {!embedded && (
        <div style={s.header}>
          <span style={s.title}>⊢ CONSTRAINTS</span>
          <span style={s.fieldKeyBadge}>{fieldKey}</span>
          <button style={s.closeBtn} onClick={onClose}>&times;</button>
        </div>
      )}

      {embedded && (
        <div style={{ fontSize: 11, color: theme.textSecondary, marginBottom: 8 }}>
          Click a cell to add or configure a constraint.
        </div>
      )}

      {/* Detail strip — replaces in-cell description in compact mode. Persistent
          empty state keeps layout stable so the grid doesn't jump. */}
      {compact && (
        <div
          style={{
            ...s.detailStrip,
            borderLeftColor: focusedDef?.color ?? theme.borderLight,
            opacity: focusedDef ? 1 : 0.6,
          }}
        >
          {focusedDef ? (
            <>
              <div style={s.detailStripHead}>
                <span style={s.detailStripCell}>{focusedDef.cell}</span>
                <span style={{ ...s.detailStripName, color: focusedDef.color }}>
                  {focusedDef.name}
                </span>
              </div>
              <div style={s.detailStripDesc}>{focusedDef.description}</div>
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
              const cellDef = CONSTRAINT_CELLS.find(c => c.row === row && c.col === col)!;
              const isConfigured = existingSet.has(cellDef.key);
              const isActive = activeCell === cellDef.key;
              const isDeferred = cellDef.phase === 2;

              // For deferred cells, check if already configured via other paths
              const existingDeferredValue = isDeferred
                ? existingConstraints.find(c => c.name === cellDef.key)?.value
                : null;

              const isHovered = hoverCell === cellDef.key;
              return (
                <button
                  key={cellDef.key}
                  disabled={isDeferred && !existingDeferredValue}
                  style={{
                    ...s.cell,
                    background: isActive
                      ? `${cellDef.color}15`
                      : isConfigured
                        ? `${cellDef.color}08`
                        : isHovered
                          ? theme.bgHover
                          : theme.bgCard,
                    borderColor: isActive
                      ? cellDef.color
                      : isConfigured
                        ? `${cellDef.color}40`
                        : isHovered
                          ? theme.border
                          : theme.borderLight,
                    opacity: isDeferred && !existingDeferredValue ? 0.5 : 1,
                    cursor: isDeferred && !existingDeferredValue ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={() => { if (!isDeferred || existingDeferredValue) setHoverCell(cellDef.key); }}
                  onMouseLeave={() => setHoverCell(null)}
                  onClick={() => {
                    if (isDeferred && !existingDeferredValue) return;
                    setActiveCell(isActive ? null : cellDef.key);
                  }}
                >
                  <div style={s.cellLabel}>{cellDef.cell}</div>
                  <div style={{ ...s.cellName, color: isConfigured || isActive ? cellDef.color : theme.textHeading }}>
                    {cellDef.name}
                  </div>
                  {!compact && <div style={s.cellDesc}>{cellDef.description}</div>}
                  <div style={s.cellOutputRow}>
                    {isConfigured && (
                      <span style={{ ...s.configuredTag, background: `${cellDef.color}18`, color: cellDef.color }}>
                        configured
                      </span>
                    )}
                    {isDeferred && !existingDeferredValue && (
                      <span style={s.deferredTag}>Phase 2</span>
                    )}
                    {/* Read-only display for deferred cells that have existing config */}
                    {isDeferred && existingDeferredValue && (
                      <span style={{ ...s.configuredTag, background: `${cellDef.color}18`, color: cellDef.color }}>
                        read-only
                      </span>
                    )}
                    {cellDef.gpu && gpuAvailable && (
                      <span style={s.gpuBadge}>GPU</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Config panel for active cell */}
      {activeCell && CONSTRAINT_CELLS.find(c => c.key === activeCell)?.phase === 1 && (
        <div style={s.configWrapper}>
          <div style={s.configHeader}>
            Configure {CONSTRAINT_CELLS.find(c => c.key === activeCell)?.name} — {fieldKey}
            {existingSet.has(activeCell) && (
              <button
                style={s.removeBtn}
                onClick={() => { onRemove(activeCell); setActiveCell(null); }}
              >
                Remove constraint
              </button>
            )}
          </div>
          {renderConfigPanel(activeCell)}
        </div>
      )}

      {/* Read-only display for deferred cells with existing config */}
      {activeCell && CONSTRAINT_CELLS.find(c => c.key === activeCell)?.phase === 2 && (
        <div style={s.configWrapper}>
          <div style={s.configHeader}>
            {CONSTRAINT_CELLS.find(c => c.key === activeCell)?.name} (read-only)
          </div>
          <pre style={s.readOnlyDisplay}>
            {JSON.stringify(existingConstraints.find(c => c.name === activeCell)?.value, null, 2)}
          </pre>
        </div>
      )}

      {/* Active constraints summary */}
      {existingConstraints.length > 0 && (
        <div style={s.summarySection}>
          <div style={s.summaryLabel}>ACTIVE CONSTRAINTS</div>
          <div style={s.summaryList}>
            {existingConstraints.map(c => {
              const cellDef = CONSTRAINT_CELLS.find(cd => cd.key === c.name);
              return (
                <div key={c.name} style={s.summaryItem}>
                  <span style={{
                    ...s.summaryDot,
                    background: cellDef?.color ?? theme.textMuted,
                  }} />
                  <span style={s.summaryName}>{cellDef?.name ?? c.name}</span>
                  <span style={s.summaryValue}>
                    {typeof c.value === 'object' ? JSON.stringify(c.value) : String(c.value)}
                  </span>
                  {cellDef?.phase === 1 && (
                    <button
                      style={s.summaryRemove}
                      onClick={() => onRemove(c.name)}
                    >
                      &times;
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
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
      background: CONSTRAINT_IDENTITY_COLOR,
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
    detailStripDesc: {
      fontSize: 11,
      color: t.textSecondary,
      lineHeight: 1.35,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
    },
    title: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    fieldKeyBadge: {
      fontSize: 10,
      fontWeight: 500,
      padding: '1px 6px',
      borderRadius: 4,
      background: t.bgMuted,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
      flex: 1,
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
      textAlign: 'left' as const,
      fontFamily: 'inherit',
      transition: 'background 0.1s, border-color 0.15s',
      minHeight: compact ? 54 : 90,
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
    cellOutputRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 4,
    },
    configuredTag: {
      fontSize: 9,
      fontWeight: 500,
      padding: '2px 7px',
      borderRadius: 10,
      fontFamily: "'JetBrains Mono', monospace",
    },
    deferredTag: {
      fontSize: 9,
      fontWeight: 500,
      padding: '2px 7px',
      borderRadius: 10,
      background: t.bgMuted,
      color: t.textMuted,
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
    configWrapper: {
      marginTop: 10,
      padding: '10px 14px',
      background: t.bgMuted,
      borderRadius: 8,
      border: `1px solid ${t.borderLight}`,
    },
    configHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      fontSize: 11,
      fontWeight: 600,
      color: t.textHeading,
      marginBottom: 8,
    },
    configPanel: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    configRow: {
      display: 'flex',
      gap: 4,
      flexWrap: 'wrap' as const,
    },
    configBtn: {
      fontSize: 11,
      padding: '4px 12px',
      border: '1px solid transparent',
      borderRadius: 5,
      cursor: 'pointer',
      fontFamily: 'inherit',
      color: t.text,
      background: 'transparent',
    },
    configLabel: {
      fontSize: 11,
      color: t.textSecondary,
      marginBottom: 4,
    },
    configInput: {
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
    applyBtn: {
      fontSize: 12,
      fontWeight: 500,
      padding: '5px 14px',
      borderRadius: 6,
      border: 'none',
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      fontFamily: 'inherit',
      alignSelf: 'flex-start',
    },
    removeBtn: {
      fontSize: 10,
      padding: '3px 10px',
      border: 'none',
      borderRadius: 4,
      background: 'transparent',
      color: t.danger,
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
    readOnlyDisplay: {
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      background: t.bg,
      padding: '8px 10px',
      borderRadius: 6,
      border: `1px solid ${t.borderLight}`,
      margin: 0,
      whiteSpace: 'pre-wrap' as const,
    },
    summarySection: {
      marginTop: 12,
      padding: '10px 14px',
      background: t.bgMuted,
      borderRadius: 8,
      border: `1px solid ${t.borderLight}`,
    },
    summaryLabel: {
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: t.textMuted,
      marginBottom: 6,
      fontFamily: "'JetBrains Mono', monospace",
    },
    summaryList: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    },
    summaryItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11,
    },
    summaryDot: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      flexShrink: 0,
    },
    summaryName: {
      fontWeight: 500,
      color: t.text,
    },
    summaryValue: {
      flex: 1,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    summaryRemove: {
      background: 'none',
      border: 'none',
      fontSize: 14,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 2px',
      lineHeight: 1,
    },
  };
}
