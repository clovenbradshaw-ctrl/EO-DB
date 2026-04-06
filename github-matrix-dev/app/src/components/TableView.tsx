import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { deriveColumns, buildFieldNameMap, buildFieldNameMapFromSchema, hasFieldsSubObject, getFieldValue, applyFilters, type ColumnDef, type FilterRule } from './filter-types';
import { type TimeScrubberFilter, applyTimeScrubber } from './time-scrubber-utils';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';
import { RedactedCell, LockIcon, LockedCell } from './RedactedCell';
import { FilterBar } from './FilterBar';
import { SortPanel, type SortRule } from './SortPanel';
import type { ResolvedPermissions } from '../permissions/types';
import { useViewStore } from '../store/view-store';
import { defaultColumnWidth, MIN_COLUMN_WIDTH } from './view-types';
import { formatName } from './scope-picker-utils';
import { useIdResolver, isEntityId, isEntityIdArray, type IdResolver } from '../hooks/useIdResolver';
import { groupSchemaStates, extractColumnTypeOverrides, schemaTypeTarget, schemaConstraintTarget, schemaResolveTarget, type FieldSchema } from '../db/schema-rules';
import { ColumnTypeSelector } from './ColumnTypeSelector';
import { useIsMobile, useIsNarrow } from '../hooks/useIsMobile';
import { ColumnManagerPanel } from './ColumnManagerPanel';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TableViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  onViewHistory?: (target: string) => void;
  onEmptyScope?: (parentScope: string) => void;
  activeRecord?: string | null;
  session: { userId: string };
  timeScrubberFilter?: TimeScrubberFilter;
  permissions?: ResolvedPermissions | null;
}

function formatRelativeTime(ts: string): string {
  const now = Date.now();
  const then = new Date(ts).getTime();
  const diff = now - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Common name-like field keys to probe when `value.name` is not set.
// Matches are case-insensitive and cover typical CSV/spreadsheet headers
// ("Name", "Client Name", "Title", etc.). Ordered by preference.
const NAME_LIKE_KEYS = [
  'name',
  'display_name', 'displayname', 'display name',
  'full_name', 'fullname', 'full name',
  'client_name', 'client name', 'client',
  'company_name', 'company name', 'company',
  'title',
  'label',
  'subject',
];

function resolveRecordName(rec: EoState): string | null {
  const v = rec.value;
  if (!v || typeof v !== 'object') return null;

  // Top-level `name` wins.
  if (typeof v.name === 'string' && v.name) return v.name;

  // Build a case-insensitive key lookup across top-level and `fields` sub-object.
  const sources: Record<string, any>[] = [];
  if (typeof v === 'object' && !Array.isArray(v)) sources.push(v as Record<string, any>);
  if (v.fields && typeof v.fields === 'object' && !Array.isArray(v.fields)) {
    sources.push(v.fields as Record<string, any>);
  }

  for (const source of sources) {
    const lowerMap = new Map<string, any>();
    for (const [k, val] of Object.entries(source)) {
      if (k.startsWith('_')) continue;
      lowerMap.set(k.toLowerCase(), val);
    }
    for (const candidate of NAME_LIKE_KEYS) {
      const val = lowerMap.get(candidate);
      if (typeof val === 'string' && val) return val;
    }
  }

  return null;
}

function formatScopeName(scope: string): string {
  const last = scope.split('.').pop() || scope;
  let name = last.replace(/^(tbl|rec|fld)/, '');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name || last;
}

// Absence — the field was never asserted. Render very quietly so the eye
// skips over it; grid lines already confirm the cell exists.
function AbsentCell({ t }: { t: Theme }) {
  return (
    <span
      aria-label="empty"
      style={{ color: t.textMuted, opacity: 0.25, fontSize: '0.85em', userSelect: 'none' }}
    >
      {'\u2014'}
    </span>
  );
}

// Intentionally-cleared — an explicit NULL assertion. Distinct from absence:
// someone deliberately cleared this field. Uses the Unicode "symbol for null"
// (U+2400) so it reads as a deliberate mark, not just empty text.
function ClearedCell({ t }: { t: Theme }) {
  return (
    <span
      aria-label="cleared"
      title="Intentionally cleared"
      style={{
        color: t.textMuted,
        opacity: 0.5,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.9em',
        userSelect: 'none',
      }}
    >
      {'\u2400'}
    </span>
  );
}

// Back-compat shim
function NullCell({ t }: { t: Theme }) {
  return <AbsentCell t={t} />;
}

function humanizeLabel(s: string): string {
  return s
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getStatusPillStyle(value: string, t: Theme): { bg: string; color: string; border: string } {
  const known: Record<string, { bg: string; color: string; border: string }> = {
    active: t.statusActive,
    archived: t.statusArchived,
    pending: t.statusPending,
  };
  if (known[value]) return known[value];
  const v = value.toLowerCase();
  if (/review|conflict|warn|flag/.test(v)) return { bg: t.warningBg, color: t.warningText, border: t.warningBorder };
  if (/error|fail|denied|blocked|reject/.test(v)) return { bg: t.dangerBg, color: t.dangerText, border: t.dangerBorder };
  if (/closed|done|complete|resolved|archiv/.test(v)) return t.statusArchived;
  if (/upcoming|scheduled|planned|briefing|prep|draft/.test(v)) return { bg: t.purpleBg, color: t.purple, border: t.purpleBorder };
  return { bg: t.bgMuted, color: t.textSecondary, border: t.border };
}

function StatusPill({ value, t }: { value: string; t: Theme }) {
  const sc = getStatusPillStyle(value, t);
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 9999,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: 1.4,
      background: sc.bg,
      color: sc.color,
      border: `1px solid ${sc.border}`,
      whiteSpace: 'nowrap',
    }}>
      {humanizeLabel(value)}
    </span>
  );
}

