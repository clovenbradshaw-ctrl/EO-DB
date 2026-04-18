/**
 * SchemaFieldPanel — Right-side panel for editing a schema field.
 *
 * Three-layer progressive disclosure:
 *   Layer 1 (always visible) — Airtable-level basics: name, key, type,
 *     required toggle, simple validation (type-aware).
 *   Layer 2 (▸ More options, collapsed)  — Uncommon but grounded:
 *     uniqueness, cardinality, immutability, reference. Plus an
 *     "Edit in constraint grid →" escape hatch that embeds the full
 *     ConstraintComposer for expert users.
 *   Layer 3 (▸ Advanced, collapsed) — Power-user machinery: conflict
 *     resolution policies. Most fields never need this, so it's kept
 *     out of the default view entirely.
 *
 * Existing fields with Layer 2 or Layer 3 configuration auto-expand
 * those sections on panel open so users editing prior work aren't
 * confused about missing settings.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ConstraintComposer } from './ConstraintComposer';
import { ResolutionPolicyComposer, summarizePolicy, normalizeResolvePolicy, type ResolvePolicy } from './ResolutionPolicyComposer';
import { useTheme, type Theme } from '../theme';
import { formatName } from './scope-picker-utils';
import { getAirtableTypeIcon, getAirtableTypeColor } from './field-type-icons';
import {
  loadSavedDrawerWidth,
  clampDrawerWidth,
  saveDrawerWidth,
} from './drawer-dimensions';
import type { FieldSchema } from '../db/schema-rules';

/**
 * Headline content stats — computed from actual records in the current view.
 * Shown at the top of the panel so the user can see what the column actually
 * contains before tweaking its settings.
 */
export interface FieldValueStats {
  total: number;
  filled: number;
  distinct: number;
  numeric?: { min: number; max: number };
  textAvgLen?: number;
  topValues?: Array<{ value: string; count: number }>;
}

interface SchemaFieldPanelProps {
  fieldKey: string;
  fieldSchema: FieldSchema | undefined;
  /**
   * Dotted scope path of the field's parent table (e.g. "billing_accounts").
   * When provided, the subtitle below the field name is rendered as
   * `scope.fieldKey` so the user can tell which table the column belongs to.
   */
  scope?: string;
  valueStats?: FieldValueStats | null;
  /**
   * When set, force-opens the named disclosure section and scrolls it into
   * view. The `token` is a pulse value that changes on every focus request
   * so the effect re-fires even if the section was already the target.
   * Used by the Schema view to open Layer 3 (Advanced) directly when the
   * user clicks a Resolution column cell — otherwise the composer is buried
   * two collapses deep from the panel header.
   */
  focusRequest?: { section: 'advanced'; token: number } | null;
  onClose: () => void;
  onSaveLabel: (newLabel: string) => void;
  onAddConstraint: (name: string, value: any) => void;
  onRemoveConstraint: (name: string) => void;
  onSetResolution: (policy: ResolvePolicy) => void;
  onClearResolution: () => void;

  // ── Column-menu parity actions ──
  // The column header right-click menu exposes these; the panel mirrors them
  // so every option is reachable from one place.
  /** Current sort direction for this column, or null if not sorted. */
  sortDirection?: 'asc' | 'desc' | null;
  /** Whether this column is currently the table's display name field. */
  isDisplayField?: boolean;
  /** True for `_record` / `_last_updated` — hides type/display/constraint UI. */
  isSystemColumn?: boolean;
  /** True if this column's resolved type is `lastModifiedTime`. */
  isLastModifiedTime?: boolean;
  onSortAsc?: () => void;
  onSortDesc?: () => void;
  onRemoveSort?: () => void;
  onFilterBy?: () => void;
  onChangeType?: () => void;
  onConfigureWatchedFields?: () => void;
  onToggleDisplayField?: () => void;
  onHideColumn?: () => void;
}

// ─── Type family classification ─────────────────────────────────────────
// Used to pick the right "simple validation" controls for Layer 1.

type TypeFamily = 'text' | 'number' | 'date' | 'select' | 'boolean' | 'link' | 'other';