function IdChip({ value, t, resolved, onNavigate }: {
  value: string;
  t: Theme;
  resolved?: { target: string; name: string | null } | null;
  onNavigate?: (target: string) => void;
}) {
  const clickable = !!(resolved?.target && onNavigate);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        background: t.bgMuted,
        color: clickable ? t.purple : t.textSecondary,
        border: `1px solid ${t.borderLight}`,
        marginRight: 4,
        whiteSpace: 'nowrap',
        cursor: clickable ? 'pointer' : 'default',
      }}
      onClick={clickable ? (e) => { e.stopPropagation(); onNavigate!(resolved!.target); } : undefined}
    >
      {value}
      {resolved?.name && (
        <span style={{ fontFamily: 'inherit', color: t.text, fontWeight: 400 }}>{' · '}{resolved.name}</span>
      )}
    </span>
  );
}

function isCurrencyKey(key: string): boolean {
  return /^(amount|price|cost|fee|total|subtotal|balance|rate|value)(_|$)/i.test(key)
    || /^(amount|price|cost|fee|total|subtotal|balance|rate)$/i.test(key);
}

function isIdArrayValue(value: any): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((v) => typeof v === 'string' && /^[A-Z]{2,5}-\d+$/.test(v));
}

function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function renderCell(value: any, key: string, onNavigate: (t: string) => void, t: Theme, resolver?: IdResolver): React.ReactNode {
  // Intentional clear: an explicit null assertion gets the NUL glyph.
  if (value === null) {
    return <ClearedCell t={t} />;
  }
  // Absence: undefined or empty string — never asserted. Show a faint em-dash.
  if (value === undefined || value === '') {
    return <AbsentCell t={t} />;
  }

  // Status pill — universal for any string value on the status column
  if (key === 'status' && typeof value === 'string') {
    return <StatusPill value={value} t={t} />;
  }

  // Linked objects (CON)
  if (typeof value === 'object' && value !== null && value.linked && Array.isArray(value.linked)) {
    return (
      <span>
        {value.linked.map((target: string, i: number) => {
          const resolved = resolver?.resolveTarget(target);
          const shortId = target.split('.').pop() || target;
          return (
            <span key={target}>
              {i > 0 && ', '}
              <span
                style={{ color: t.purple, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: t.purpleBorder }}
                onClick={(e) => { e.stopPropagation(); onNavigate(target); }}
              >
                {shortId}
                {resolved?.name && <span style={{ textDecoration: 'none', color: t.text }}>{' · '}{resolved.name}</span>}
              </span>
            </span>
          );
        })}
      </span>
    );
  }

  // Arrays of ID-shaped strings (e.g. ["ATT-005", "ATT-003"]) — render as chips
  if (isIdArrayValue(value)) {
    return (
      <span>
        {value.map((id) => <IdChip key={id} value={id} t={t} resolved={resolver?.resolve(id)} onNavigate={onNavigate} />)}
      </span>
    );
  }

  // Single ID-shaped string (e.g. "ATT-006") — render as chip for consistency
  if (typeof value === 'string' && /^[A-Z]{2,5}-\d+$/.test(value)) {
    return <IdChip value={value} t={t} resolved={resolver?.resolve(value)} onNavigate={onNavigate} />;
  }

  // Other arrays: comma-joined primitives
  if (Array.isArray(value)) {
    if (value.every((v) => v == null || typeof v !== 'object')) {
      return <span>{value.filter((v) => v != null).join(', ') || <NullCell t={t} />}</span>;
    }
    const json = JSON.stringify(value);
    const display = json.length > 50 ? json.slice(0, 47) + '...' : json;
    return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{display}</span>;
  }

  // Other objects
  if (typeof value === 'object' && value !== null) {
    const json = JSON.stringify(value);
    const display = json.length > 50 ? json.slice(0, 47) + '...' : json;
    return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{display}</span>;
  }

  // Boolean
  if (typeof value === 'boolean') {
    return <span>{value ? 'Yes' : 'No'}</span>;
  }

  // Currency-shaped numeric keys
  if (isCurrencyKey(key)) {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    if (!Number.isNaN(n)) {
      return (
        <span style={{
          display: 'block',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {formatCurrency(n)}
        </span>
      );
    }
  }

  // Plain numbers — right-align with tabular numerals and thousands separators
  if (typeof value === 'number') {
    return (
      <span style={{
        display: 'block',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value.toLocaleString('en-US')}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

export function TableView({ scope, onSelectRecord, onViewHistory, onEmptyScope, activeRecord, session, timeScrubberFilter, permissions }: TableViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);

  const scopeRoot = scope.split('.')[0];
  const idResolver = useIdResolver(scopeRoot);

  const [records, setRecords] = useState<EoState[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [fieldNameMap, setFieldNameMap] = useState<Map<string, string>>(new Map());
  const [scopeName, setScopeName] = useState<string | null>(null);
  const [auditableDisplayField, setAuditableDisplayField] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  // Debounced filter text — used for actual filtering so that typing remains
  // responsive when the record set is large.
  const [debouncedFilterText, setDebouncedFilterText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: string } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number; key: string; label: string } | null>(null);
  const [renameCol, setRenameCol] = useState<{ key: string; value: string } | null>(null);
  const [typeSelector, setTypeSelector] = useState<{ x: number; y: number; target: string; currentType?: string } | null>(null);
  const [fieldSchemas, setFieldSchemas] = useState<Map<string, FieldSchema>>(new Map());
  const [columnTypeOverrides, setColumnTypeOverrides] = useState<Map<string, any>>(new Map());
  const [columnTypeSelector, setColumnTypeSelector] = useState<{ x: number; y: number; key: string } | null>(null);
  const prevRecordsKeyRef = useRef<string>('');
  const prevSchemaKeyRef = useRef<string>('');
  const prevScopeNameRef = useRef<string | null>(null);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // --- View store (SIG) ---
  const viewStore = useViewStore();
  const viewConfig = viewStore.getConfig(scope);
  const sorts = viewConfig.sorts;
  const advancedFilters = viewConfig.filters;
  const filterConjunction = viewConfig.filterConjunction;
  const hiddenColumnsArr = viewConfig.hiddenColumns;
  const hiddenColumns = useMemo(() => new Set(hiddenColumnsArr), [hiddenColumnsArr]);
  const columnOrder = viewConfig.columnOrder;
  const columnWidths = viewConfig.columnWidths;
  const rowHeight = viewConfig.rowHeight || 'default';
  const cellOverflow = viewConfig.cellOverflow || 'wrap';
  const profileFields = viewConfig.profileFields;
  const displayField = auditableDisplayField ?? viewConfig.displayField ?? null;
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();

  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [showColumnManager, setShowColumnManager] = useState(false);

  const setSorts = useCallback((s: SortRule[]) => viewStore.setSorts(scope, s), [scope, viewStore]);
  const setAdvancedFilters = useCallback((f: FilterRule[]) => viewStore.setFilters(scope, f), [scope, viewStore]);
  const setFilterConjunction = useCallback((c: 'AND' | 'OR') => viewStore.setFilterConjunction(scope, c), [scope, viewStore]);
  const setHiddenColumns = useCallback((fn: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof fn === 'function' ? fn(hiddenColumns) : fn;
    viewStore.setHiddenColumns(scope, [...next]);
  }, [scope, viewStore, hiddenColumns]);

  // --- Column resize state ---
  const [resizing, setResizing] = useState<{ key: string; startX: number; startWidth: number } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  // --- DnD sensors ---
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const scopeDepth = scope.split('.').length;

  // --- Column resize handlers ---
  useEffect(() => {
    if (!resizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizing.startX;
      const newWidth = Math.max(MIN_COLUMN_WIDTH, resizing.startWidth + delta);
      viewStore.setColumnWidth(scope, resizing.key, newWidth);
    };
    const handleMouseUp = () => setResizing(null);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing, scope, viewStore]);

  // --- Column drag-end handler ---
  function handleColumnDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const currentOrder = orderedColumns.map((c) => c.key);
    const oldIndex = currentOrder.indexOf(active.id as string);
    const newIndex = currentOrder.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
    viewStore.setColumnOrder(scope, newOrder);
  }

  // Load records and field metadata
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(scope + '.').then((states) => {
      const direct = states
        .filter((st) => {
          const parts = st.target.split('.');
          if (parts.length !== scopeDepth + 1 || st.value?._alias) return false;
          // Hide internal entities (e.g. _schema)
          const segment = parts[parts.length - 1];
          if (segment.startsWith('_')) return false;
          return true;
        })
        .map((st) => {
          // When fields is an array of DEFs ({id,name,type}), flatten into
          // a fields object keyed by name so each field renders as a column.
          const f = st.value?.fields;
          if (Array.isArray(f) && f.length > 0 && f[0]?.name) {
            const expanded: Record<string, any> = {};
            for (const field of f) {
              expanded[field.name] = field.type ?? '';
            }
            return { ...st, value: { ...st.value, fields: expanded } };
          }
          return st;
        });
      // Only update state if records actually changed (avoids flicker from lastSeq)
      const key = direct.map(r => r.target + ':' + r.last_seq).join('|');
      if (key !== prevRecordsKeyRef.current) {
        prevRecordsKeyRef.current = key;
        setRecords(direct);
      }
      setRecordsLoaded(true);
    });
    // Fetch field metadata: prefer per-field schema entities, fall back to array on table state
    getStateByPrefix(scope + '._schema.').then((allSchemaStates) => {
      // Only process schema if it actually changed
      const schemaKey = allSchemaStates.map(s => s.target + ':' + s.last_seq).join('|');
      if (schemaKey === prevSchemaKeyRef.current) return;
      prevSchemaKeyRef.current = schemaKey;

      const schemaPrefix = scope + '._schema.';
      // Filter to direct children of _schema only
      const schemaDepth = scope.split('.').length + 2; // scope._schema.fieldId
      const fieldStates = allSchemaStates.filter(
        (st) => st.target.split('.').length === schemaDepth && !st.value?._alias,
      );
      if (fieldStates.length > 0) {
        setFieldNameMap(buildFieldNameMapFromSchema(fieldStates));
      } else {
        // Fallback: read field metadata from table state array
        getState(scope).then((scopeState) => {
          const fields = scopeState?.value?.fields;
          if (Array.isArray(fields)) {
            setFieldNameMap(buildFieldNameMap(fields));
          } else {
            setFieldNameMap(new Map());
          }
        });
      }
      // Group all schema states (including .type, .constraint.*, .resolve children) for schema rules
      const grouped = groupSchemaStates(allSchemaStates, schemaPrefix);
      setFieldSchemas(grouped);
      setColumnTypeOverrides(extractColumnTypeOverrides(grouped));
    });
    // Fetch scope display name and auditable display field
    getState(scope).then((scopeState) => {
      const name = scopeState?.value?.name ?? null;
      if (name !== prevScopeNameRef.current) {
        prevScopeNameRef.current = name;
        setScopeName(name);
      }
      setAuditableDisplayField(scopeState?.value?._displayField ?? null);
    });
  }, [ready, lastSeq, getStateByPrefix, getState, scope, scopeDepth]);

  // When scope has no records and no state of its own, navigate up to parent scope
  useEffect(() => {
    if (!recordsLoaded) return;
    if (records.length === 0 && onEmptyScope) {
      // Don't navigate away if the scope itself has state — it's a leaf record
      getState(scope).then((scopeState) => {
        if (scopeState?.value && !scopeState.value._alias) return;
        const parts = scope.split('.');
        if (parts.length > 1) {
          const parentScope = parts.slice(0, -1).join('.');
          onEmptyScope(parentScope);
        }
      });
    }
  }, [records, recordsLoaded, scope, onEmptyScope, getState]);

  // Reset filter and loaded state when scope changes
  useEffect(() => {
    setFilterText('');
    setDebouncedFilterText('');
    setRecordsLoaded(false);
    prevRecordsKeyRef.current = '';
    prevSchemaKeyRef.current = '';
    prevScopeNameRef.current = null;
    setAuditableDisplayField(null);
  }, [scope]);

  // Debounce filterText so that keystroke latency is bounded by a short
  // timer rather than the cost of re-filtering the full record set.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedFilterText(filterText), 150);
    return () => clearTimeout(id);
  }, [filterText]);

  // Detect if records use the Airtable-style fields sub-object
  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);

  const entityColumns = useMemo(() => deriveColumns(records, fieldNameMap, columnTypeOverrides), [records, fieldNameMap, columnTypeOverrides]);
  const columns = useMemo<ColumnDef[]>(() => {
    const all = [
      { key: '_record', label: 'record', type: 'text' as const },
      ...entityColumns,
      { key: '_last_updated', label: 'last updated', type: 'text' as const },
    ];
    if (hiddenColumns.size === 0) return all;
    return all.filter((col) => !hiddenColumns.has(col.key));
  }, [entityColumns, hiddenColumns]);

  // Apply column ordering from view store
  const orderedColumns = useMemo<ColumnDef[]>(() => {
    if (columnOrder.length === 0) return columns;
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const ordered: ColumnDef[] = [];
    // First add columns in the saved order
    for (const key of columnOrder) {
      const col = byKey.get(key);
      if (col) {
        ordered.push(col);
        byKey.delete(key);
      }
    }
    // Then append any new columns not in the saved order
    for (const col of columns) {
      if (byKey.has(col.key)) ordered.push(col);
    }
    return ordered;
  }, [columns, columnOrder]);

  const filtered = useMemo(() => {
    let result = records;

    // Text filter
    if (debouncedFilterText) {
      const q = debouncedFilterText.toLowerCase();
      result = result.filter((rec) => {
        const target = rec.target.toLowerCase();
        if (target.includes(q)) return true;
        if (rec.value) {
          const source = useFieldsSub && rec.value.fields && typeof rec.value.fields === 'object'
            ? rec.value.fields
            : rec.value;
          return Object.values(source).some(v =>
            v != null && String(v).toLowerCase().includes(q)
          );
        }
        return false;
      });
    }
    // Advanced filters (FilterBar)
    if (advancedFilters.length > 0) {
      result = applyFilters(result, advancedFilters, filterConjunction, useFieldsSub);
    }
    // Time scrubber filter
    if (timeScrubberFilter) {
      result = applyTimeScrubber(result, timeScrubberFilter, useFieldsSub);
    }

    // Multi-column sort
    if (sorts.length > 0) {
      result = [...result].sort((a, b) => {
        for (const sort of sorts) {
          const aVal = sort.field === '_record'
            ? ((displayField ? getFieldValue(a, displayField, useFieldsSub) : null) ?? resolveRecordName(a) ?? a.target.split('.').pop() ?? '')
            : getFieldValue(a, sort.field, useFieldsSub);
          const bVal = sort.field === '_record'
            ? ((displayField ? getFieldValue(b, displayField, useFieldsSub) : null) ?? resolveRecordName(b) ?? b.target.split('.').pop() ?? '')
            : getFieldValue(b, sort.field, useFieldsSub);
          const aStr = aVal != null ? String(aVal) : '';
          const bStr = bVal != null ? String(bVal) : '';
          const aNum = Number(aStr);
          const bNum = Number(bStr);
          const cmp = (!isNaN(aNum) && !isNaN(bNum) && aStr !== '' && bStr !== '')
            ? aNum - bNum
            : aStr.localeCompare(bStr);
          const directed = sort.direction === 'asc' ? cmp : -cmp;
          if (directed !== 0) return directed;
        }
        return 0;
      });
    }
    return result;
  }, [records, debouncedFilterText, useFieldsSub, advancedFilters, filterConjunction, timeScrubberFilter, sorts, displayField]);

  function handleColumnContextMenu(e: React.MouseEvent, col: ColumnDef) {
    e.preventDefault();
    e.stopPropagation();
    setColumnMenu({ x: e.clientX, y: e.clientY, key: col.key, label: col.label });
    setContextMenu(null);
  }

  function getColumnMenuItems(colKey: string, colLabel: string): ContextMenuItem[] {
    const activeSort = sorts.find((s) => s.field === colKey);
    const currentCol = entityColumns.find((c) => c.key === colKey);
    const fs = fieldSchemas.get(colKey);
    const isSystemCol = colKey === '_record' || colKey === '_last_updated';

    const items: ContextMenuItem[] = [
      {
        label: 'Rename column',
        onClick: () => {
          setRenameCol({ key: colKey, value: colLabel });
          setColumnMenu(null);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: `Sort ascending${activeSort?.direction === 'asc' ? ' (active)' : ''}`,
        onClick: () => setSorts([{ id: crypto.randomUUID(), field: colKey, direction: 'asc' }]),
      },
      {
        label: `Sort descending${activeSort?.direction === 'desc' ? ' (active)' : ''}`,
        onClick: () => setSorts([{ id: crypto.randomUUID(), field: colKey, direction: 'desc' }]),
      },
      ...(activeSort ? [{
        label: 'Remove sort',
        onClick: () => setSorts(sorts.filter((s) => s.field !== colKey)),
      }] : []),
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Filter by this column',
        onClick: () => {
          const col = entityColumns.find((c) => c.key === colKey);
          setAdvancedFilters([
            ...advancedFilters,
            { id: crypto.randomUUID(), field: colKey, operator: col?.type === 'number' ? 'gt' : 'contains', value: '' },
          ]);
        },
      },
    ];

    // ─── ⊢ Definitions ───
    if (!isSystemCol) {
      const typeLabel = fs?.typeDef
        ? `${fs.typeDef.value?.type ?? 'unknown'}${fs.typeDef.value?.format ? ` (${fs.typeDef.value.format})` : ''}`
        : `${currentCol?.type ?? 'text'} (inferred)`;

      items.push(
        { label: '', onClick: () => {}, separator: true },
        { header: true, icon: '⊢', label: 'Definitions', onClick: () => {} },
        {
          label: `Type: ${typeLabel}`,
          onClick: () => {
            setColumnTypeSelector({ key: colKey, x: columnMenu?.x ?? 0, y: columnMenu?.y ?? 0 });
            setColumnMenu(null);
          },
        },
        // List existing constraints
        ...fs?.constraints.map(c => ({
          label: `Constraint: ${c.name}`,
          disabled: true,
          onClick: () => {},
        })) ?? [],
      );

      // ─── ⊨ Evaluations ───
      items.push(
        { label: '', onClick: () => {}, separator: true },
        { header: true, icon: '⊨', label: 'Evaluations', onClick: () => {} },
        {
          label: fs?.resolve
            ? `Resolution: ${fs.resolve.value?.strategy ?? 'unknown'}`
            : 'Set resolution...',
          onClick: () => {
            // Resolution selector — dispatch EVA with latest-wins for now
            if (!fs?.resolve) {
              handleSetResolution(colKey);
            }
          },
        },
      );
    }

    // ─── Visibility ───
    items.push({ label: '', onClick: () => {}, separator: true });
    if (!isSystemCol) {
      items.push(
        {
          label: displayField === colKey ? 'Display name (active)' : 'Use as display name',
          onClick: async () => {
            const newField = displayField === colKey ? null : colKey;
            try {
              await dispatch({
                op: 'DEF',
                target: scope,
                operand: { _displayField: newField },
                agent: `user:${session.userId}`,
                ts: new Date().toISOString(),
                acquired_ts: new Date().toISOString(),
              });
              setAuditableDisplayField(newField);
            } catch { /* ignore */ }
          },
        },
        { label: '', onClick: () => {}, separator: true },
      );
    }
    items.push({
      label: 'Hide column',
      onClick: () => viewStore.toggleHiddenColumn(scope, colKey),
    });
    if (hiddenColumns.size > 0) {
      items.push({
        label: `Show all columns (${hiddenColumns.size} hidden)`,
        onClick: () => viewStore.showAllColumns(scope),
      });
    }
    return items;
  }

  async function handleColumnRename(fieldKey: string, newLabel: string) {
    const schemaTarget = `${scope}._schema.${fieldKey}`;
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTarget,
        operand: { _label: newLabel },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      // Update local field name map immediately
      setFieldNameMap((prev) => {
        const next = new Map(prev);
        next.set(fieldKey, newLabel);
        return next;
      });
    } catch { /* ignore */ }
    setRenameCol(null);
  }

  async function handleSetColumnType(fieldKey: string, type: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTypeTarget(scope, fieldKey),
        operand: { type },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      // Update local state immediately
      setColumnTypeOverrides((prev) => {
        const next = new Map(prev);
        next.set(fieldKey, { type });
        return next;
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        next.set(fieldKey, {
          ...existing,
          typeDef: { target: schemaTypeTarget(scope, fieldKey), value: { type } },
        });
        return next;
      });
    } catch { /* ignore */ }
    setColumnTypeSelector(null);
  }

  async function handleClearColumnType(fieldKey: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTypeTarget(scope, fieldKey),
        operand: {},
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setColumnTypeOverrides((prev) => {
        const next = new Map(prev);
        next.delete(fieldKey);
        return next;
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey);
        if (existing) {
          next.set(fieldKey, { ...existing, typeDef: undefined });
        }
        return next;
      });
    } catch { /* ignore */ }
    setColumnTypeSelector(null);
  }

  async function handleSetResolution(fieldKey: string) {
    try {
      await dispatch({
        op: 'EVA',
        target: schemaResolveTarget(scope, fieldKey),
        operand: { strategy: 'latest' },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        next.set(fieldKey, {
          ...existing,
          resolve: { target: schemaResolveTarget(scope, fieldKey), value: { strategy: 'latest' } },
        });
        return next;
      });
    } catch { /* ignore */ }
  }

  function handleContextMenu(e: React.MouseEvent, target: string) {
    e.preventDefault();
    e.stopPropagation();
    const rec = records.find((r) => r.target === target);
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  }

  function getContextMenuItems(target: string): ContextMenuItem[] {
    const rec = records.find((r) => r.target === target);
    const canEdit = permissions ? permissions.can_edit_any_record || permissions.can_edit_own_records : true;
    const items: ContextMenuItem[] = [];

    if (canEdit) {
      items.push({
        label: rec?.value?._type ? `Change type (${rec.value._type})` : 'Set page type...',
        onClick: () => {
          setTypeSelector({
            x: contextMenu!.x,
            y: contextMenu!.y,
            target,
            currentType: rec?.value?._type,
          });
          setContextMenu(null);
        },
      });
    }

    items.push({
      label: 'View history',
      onClick: () => {
        onViewHistory?.(target);
        onSelectRecord(target);
      },
    });
    items.push({ label: '', onClick: () => {}, separator: true });
    items.push({
      label: 'Copy target path',
      onClick: () => navigator.clipboard.writeText(target),
    });

    return items;
  }

  async function handleAddRecord() {
    const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const recordTarget = `${scope}.rec${shortId}`;
    try {
      await dispatch({
        op: 'INS',
        target: recordTarget,
        operand: {},
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      });
      onSelectRecord(recordTarget);
    } catch { /* ignore */ }
  }

  async function handleSaveSegment(name: string) {
    try {
      await dispatch({
        op: 'SEG',
        target: `${scope}._segments.${name.replace(/\s+/g, '_').toLowerCase()}`,
        operand: {
          name,
          filters: advancedFilters,
          conjunction: filterConjunction,
          created_at: new Date().toISOString(),
        },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  }

  async function handleTypeChange(target: string, type: string) {
    try {
      await dispatch({
        op: 'DEF',
        target,
        operand: { _type: type || undefined },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setTypeSelector(null);
  }

  return (
    <div style={s.container}>
      {/* Toolbar */}
      <div style={{
        ...s.toolbar,
        ...(isMobile ? { flexWrap: 'wrap' as const, gap: 8, padding: '8px 12px' } : {}),
      }}>
        <div style={s.toolbarLeft}>
          <div style={s.scopeName}>{scopeName || formatScopeName(scope)}</div>
          <span style={s.recordCount}>{filtered.length}</span>
          {!isMobile && (() => {
            const totalDefs = Array.from(fieldSchemas.values()).reduce(
              (sum, fs) => sum + (fs.typeDef ? 1 : 0) + fs.constraints.length, 0);
            const totalEvas = Array.from(fieldSchemas.values()).reduce(
              (sum, fs) => sum + (fs.resolve ? 1 : 0), 0);
            if (totalDefs === 0 && totalEvas === 0) return null;
            return (
              <span style={s.schemaBadges}>
                {totalDefs > 0 && <span style={s.schemaBadge}>{totalDefs} DEF</span>}
                {totalEvas > 0 && <span style={s.schemaBadge}>{totalEvas} EVA</span>}
              </span>
            );
          })()}
          {(permissions?.can_add_records !== false) && (
            <button onClick={handleAddRecord} style={{
              ...s.addRecordBtn,
              ...(isMobile ? { padding: '6px 10px', fontSize: 11 } : {}),
            }}>
              + New
            </button>
          )}
        </div>
        <div style={{
          ...s.toolbarRight,
          ...(isMobile ? { flexWrap: 'wrap' as const, gap: 6 } : {}),
        }}>
          <FilterBar
            columns={entityColumns}
            filters={advancedFilters}
            onFiltersChange={setAdvancedFilters}
            conjunction={filterConjunction}
            onConjunctionChange={setFilterConjunction}
            onSaveSegment={handleSaveSegment}
            scope={scope}
          />
          <SortPanel
            columns={columns}
            sorts={sorts}
            onSortsChange={setSorts}
          />
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search…"
            style={{
              ...s.filterInput,
              ...(isMobile ? { width: 100, flex: '1 1 100px', minWidth: 80 } : {}),
            }}
          />

          {/* Row height toggle — hidden on mobile */}
          {!isMobile && (
          <div style={{ display: 'flex', gap: 2 }}>
            {(['compact', 'default', 'tall'] as const).map((h, i) => {
              const labels = ['S', 'M', 'L'];
              const isActive = rowHeight === h;
              return (
                <button
                  key={h}
                  onClick={() => viewStore.setRowHeight(scope, h)}
                  title={h.charAt(0).toUpperCase() + h.slice(1)}
                  style={{
                    ...s.toggleBtn,
                    padding: '0 6px',
                    minWidth: 24,
                    background: isActive ? theme.accentBg : 'transparent',
                    color: isActive ? theme.accent : theme.textMuted,
                    border: `1px solid ${isActive ? theme.accentBorder : theme.border}`,
                    borderRadius: i === 0 ? '4px 0 0 4px' : i === 2 ? '0 4px 4px 0' : 0,
                    borderRight: i < 2 ? 'none' : undefined,
                  }}
                >
                  {labels[i]}
                </button>
              );
            })}
          </div>
          )}

          {/* Cell overflow toggle — hidden on mobile */}
          {!isMobile && (
          <div style={{ display: 'flex', gap: 2 }}>
            {(['clip', 'wrap'] as const).map((mode, i) => {
              const isActive = cellOverflow === mode;
              const icon = mode === 'clip' ? '\u2014' : '\u21B5';
              const label = mode === 'clip'
                ? 'Truncate cell text with ellipsis'
                : 'Wrap cell text across multiple lines';
              return (
                <button
                  key={mode}
                  onClick={() => viewStore.setCellOverflow(scope, mode)}
                  title={label}
                  aria-label={label}
                  aria-pressed={isActive}
                  style={{
                    ...s.toggleBtn,
                    padding: '0 8px',
                    minWidth: 28,
                    fontWeight: isActive ? 600 : 400,
                    background: isActive ? theme.accentBg : 'transparent',
                    color: isActive ? theme.accent : theme.textMuted,
                    border: `1px solid ${isActive ? theme.accentBorder : theme.border}`,
                    borderRadius: i === 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                    borderRight: i === 0 ? 'none' : undefined,
                  }}
                >
                  {icon}
                </button>
              );
            })}
          </div>
          )}

          {/* Column manager (Fields) */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setShowColumnManager((prev) => !prev)}
              style={{
                ...s.toggleBtn,
                background: hiddenColumns.size > 0 ? theme.accentBg : 'transparent',
                color: hiddenColumns.size > 0 ? theme.accent : theme.textMuted,
                border: `1px solid ${hiddenColumns.size > 0 ? theme.accentBorder : theme.border}`,
              }}
              title="Show/hide and reorder table columns"
            >
              {'\u2630'}{!isMobile && <> Fields{hiddenColumns.size > 0 ? ` (${hiddenColumns.size} hidden)` : ''}</>}
            </button>
            {showColumnManager && (
              <ColumnManagerPanel
                allColumns={[
                  { key: '_record', label: 'record', type: 'text' as const },
                  ...entityColumns,
                  { key: '_last_updated', label: 'last updated', type: 'text' as const },
                ]}
                columnOrder={columnOrder}
                hiddenColumns={hiddenColumns}
                onToggleColumn={(key) => viewStore.toggleHiddenColumn(scope, key)}
                onReorder={(order) => viewStore.setColumnOrder(scope, order)}
                onShowAll={() => viewStore.showAllColumns(scope)}
                onHideAll={() => {
                  const allKeys = entityColumns.map((c) => c.key).concat(['_record', '_last_updated']);
                  viewStore.setHiddenColumns(scope, allKeys);
                }}
                onClose={() => setShowColumnManager(false)}
              />
            )}
          </div>

          {/* Profile fields picker */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setShowProfilePicker((prev) => !prev)}
              style={{
                ...s.toggleBtn,
                background: profileFields ? theme.accentBg : 'transparent',
                color: profileFields ? theme.accent : theme.textMuted,
                border: `1px solid ${profileFields ? theme.accentBorder : theme.border}`,
              }}
              title="Choose which fields appear in the record detail drawer"
            >
              {'\u229E'} Detail fields
            </button>
            {showProfilePicker && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                  onClick={() => setShowProfilePicker(false)}
                />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 9999,
                  background: theme.bgCard, border: `1px solid ${theme.border}`,
                  borderRadius: 8, padding: 12, boxShadow: `0 8px 30px ${theme.shadow}`,
                  minWidth: 200, maxHeight: 320, overflowY: 'auto',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: theme.textHeading }}>
                    Detail Fields
                  </div>
                  {entityColumns.map((col) => {
                    const isChecked = !profileFields || profileFields.includes(col.key);
                    return (
                      <label
                        key={col.key}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '4px 0', fontSize: 12, color: theme.text, cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            const current = profileFields || entityColumns.map((c) => c.key);
                            const next = isChecked
                              ? current.filter((k) => k !== col.key)
                              : [...current, col.key];
                            viewStore.setProfileFields(scope, next.length === entityColumns.length ? undefined : next);
                          }}
                        />
                        {col.label}
                      </label>
                    );
                  })}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
                    <button
                      onClick={() => viewStore.setProfileFields(scope, undefined)}
                      style={{ fontSize: 10, background: 'none', border: 'none', color: theme.accent, cursor: 'pointer' }}
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => viewStore.setProfileFields(scope, [])}
                      style={{ fontSize: 10, background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer' }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div style={s.tableWrap}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleColumnDragEnd}>
          <table ref={tableRef} style={{ ...s.table, tableLayout: 'fixed' }}>
            <colgroup>
              {orderedColumns.map((col) => (
                <col key={col.key} style={{ width: columnWidths[col.key] || defaultColumnWidth(col.type) }} />
              ))}
            </colgroup>
            <thead>
              <SortableContext items={orderedColumns.map((c) => c.key)} strategy={horizontalListSortingStrategy}>
                <tr>
                  {orderedColumns.map((col) => (
                    <SortableColumnHeader
                      key={col.key}
                      col={col}
                      theme={theme}
                      thStyle={s.th}
                      sorts={sorts}
                      renameCol={renameCol}
                      permissions={permissions}
                      isResizing={resizing?.key === col.key}
                      disabled={col.key === '_record'}
                      onContextMenu={(e) => handleColumnContextMenu(e, col)}
                      onRename={(val) => handleColumnRename(col.key, val)}
                      onCancelRename={() => setRenameCol(null)}
                      onResizeStart={(startX) => {
                        const width = columnWidths[col.key] || defaultColumnWidth(col.type);
                        setResizing({ key: col.key, startX, startWidth: width });
                      }}
                    />
                  ))}
                </tr>
              </SortableContext>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={orderedColumns.length} style={s.emptyRow}>
                    {records.length === 0 ? 'No records in this scope' : 'No records match the current filter'}
                  </td>
                </tr>
              )}
              {filtered.map((rec, rowIndex) => {
                const isActive = rec.target === activeRecord;
                const zebraBg = rowIndex % 2 === 0 ? theme.bgCard : theme.bgMuted;
                return (
                  <tr
                    key={rec.target}
                    style={{ background: isActive ? theme.accentBg : zebraBg }}
                    onClick={() => onSelectRecord(rec.target)}
                    onContextMenu={(e) => handleContextMenu(e, rec.target)}
                    onMouseEnter={(e) => {
                      if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) (e.currentTarget as HTMLElement).style.background = zebraBg;
                    }}
                  >
                    {orderedColumns.map((col, colIndex) => {
                      const isRedacted = permissions?.redacted_fields?.includes(col.key);
                      const isLocked = permissions?.locked_fields?.includes(col.key);
                      const tdStyle = colIndex === 0
                        ? { ...s.td, borderLeft: `3px solid ${theme.accent}` }
                        : s.td;
                      return (
                        <td key={col.key} style={{
                          ...tdStyle,
                          padding: `${rowHeight === 'compact' ? 4 : rowHeight === 'tall' ? 18 : 10}px 8px ${rowHeight === 'compact' ? 4 : rowHeight === 'tall' ? 18 : 10}px 20px`,
                          ...(cellOverflow === 'clip'
                            ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: 'normal' as const }
                            : { whiteSpace: 'normal', wordBreak: 'break-word' as const }),
                        }}>
                          {isRedacted
                            ? <RedactedCell />
                            : col.key === '_record'
                            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <span style={{
                                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                                  color: theme.accent, cursor: 'pointer',
                                }}>{(() => {
                                  const dv = displayField ? getFieldValue(rec, displayField, useFieldsSub) : null;
                                  if (dv != null && typeof dv !== 'object') return String(dv);
                                  return resolveRecordName(rec) || formatName(rec.target.split('.').pop() || '');
                                })()}</span>
                                {rec.value?._type && <TypeBadge type={rec.value._type} />}
                              </span>
                            : col.key === '_last_updated'
                            ? <span style={{
                                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                                color: theme.textSecondary,
                              }}>{rec.last_ts ? formatRelativeTime(rec.last_ts) : <AbsentCell t={theme} />}</span>
                            : isLocked
                            ? <LockedCell>{renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme, idResolver)}</LockedCell>
                            : renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme, idResolver)
                          }
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </DndContext>
      </div>

      {/* Right-click context menu (rows) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.target)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Right-click context menu (columns) */}
      {columnMenu && (
        <ContextMenu
          x={columnMenu.x}
          y={columnMenu.y}
          items={getColumnMenuItems(columnMenu.key, columnMenu.label)}
          onClose={() => setColumnMenu(null)}
        />
      )}

      {/* Type selector popover */}
      {typeSelector && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setTypeSelector(null)}
          />
          <div style={{
            position: 'fixed',
            left: typeSelector.x,
            top: typeSelector.y,
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
          }}>
            <TypeSelector
              currentType={typeSelector.currentType}
              onSelect={(type) => handleTypeChange(typeSelector.target, type)}
              onClose={() => setTypeSelector(null)}
            />
          </div>
        </>
      )}
      {columnTypeSelector && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setColumnTypeSelector(null)}
          />
          <div style={{
            position: 'fixed',
            left: columnTypeSelector.x,
            top: columnTypeSelector.y,
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
          }}>
            <ColumnTypeSelector
              currentType={
                fieldSchemas.get(columnTypeSelector.key)?.typeDef?.value?.type
                ?? entityColumns.find(c => c.key === columnTypeSelector.key)?.type
                ?? 'text'
              }
              isDefined={!!fieldSchemas.get(columnTypeSelector.key)?.typeDef}
              onSelect={(type) => handleSetColumnType(columnTypeSelector.key, type)}
              onClear={() => handleClearColumnType(columnTypeSelector.key)}
              onClose={() => setColumnTypeSelector(null)}
            />
          </div>
        </>
      )}
    </div>
  );
}

// --- Sortable Column Header ---

interface SortableColumnHeaderProps {
  col: ColumnDef;
  theme: Theme;
  thStyle: React.CSSProperties;
  sorts: SortRule[];
  renameCol: { key: string; value: string } | null;
  permissions?: ResolvedPermissions | null;
  isResizing: boolean;
  disabled: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (val: string) => void;
  onCancelRename: () => void;
  onResizeStart: (startX: number) => void;
}

function SortableColumnHeader({
  col, theme, thStyle, sorts, renameCol, permissions,
  isResizing, disabled, onContextMenu, onRename, onCancelRename, onResizeStart,
}: SortableColumnHeaderProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col.key, disabled });

  const style: React.CSSProperties = {
    ...thStyle,
    cursor: disabled ? 'default' : 'grab',
    userSelect: 'none',
    position: 'sticky' as const,
    top: 0,
    transform: CSS.Transform.toString(transform ? { ...transform, y: 0 } : null),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 2,
  };

  const isLocked = permissions?.locked_fields?.includes(col.key);

  return (
    <th
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(disabled ? {} : listeners)}
      onContextMenu={onContextMenu}
    >
      {renameCol?.key === col.key ? (
        <input
          autoFocus
          defaultValue={renameCol.value}
          style={{
            fontSize: 11, fontWeight: 400, border: `1px solid ${theme.accent}`,
            borderRadius: 3, padding: '2px 4px', background: theme.bgCard,
            color: theme.text, outline: 'none', width: '100%',
            textTransform: 'none' as const,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') onCancelRename();
          }}
          onBlur={(e) => onRename(e.target.value)}
        />
      ) : (
        <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {isLocked && <LockIcon />}
          {col.label}
          {sorts.find((s) => s.field === col.key) && (
            <span style={{ marginLeft: 4, fontSize: 10 }}>
              {sorts.find((s) => s.field === col.key)!.direction === 'asc' ? '\u25B4' : '\u25BE'}
            </span>
          )}
        </span>
      )}
      {/* Resize handle */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 5,
          height: '100%',
          cursor: 'col-resize',
          background: isResizing ? theme.accent : theme.border,
          zIndex: 3,
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onResizeStart(e.clientX);
        }}
        onMouseEnter={(e) => {
          if (!isResizing) (e.currentTarget as HTMLElement).style.background = theme.borderDivider;
        }}
        onMouseLeave={(e) => {
          if (!isResizing) (e.currentTarget as HTMLElement).style.background = theme.border;
        }}
      />
    </th>
  );
}

// --- Styles ---

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: t.bgCard,
    },
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 20px',
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    toolbarLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    toolbarRight: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    scopeName: {
      fontSize: 14,
      fontWeight: 500,
      color: t.textHeading,
    },
    recordCount: {
      fontSize: 12,
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 4,
    },
    schemaBadges: {
      display: 'inline-flex',
      gap: 4,
      marginLeft: 2,
    },
    schemaBadge: {
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 4,
      letterSpacing: '0.02em',
    },
    addRecordBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '5px 12px',
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 6,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
    },
    toggleBtn: {
      height: 28,
      fontSize: 11,
      padding: '0 10px',
      borderRadius: 4,
      cursor: 'pointer',
      fontWeight: 500,
      whiteSpace: 'nowrap' as const,
    },
    filterInput: {
      width: 140,
      height: 28,
      fontSize: 12,
      padding: '0 8px',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
    },
    tableWrap: {
      flex: 1,
      overflowX: 'auto',
      overflowY: 'auto',
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12,
      color: t.textHeading,
    } as React.CSSProperties,
    th: {
      position: 'relative' as const,
      background: t.bgCard,
      padding: '8px 8px 8px 12px',
      textAlign: 'left' as const,
      fontSize: 11,
      fontWeight: 400,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.3px',
      color: t.textMuted,
      borderBottom: `2px solid ${t.borderDivider}`,
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden' as const,
      textOverflow: 'ellipsis' as const,
    },
    td: {
      padding: '8px 8px 8px 12px',
      borderBottom: `1px solid ${t.borderLight}`,
      verticalAlign: 'middle' as const,
      maxWidth: 300,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'normal' as const,
      wordBreak: 'break-word' as const,
    },
    emptyRow: {
      padding: '40px 16px',
      textAlign: 'center' as const,
      color: t.textMuted,
      fontSize: 12,
    },
  };
}