function typeFamilyOf(type: string | undefined): TypeFamily {
  if (!type) return 'other';
  if (['text', 'richText', 'email', 'url', 'phone'].includes(type)) return 'text';
  if (['number', 'currency', 'percent', 'rating', 'duration'].includes(type)) return 'number';
  if (type === 'date') return 'date';
  if (['select', 'multiSelect'].includes(type)) return 'select';
  if (type === 'boolean') return 'boolean';
  if (['link', 'relationship', 'linkedRecord'].includes(type)) return 'link';
  return 'other';
}

// Constraint names that Layer 2 surfaces. If any of these are already set
// on panel open, Layer 2 auto-expands.
const LAYER_2_CONSTRAINT_NAMES = new Set(['uniqueness', 'cardinality', 'immutability', 'reference']);

export function SchemaFieldPanel({
  fieldKey,
  fieldSchema,
  scope,
  valueStats,
  focusRequest,
  onClose,
  onSaveLabel,
  onAddConstraint,
  onRemoveConstraint,
  onSetResolution,
  onClearResolution,
  sortDirection = null,
  isDisplayField = false,
  isSystemColumn = false,
  isLastModifiedTime = false,
  onSortAsc,
  onSortDesc,
  onRemoveSort,
  onFilterBy,
  onChangeType,
  onConfigureWatchedFields,
  onToggleDisplayField,
  onHideColumn,
}: SchemaFieldPanelProps) {
  const { theme } = useTheme();
  const s = makeRowStyles(theme);

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(fieldSchema?.name || '');

  // ── Drag-to-resize width — shared with RecordDetailDrawer so both right-side
  // drawers feel like one unified component with a single remembered width.
  const [drawerWidth, setDrawerWidth] = useState<number>(() => clampDrawerWidth(loadSavedDrawerWidth()));
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      setDrawerWidth((w) => {
        const next = clampDrawerWidth(w);
        return next === w ? w : next;
      });
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const handleResizeStart = (clientX: number) => {
    resizeStartRef.current = { startX: clientX, startWidth: drawerWidth };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent | TouchEvent) => {
      const st = resizeStartRef.current;
      if (!st) return;
      const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
      if (clientX == null) return;
      // Drawer is on the right — moving handle LEFT should widen it.
      const delta = st.startX - clientX;
      const next = clampDrawerWidth(st.startWidth + delta);
      setDrawerWidth(next);
    };
    const onUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
      saveDrawerWidth(drawerWidth);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizing, drawerWidth]);

  const typeDisplay = fieldSchema?.typeDef?.value?.type || fieldSchema?.ingestedType || '—';
  const formatDisplay = fieldSchema?.typeDef?.value?.format ? ` (${fieldSchema.typeDef.value.format})` : '';
  const displayName = fieldSchema?.name || formatName(fieldKey);
  const family = typeFamilyOf(typeDisplay);

  // ── Existing-constraint lookups ──
  const constraints = fieldSchema?.constraints ?? [];
  const presenceConstraint = constraints.find(c => c.name === 'presence');
  const typeConstraint = constraints.find(c => c.name === 'type');
  const uniquenessConstraint = constraints.find(c => c.name === 'uniqueness');
  const cardinalityConstraint = constraints.find(c => c.name === 'cardinality');
  const immutabilityConstraint = constraints.find(c => c.name === 'immutability');
  const referenceConstraint = constraints.find(c => c.name === 'reference');

  const isRequired = presenceConstraint?.value?.rule === 'required';
  const isUnique = !!uniquenessConstraint;
  const isImmutable = !!immutabilityConstraint;

  const hasLayer2 = constraints.some(c => LAYER_2_CONSTRAINT_NAMES.has(c.name));

  // normalizeResolvePolicy handles both the canonical titlecase-keyed shape
  // and the two legacy shapes (lowercase stances + pre-composer {strategy})
  // that may still live in persisted FieldSchema records from before A.6/2.
  const currentPolicy: ResolvePolicy | null = normalizeResolvePolicy(fieldSchema?.resolve?.value);
  const hasResolution = !!currentPolicy;

  // ── Disclosure state ──
  // Auto-expand sections that already have config so users editing existing
  // fields can see their current settings without hunting for them.
  const [moreOpen, setMoreOpen] = useState(hasLayer2);
  const [advancedOpen, setAdvancedOpen] = useState(hasResolution);
  const [showFullGrid, setShowFullGrid] = useState(false);

  // ── External focus requests ──
  // Schema view sends a pulse when the user clicks the Resolution column cell
  // so we can open Layer 3 directly and scroll the composer into view.
  const advancedSectionRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.section === 'advanced') {
      setAdvancedOpen(true);
      // Scroll after the next paint so the section has rendered its content.
      const id = window.setTimeout(() => {
        advancedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [focusRequest]);

  // ── Layer 1 validation — local draft state ──
  // We apply on blur / explicit action rather than per-keystroke, so users
  // can type freely without firing a flurry of DEFs.
  const initialRangeMin = useMemo(
    () => (typeConstraint?.value?.subType === 'range' && typeConstraint.value.gte != null
      ? String(typeConstraint.value.gte)
      : ''),
    [typeConstraint],
  );
  const initialRangeMax = useMemo(
    () => (typeConstraint?.value?.subType === 'range' && typeConstraint.value.lte != null
      ? String(typeConstraint.value.lte)
      : ''),
    [typeConstraint],
  );
  const initialRegex = useMemo(
    () => (typeConstraint?.value?.subType === 'format' && typeof typeConstraint.value.format === 'string'
      ? typeConstraint.value.format
      : ''),
    [typeConstraint],
  );
  const [rangeMin, setRangeMin] = useState<string>(initialRangeMin);
  const [rangeMax, setRangeMax] = useState<string>(initialRangeMax);
  const [regex, setRegex] = useState<string>(initialRegex);

  // ── Layer 2 local draft state ──
  const initialCardMin = useMemo(
    () => (cardinalityConstraint?.value?.min != null ? String(cardinalityConstraint.value.min) : ''),
    [cardinalityConstraint],
  );
  const initialCardMax = useMemo(
    () => (cardinalityConstraint?.value?.max != null ? String(cardinalityConstraint.value.max) : ''),
    [cardinalityConstraint],
  );
  const initialRefTarget = useMemo(
    () => (typeof referenceConstraint?.value?.target === 'string' ? referenceConstraint.value.target : ''),
    [referenceConstraint],
  );
  const [cardMin, setCardMin] = useState<string>(initialCardMin);
  const [cardMax, setCardMax] = useState<string>(initialCardMax);
  const [refTarget, setRefTarget] = useState<string>(initialRefTarget);

  // ── Handlers ──
  function handleNameSubmit(val: string) {
    setEditingName(false);
    onSaveLabel(val.trim());
  }

  function toggleRequired() {
    if (isRequired) {
      onRemoveConstraint('presence');
    } else {
      onAddConstraint('presence', { rule: 'required' });
    }
  }

  function applyRange() {
    const minStr = rangeMin.trim();
    const maxStr = rangeMax.trim();
    if (!minStr && !maxStr) {
      // User cleared both — remove type constraint only if it was a range
      if (typeConstraint?.value?.subType === 'range') {
        onRemoveConstraint('type');
      }
      return;
    }
    const value: any = { subType: 'range' };
    if (minStr) value.gte = Number(minStr);
    if (maxStr) value.lte = Number(maxStr);
    onAddConstraint('type', value);
  }

  function applyRegex() {
    const val = regex.trim();
    if (!val) {
      if (typeConstraint?.value?.subType === 'format') {
        onRemoveConstraint('type');
      }
      return;
    }
    onAddConstraint('type', { subType: 'format', format: val });
  }

  function toggleUnique() {
    if (isUnique) {
      onRemoveConstraint('uniqueness');
    } else {
      onAddConstraint('uniqueness', { scope: 'global' });
    }
  }

  function toggleImmutable() {
    if (isImmutable) {
      onRemoveConstraint('immutability');
    } else {
      onAddConstraint('immutability', { sealed: true });
    }
  }

  function applyCardinality() {
    const minStr = cardMin.trim();
    const maxStr = cardMax.trim();
    if (!minStr && !maxStr) {
      if (cardinalityConstraint) onRemoveConstraint('cardinality');
      return;
    }
    const value: any = {};
    if (minStr) value.min = Number(minStr);
    if (maxStr) value.max = Number(maxStr);
    onAddConstraint('cardinality', value);
  }

  function applyReference() {
    const val = refTarget.trim();
    if (!val) {
      if (referenceConstraint) onRemoveConstraint('reference');
      return;
    }
    onAddConstraint('reference', { target: val });
  }

  // ── Rendering helpers ──
  const validationRow = renderValidationRow(family, {
    theme,
    rangeMin, setRangeMin, rangeMax, setRangeMax, applyRange,
    regex, setRegex, applyRegex,
  });

  const layer2Summary = useMemo(() => {
    const parts: string[] = [];
    if (isUnique) parts.push('unique');
    if (cardinalityConstraint) parts.push('limited');
    if (isImmutable) parts.push('locked');
    if (referenceConstraint) parts.push('references');
    return parts.join(' · ');
  }, [isUnique, cardinalityConstraint, isImmutable, referenceConstraint]);

  const resolveLabel = currentPolicy ? summarizePolicy(currentPolicy) : 'none';

  return (
    <div style={{
      width: drawerWidth,
      minWidth: drawerWidth,
      borderLeft: `1px solid ${theme.border}`,
      display: 'flex',
      flexDirection: 'column',
      background: theme.bgCard,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Resize handle — 6px hit area on the left edge, matches RecordDetailDrawer. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize field panel"
        onMouseDown={(e) => { e.preventDefault(); handleResizeStart(e.clientX); }}
        onTouchStart={(e) => { if (e.touches[0]) handleResizeStart(e.touches[0].clientX); }}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'col-resize',
          zIndex: 5,
          background: isResizing ? theme.accent : 'transparent',
          opacity: isResizing ? 0.4 : 1,
        }}
      />
      {/* ── Panel header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        borderBottom: `1px solid ${theme.border}`,
        flexShrink: 0,
      }}>
        {/* Type icon chip */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 20,
          borderRadius: 4,
          fontSize: 9,
          fontFamily: "'JetBrains Mono', monospace",
          background: theme.bgMuted,
          color: getAirtableTypeColor(typeDisplay),
          flexShrink: 0,
          letterSpacing: '-0.5px',
          border: `1px solid ${theme.borderLight}`,
        }} title={typeDisplay}>
          {getAirtableTypeIcon(typeDisplay)}
        </span>

        {/* Display name — double-click to edit */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingName ? (
            <form
              onSubmit={(e) => { e.preventDefault(); handleNameSubmit(nameValue); }}
              style={{ display: 'flex', gap: 4 }}
            >
              <input
                autoFocus
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={() => handleNameSubmit(nameValue)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setEditingName(false); setNameValue(fieldSchema?.name || ''); } }}
                style={{
                  flex: 1,
                  padding: '2px 6px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: `1px solid ${theme.accent}`,
                  borderRadius: 3,
                  background: theme.bg,
                  color: theme.textHeading,
                  outline: 'none',
                }}
              />
            </form>
          ) : (
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: theme.textHeading,
                cursor: 'text',
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title="Double-click to edit display name"
              onDoubleClick={() => { setEditingName(true); setNameValue(fieldSchema?.name || ''); }}
            >
              {displayName}
            </span>
          )}
          <span style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: theme.textMuted,
          }}>
            {scope ? `${scope}.${fieldKey}` : fieldKey}
          </span>
        </div>

        {/* Type badge */}
        <span style={{
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          background: theme.bgMuted,
          color: getAirtableTypeColor(typeDisplay),
          padding: '2px 6px',
          borderRadius: 4,
          border: `1px solid ${theme.borderLight}`,
          flexShrink: 0,
        }}>
          {typeDisplay}{formatDisplay}
        </span>

        {/* Close */}
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            color: theme.textMuted,
            padding: '0 2px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      </div>

      {/* ── Quick actions toolbar — mirrors the column header right-click menu ── */}
      <QuickActionsBar
        theme={theme}
        sortDirection={sortDirection}
        isDisplayField={isDisplayField}
        isSystemColumn={isSystemColumn}
        isLastModifiedTime={isLastModifiedTime}
        onSortAsc={onSortAsc}
        onSortDesc={onSortDesc}
        onRemoveSort={onRemoveSort}
        onFilterBy={onFilterBy}
        onChangeType={onChangeType}
        onConfigureWatchedFields={onConfigureWatchedFields}
        onToggleDisplayField={onToggleDisplayField}
        onHideColumn={onHideColumn}
      />

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ═══ Content headline — stats about what's actually in this column ═══ */}
        {valueStats && valueStats.total > 0 && (
          <div style={{
            padding: '10px 16px',
            background: theme.bgMuted,
            borderBottom: `1px solid ${theme.borderLight}`,
          }}>
            <div style={{
              display: 'flex',
              gap: 14,
              flexWrap: 'wrap',
              fontSize: 11,
              color: theme.textSecondary,
              alignItems: 'baseline',
            }}>
              <span>
                <strong style={{ color: theme.textHeading, fontVariantNumeric: 'tabular-nums' }}>
                  {valueStats.filled}
                </strong>
                <span style={{ color: theme.textMuted }}>/{valueStats.total}</span>
                {' filled'}
                {valueStats.total > 0 && (
                  <span style={{ color: theme.textMuted, marginLeft: 4 }}>
                    ({Math.round((valueStats.filled / valueStats.total) * 100)}%)
                  </span>
                )}
              </span>
              <span>
                <strong style={{ color: theme.textHeading, fontVariantNumeric: 'tabular-nums' }}>
                  {valueStats.distinct}
                </strong>
                {' distinct'}
              </span>
              {valueStats.numeric && (
                <span>
                  range{' '}
                  <strong style={{ color: theme.textHeading, fontFamily: "'JetBrains Mono', monospace" }}>
                    {formatStatNumber(valueStats.numeric.min)}
                  </strong>
                  {' … '}
                  <strong style={{ color: theme.textHeading, fontFamily: "'JetBrains Mono', monospace" }}>
                    {formatStatNumber(valueStats.numeric.max)}
                  </strong>
                </span>
              )}
              {valueStats.textAvgLen != null && (
                <span>
                  avg{' '}
                  <strong style={{ color: theme.textHeading, fontVariantNumeric: 'tabular-nums' }}>
                    {valueStats.textAvgLen}
                  </strong>
                  {' chars'}
                </span>
              )}
            </div>
            {valueStats.topValues && valueStats.topValues.length > 0 && (
              <div style={{
                display: 'flex',
                gap: 6,
                flexWrap: 'wrap',
                marginTop: 6,
              }}>
                {valueStats.topValues.map((tv, i) => (
                  <span
                    key={`${tv.value}-${i}`}
                    title={tv.value}
                    style={{
                      fontSize: 10,
                      background: theme.bgCard,
                      border: `1px solid ${theme.borderLight}`,
                      borderRadius: 4,
                      padding: '2px 6px',
                      fontFamily: "'JetBrains Mono', monospace",
                      color: theme.text,
                      maxWidth: 180,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tv.value}
                    <span style={{ color: theme.textMuted, marginLeft: 4 }}>×{tv.count}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ Layer 1 — Field rules (always visible) ═══ */}
        <div style={{ padding: '14px 16px 4px' }}>

          {/* Required toggle */}
          <div style={s.row}>
            <div style={s.rowLabel}>
              <div style={s.rowName}>Required</div>
              <div style={s.rowHelp}>This field must have a value.</div>
            </div>
            <Toggle theme={theme} on={isRequired} onChange={toggleRequired} />
          </div>

          {/* Type-aware simple validation */}
          {validationRow}

          {family === 'select' && (
            <div style={s.row}>
              <div style={s.rowLabel}>
                <div style={s.rowName}>Options</div>
                <div style={s.rowHelp}>Edit the list of allowed values from the column header.</div>
              </div>
            </div>
          )}
        </div>

        {/* ═══ Layer 2 — More options (collapsed) ═══ */}
        <div style={{ borderTop: `1px solid ${theme.border}` }}>
          <button
            onClick={() => setMoreOpen(v => !v)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, color: theme.textMuted }}>
              {moreOpen ? '▾' : '▸'}
            </span>
            <span style={{ fontSize: 12, fontWeight: 600, color: theme.textHeading }}>
              More options
            </span>
            {layer2Summary && !moreOpen && (
              <span style={{
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
                color: theme.textMuted,
              }}>
                {layer2Summary}
              </span>
            )}
          </button>

          {moreOpen && (
            <div style={{ padding: '0 16px 12px' }}>
              {/* Unique values */}
              <div style={s.row}>
                <div style={s.rowLabel}>
                  <div style={s.rowName}>Unique values</div>
                  <div style={s.rowHelp}>No two records can have the same value.</div>
                </div>
                <Toggle theme={theme} on={isUnique} onChange={toggleUnique} />
              </div>

              {/* Lock once set */}
              <div style={s.row}>
                <div style={s.rowLabel}>
                  <div style={s.rowName}>Lock once set</div>
                  <div style={s.rowHelp}>Value cannot be edited after it's first written.</div>
                </div>
                <Toggle theme={theme} on={isImmutable} onChange={toggleImmutable} />
              </div>

              {/* Cardinality */}
              <div style={s.row}>
                <div style={s.rowLabel}>
                  <div style={s.rowName}>Limit how many values</div>
                  <div style={s.rowHelp}>Min / max count of values at this path.</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <input
                    style={s.numInput(theme)}
                    value={cardMin}
                    onChange={e => setCardMin(e.target.value)}
                    onBlur={applyCardinality}
                    placeholder="Min"
                    type="number"
                    inputMode="numeric"
                  />
                  <input
                    style={s.numInput(theme)}
                    value={cardMax}
                    onChange={e => setCardMax(e.target.value)}
                    onBlur={applyCardinality}
                    placeholder="Max"
                    type="number"
                    inputMode="numeric"
                  />
                </div>
              </div>

              {/* Reference */}
              <div style={s.row}>
                <div style={s.rowLabel}>
                  <div style={s.rowName}>Must reference</div>
                  <div style={s.rowHelp}>Value must point to an existing record at this path.</div>
                </div>
                <input
                  style={s.textInput(theme, 160)}
                  value={refTarget}
                  onChange={e => setRefTarget(e.target.value)}
                  onBlur={applyReference}
                  placeholder="e.g. contacts"
                />
              </div>

              {/* Escape hatch — full constraint grid */}
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <button
                  onClick={() => setShowFullGrid(v => !v)}
                  style={{
                    fontSize: 11,
                    background: 'none',
                    border: 'none',
                    color: theme.accent,
                    cursor: 'pointer',
                    padding: '2px 4px',
                    fontFamily: 'inherit',
                  }}
                >
                  {showFullGrid ? 'Hide constraint grid' : 'Edit in constraint grid →'}
                </button>
              </div>

              {showFullGrid && (
                <div style={{
                  marginTop: 6,
                  borderTop: `1px dashed ${theme.border}`,
                  paddingTop: 8,
                  overflowX: 'auto',
                }}>
                  <ConstraintComposer
                    embedded
                    fieldKey={fieldKey}
                    existingConstraints={constraints}
                    onAdd={onAddConstraint}
                    onRemove={onRemoveConstraint}
                    onClose={() => setShowFullGrid(false)}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* ═══ Layer 3 — Advanced (collapsed) ═══ */}
        <div ref={advancedSectionRef} style={{ borderTop: `1px solid ${theme.border}` }}>
          <button
            onClick={() => setAdvancedOpen(v => !v)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, color: theme.textMuted }}>
              {advancedOpen ? '▾' : '▸'}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: theme.textHeading }}>
                Advanced
              </div>
              <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 1 }}>
                conflict resolution — most fields never need this
              </div>
            </div>
            {hasResolution && !advancedOpen && (
              <span style={{
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
                color: theme.text,
              }}>
                {resolveLabel}
              </span>
            )}
          </button>

          {advancedOpen && (
            <div style={{ padding: '0 16px 16px' }}>
              <div style={{
                fontSize: 11,
                color: theme.textSecondary,
                background: theme.bgMuted,
                border: `1px solid ${theme.borderLight}`,
                borderRadius: 5,
                padding: '8px 10px',
                marginBottom: 10,
                lineHeight: 1.4,
              }}>
                Defines how this field reconciles when multiple sources disagree.
                Leave empty unless you're syncing from multiple systems.
              </div>
              <div style={{ overflowX: 'auto' }}>
                <ResolutionPolicyComposer
                  embedded
                  fieldKey={fieldKey}
                  currentPolicy={currentPolicy}
                  onApply={onSetResolution}
                  onClear={onClearResolution}
                  onClose={() => setAdvancedOpen(false)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Quick actions bar ──────────────────────────────────────────────────
//
// Mirrors the column header right-click context menu so every column action
// is reachable from inside the field panel. Rendered as a compact horizontal
// toolbar immediately below the panel header — sort, filter, type, display,
// hide. Callbacks are optional: a button renders only if its handler is wired.

interface QuickActionsBarProps {
  theme: Theme;
  sortDirection: 'asc' | 'desc' | null;
  isDisplayField: boolean;
  isSystemColumn: boolean;
  isLastModifiedTime: boolean;
  onSortAsc?: () => void;
  onSortDesc?: () => void;
  onRemoveSort?: () => void;
  onFilterBy?: () => void;
  onChangeType?: () => void;
  onConfigureWatchedFields?: () => void;
  onToggleDisplayField?: () => void;
  onHideColumn?: () => void;
}

function QuickActionsBar({
  theme,
  sortDirection,
  isDisplayField,
  isSystemColumn,
  isLastModifiedTime,
  onSortAsc,
  onSortDesc,
  onRemoveSort,
  onFilterBy,
  onChangeType,
  onConfigureWatchedFields,
  onToggleDisplayField,
  onHideColumn,
}: QuickActionsBarProps) {
  const hasAny =
    onSortAsc || onSortDesc || onFilterBy || onChangeType ||
    onConfigureWatchedFields || onToggleDisplayField || onHideColumn;
  if (!hasAny) return null;

  const btnStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 11,
    fontFamily: 'inherit',
    padding: '4px 8px',
    borderRadius: 4,
    border: `1px solid ${active ? theme.accent : theme.borderLight}`,
    background: active ? theme.bgMuted : theme.bg,
    color: active ? theme.accent : theme.textSecondary,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  return (
    <div style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      padding: '8px 16px',
      borderBottom: `1px solid ${theme.border}`,
      background: theme.bg,
      flexShrink: 0,
    }}>
      {onSortAsc && (
        <button
          style={btnStyle(sortDirection === 'asc')}
          onClick={() => (sortDirection === 'asc' && onRemoveSort ? onRemoveSort() : onSortAsc())}
          title={sortDirection === 'asc' ? 'Remove sort' : 'Sort ascending'}
        >
          {'\u2191'} Asc{sortDirection === 'asc' ? ' \u00b7 active' : ''}
        </button>
      )}
      {onSortDesc && (
        <button
          style={btnStyle(sortDirection === 'desc')}
          onClick={() => (sortDirection === 'desc' && onRemoveSort ? onRemoveSort() : onSortDesc())}
          title={sortDirection === 'desc' ? 'Remove sort' : 'Sort descending'}
        >
          {'\u2193'} Desc{sortDirection === 'desc' ? ' \u00b7 active' : ''}
        </button>
      )}
      {onFilterBy && (
        <button
          style={btnStyle(false)}
          onClick={onFilterBy}
          title="Add a filter on this column"
        >
          {'\u2023'} Filter
        </button>
      )}
      {!isSystemColumn && onChangeType && (
        <button
          style={btnStyle(false)}
          onClick={onChangeType}
          title="Change column type"
        >
          {'Type\u2026'}
        </button>
      )}
      {!isSystemColumn && isLastModifiedTime && onConfigureWatchedFields && (
        <button
          style={btnStyle(false)}
          onClick={onConfigureWatchedFields}
          title="Configure watched fields"
        >
          {'Watched\u2026'}
        </button>
      )}
      {!isSystemColumn && onToggleDisplayField && (
        <button
          style={btnStyle(isDisplayField)}
          onClick={onToggleDisplayField}
          title={isDisplayField ? 'This is the display name field' : 'Use as display name'}
        >
          {isDisplayField ? '\u2605 Display' : 'Use as display'}
        </button>
      )}
      {onHideColumn && (
        <button
          style={btnStyle(false)}
          onClick={onHideColumn}
          title="Hide column"
        >
          Hide
        </button>
      )}
    </div>
  );
}

// ─── Stat value formatting ──────────────────────────────────────────────

function formatStatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  // Round to 2 decimals for compactness
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ─── Validation row (type-aware) ─────────────────────────────────────────

interface ValidationCtx {
  theme: Theme;
  rangeMin: string;
  setRangeMin: (v: string) => void;
  rangeMax: string;
  setRangeMax: (v: string) => void;
  applyRange: () => void;
  regex: string;
  setRegex: (v: string) => void;
  applyRegex: () => void;
}

function renderValidationRow(family: TypeFamily, ctx: ValidationCtx) {
  const s = makeRowStyles(ctx.theme);
  switch (family) {
    case 'number':
      return (
        <div style={s.row}>
          <div style={s.rowLabel}>
            <div style={s.rowName}>Validation</div>
            <div style={s.rowHelp}>Restrict values to a numeric range.</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <input
              style={s.numInput(ctx.theme)}
              value={ctx.rangeMin}
              onChange={e => ctx.setRangeMin(e.target.value)}
              onBlur={ctx.applyRange}
              placeholder="Min"
              type="number"
              inputMode="decimal"
            />
            <input
              style={s.numInput(ctx.theme)}
              value={ctx.rangeMax}
              onChange={e => ctx.setRangeMax(e.target.value)}
              onBlur={ctx.applyRange}
              placeholder="Max"
              type="number"
              inputMode="decimal"
            />
          </div>
        </div>
      );

    case 'date':
      return (
        <div style={s.row}>
          <div style={s.rowLabel}>
            <div style={s.rowName}>Validation</div>
            <div style={s.rowHelp}>Restrict to a date range (YYYY-MM-DD).</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <input
              style={s.textInput(ctx.theme, 110)}
              value={ctx.rangeMin}
              onChange={e => ctx.setRangeMin(e.target.value)}
              onBlur={ctx.applyRange}
              placeholder="From"
            />
            <input
              style={s.textInput(ctx.theme, 110)}
              value={ctx.rangeMax}
              onChange={e => ctx.setRangeMax(e.target.value)}
              onBlur={ctx.applyRange}
              placeholder="To"
            />
          </div>
        </div>
      );

    case 'text':
      return (
        <div style={s.row}>
          <div style={s.rowLabel}>
            <div style={s.rowName}>Validation</div>
            <div style={s.rowHelp}>Regex pattern the value must match.</div>
          </div>
          <input
            style={s.textInput(ctx.theme, 220)}
            value={ctx.regex}
            onChange={e => ctx.setRegex(e.target.value)}
            onBlur={ctx.applyRegex}
            placeholder={"^[a-z]+@[a-z]+\\.[a-z]+$"}
          />
        </div>
      );

    default:
      return null;
  }
}

// ─── Small reusable toggle ───────────────────────────────────────────────

function Toggle({ theme, on, onChange }: { theme: Theme; on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      aria-pressed={on}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        background: on ? theme.accent : theme.bgMuted,
        border: `1px solid ${on ? theme.accent : theme.border}`,
        position: 'relative',
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'background 0.12s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 1,
          left: on ? 15 : 1,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
          transition: 'left 0.12s',
        }}
      />
    </button>
  );
}

// ─── Row style factory ──────────────────────────────────────────────────

function makeRowStyles(theme: Theme) {
  return {
    row: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '8px 0',
      borderBottom: `1px solid ${theme.borderLight}`,
    } as const,
    rowLabel: {
      flex: 1,
      minWidth: 0,
    } as const,
    rowName: {
      fontSize: 12,
      fontWeight: 500,
      color: theme.textHeading,
    } as const,
    rowHelp: {
      fontSize: 10,
      color: theme.textMuted,
      marginTop: 1,
    } as const,
    numInput: (t: Theme) => ({
      width: 64,
      height: 26,
      fontSize: 11,
      padding: '0 6px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      fontFamily: "'JetBrains Mono', monospace",
    }) as const,
    textInput: (t: Theme, width: number) => ({
      width,
      height: 26,
      fontSize: 11,
      padding: '0 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      fontFamily: "'JetBrains Mono', monospace",
    }) as const,
  };
}
