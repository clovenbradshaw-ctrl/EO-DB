import { useEffect, useMemo, useRef, useState } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { useSliceStore } from '../store/slice-store';
import { useTheme, type Theme } from '../theme';
import {
  deriveColumns,
  buildFieldNameMap,
  buildFieldNameMapFromSchema,
  hasFieldsSubObject,
  getFieldValue,
  type ColumnDef,
} from './filter-types';
import { groupSchemaStates, extractColumnTypeOverrides } from '../db/schema-rules';
import { isDeleted } from '../db/tombstone';
import { resolveRecordName } from './TableView';
import type { ResolvedPermissions } from '../permissions/types';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';

const NONE_GROUP_KEY = '__none__';
const NONE_GROUP_LABEL = '(none)';

/** Stable pastel color derived from a group value. Not cryptographic. */
function hashColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 62%, 58%)`;
}

interface KanbanViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  activeRecord?: string | null;
  session: { userId: string };
  permissions?: ResolvedPermissions | null;
  sliceReadOnly?: boolean;
}

export function KanbanView({
  scope,
  onSelectRecord,
  activeRecord,
  session,
  permissions,
  sliceReadOnly,
}: KanbanViewProps) {
  const { theme } = useTheme();
  const s = styles(theme);

  // Store hooks — mirror TableView:477-482
  const getStateByPrefix = useEoStore((st) => st.getStateByPrefix);
  const getState = useEoStore((st) => st.getState);
  const dispatch = useEoStore((st) => st.dispatch);
  const ready = useEoStore((st) => st.ready);
  const lastSeq = useEoStore((st) => st.lastSeq);
  const sliceStore = useSliceStore();

  const config = sliceStore.getConfig(scope);
  const kanbanField = config.kanbanField;

  const [records, setRecords] = useState<EoState[]>([]);
  const [fieldNameMap, setFieldNameMap] = useState<Map<string, string>>(new Map());
  const [columnTypeOverrides, setColumnTypeOverrides] = useState<Map<string, any>>(new Map());
  const [activeDragRec, setActiveDragRec] = useState<string | null>(null);

  // Optimistic overrides for drag-drop: target -> new group value. Cleared on re-fetch.
  const [optimistic, setOptimistic] = useState<Record<string, string | null>>({});

  const fetchGenRef = useRef(0);
  const scopeDepth = scope.split('.').length;

  // Load records + schema — simplified version of TableView:622-725
  useEffect(() => {
    if (!ready) return;
    const gen = ++fetchGenRef.current;

    function filterDirect(states: EoState[]): EoState[] {
      return states.filter((st) => {
        const parts = st.target.split('.');
        if (parts.length !== scopeDepth + 1 || st.value?._alias) return false;
        const segment = parts[parts.length - 1];
        if (segment.startsWith('_')) return false;
        if (isDeleted(st)) return false;
        return true;
      });
    }

    getStateByPrefix(scope + '.').then((states) => {
      if (gen !== fetchGenRef.current) return;
      const direct = filterDirect(states);
      setRecords(direct);
      // Clear optimistic state once real data arrives — the DEF event has been folded in.
      setOptimistic({});
    });

    getStateByPrefix(scope + '._schema.').then((allSchemaStates) => {
      if (gen !== fetchGenRef.current) return;
      const schemaPrefix = scope + '._schema.';
      const schemaDepth = scope.split('.').length + 2;
      const fieldStates = allSchemaStates.filter(
        (st) => st.target.split('.').length === schemaDepth && !st.value?._alias,
      );
      if (fieldStates.length > 0) {
        setFieldNameMap(buildFieldNameMapFromSchema(fieldStates));
      } else {
        getState(scope).then((scopeState) => {
          if (gen !== fetchGenRef.current) return;
          const fields = scopeState?.value?.fields;
          if (Array.isArray(fields)) {
            setFieldNameMap(buildFieldNameMap(fields));
          } else {
            setFieldNameMap(new Map());
          }
        });
      }
      const grouped = groupSchemaStates(allSchemaStates, schemaPrefix);
      setColumnTypeOverrides(extractColumnTypeOverrides(grouped));
    });
  }, [ready, lastSeq, getStateByPrefix, getState, scope, scopeDepth]);

  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);
  const columns = useMemo<ColumnDef[]>(
    () => deriveColumns(records, fieldNameMap, columnTypeOverrides, false),
    [records, fieldNameMap, columnTypeOverrides],
  );

  const kanbanColumn = useMemo<ColumnDef | null>(
    () => (kanbanField ? columns.find((c) => c.key === kanbanField) ?? null : null),
    [columns, kanbanField],
  );

  const selectCandidates = useMemo(
    () => columns.filter((c) => c.type === 'select'),
    [columns],
  );

  // Derive groups. Map: group key -> { label, value, records[] }
  const groups = useMemo(() => {
    if (!kanbanField || !kanbanColumn || kanbanColumn.type !== 'select') {
      return [] as { key: string; label: string; records: EoState[] }[];
    }
    const order: string[] = kanbanColumn.selectOptions ? [...kanbanColumn.selectOptions] : [];
    const extra = new Set<string>();
    const buckets = new Map<string, EoState[]>();
    // Seed columns so users see empty columns too
    for (const v of order) buckets.set(v, []);
    buckets.set(NONE_GROUP_KEY, []);

    for (const rec of records) {
      const override = optimistic[rec.target];
      const raw = override !== undefined
        ? override
        : getFieldValue(rec, kanbanField, useFieldsSub);
      const val = typeof raw === 'string' && raw.length > 0 ? raw : null;
      const key = val ?? NONE_GROUP_KEY;
      if (!buckets.has(key)) {
        buckets.set(key, []);
        extra.add(key);
      }
      buckets.get(key)!.push(rec);
    }

    // (none) first, then schema order, then unexpected values
    const result: { key: string; label: string; records: EoState[] }[] = [];
    result.push({ key: NONE_GROUP_KEY, label: NONE_GROUP_LABEL, records: buckets.get(NONE_GROUP_KEY) || [] });
    for (const v of order) {
      result.push({ key: v, label: v, records: buckets.get(v) || [] });
    }
    for (const v of extra) {
      result.push({ key: v, label: v, records: buckets.get(v) || [] });
    }
    return result;
  }, [records, kanbanField, kanbanColumn, useFieldsSub, optimistic]);

  const uniqueValueCount = groups.length - 1; // exclude (none)
  const showTooManyValuesWarning = uniqueValueCount > 15;

  const canEdit = sliceReadOnly
    ? false
    : permissions
      ? permissions.can_edit_any_record || permissions.can_edit_own_records
      : true;

  // DnD sensors — require a small drag distance so clicks still work as "open record"
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  async function handleDragEnd(event: DragEndEvent) {
    setActiveDragRec(null);
    const { active, over } = event;
    if (!over || !kanbanField) return;
    const target = String(active.id);
    const toKey = String(over.id);
    const newValue = toKey === NONE_GROUP_KEY ? null : toKey;

    // Optimistic update
    setOptimistic((o) => ({ ...o, [target]: newValue }));

    const operand = useFieldsSub
      ? { fields: { [kanbanField]: newValue } }
      : { [kanbanField]: newValue };

    try {
      await dispatch({
        op: 'DEF',
        target,
        operand,
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch {
      // Roll back optimistic update on error
      setOptimistic((o) => {
        const next = { ...o };
        delete next[target];
        return next;
      });
    }
  }

  // --- Empty / error states ---

  if (!kanbanField) {
    return (
      <div style={s.emptyWrap}>
        <div style={s.emptyIcon}>{'\u25A5'}</div>
        <div style={s.emptyTitle}>Pick a single-select field to group cards</div>
        <div style={s.emptySub}>
          Kanban columns come from the distinct values of a single-select field.
        </div>
        <FieldPicker
          options={selectCandidates}
          onPick={(key) => sliceStore.setKanbanField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  if (!kanbanColumn) {
    return (
      <div style={s.emptyWrap}>
        <div style={s.warningBanner}>
          Field <code>{kanbanField}</code> was not found on the current records.
        </div>
        <FieldPicker
          options={selectCandidates}
          onPick={(key) => sliceStore.setKanbanField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  if (kanbanColumn.type === 'multiSelect') {
    return (
      <div style={s.emptyWrap}>
        <div style={s.warningBanner}>
          Multi-select fields are not supported for kanban. Pick a single-select field.
        </div>
        <FieldPicker
          options={selectCandidates}
          onPick={(key) => sliceStore.setKanbanField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  if (kanbanColumn.type !== 'select') {
    return (
      <div style={s.emptyWrap}>
        <div style={s.warningBanner}>
          Field <code>{kanbanColumn.label}</code> is a <code>{kanbanColumn.type}</code>, not a single-select.
          Kanban requires a single-select field.
        </div>
        <FieldPicker
          options={selectCandidates}
          onPick={(key) => sliceStore.setKanbanField(scope, key)}
          theme={theme}
        />
      </div>
    );
  }

  // --- Board render ---

  return (
    <div style={s.wrap}>
      {showTooManyValuesWarning && (
        <div style={s.infoBanner}>
          {uniqueValueCount} columns — kanban may be unwieldy above 15 values.
        </div>
      )}
      <DndContext
        sensors={sensors}
        onDragStart={(e) => setActiveDragRec(String(e.active.id))}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDragRec(null)}
      >
        <div style={s.board}>
          {groups.map((group) => (
            <KanbanColumn
              key={group.key}
              groupKey={group.key}
              label={group.label}
              records={group.records}
              activeRecord={activeRecord ?? null}
              onSelectRecord={onSelectRecord}
              canEdit={canEdit}
              isBeingDragged={activeDragRec}
              theme={theme}
              s={s}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface KanbanColumnProps {
  groupKey: string;
  label: string;
  records: EoState[];
  activeRecord: string | null;
  onSelectRecord: (target: string) => void;
  canEdit: boolean;
  isBeingDragged: string | null;
  theme: Theme;
  s: Record<string, React.CSSProperties>;
}

function KanbanColumn({
  groupKey,
  label,
  records,
  activeRecord,
  onSelectRecord,
  canEdit,
  isBeingDragged,
  theme,
  s,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: groupKey });
  const isNone = groupKey === NONE_GROUP_KEY;
  const dot = isNone ? theme.textMuted : hashColor(groupKey);

  return (
    <div style={s.column}>
      <div style={s.columnHeader}>
        <span style={{ ...s.columnDot, background: dot }} />
        <span style={s.columnTitle}>{label}</span>
        <span style={s.columnCount}>{records.length}</span>
      </div>
      <div
        ref={setNodeRef}
        style={{
          ...s.columnBody,
          background: isOver ? theme.bgHover : 'transparent',
          outline: isOver ? `1px dashed ${theme.accent}` : 'none',
        }}
      >
        {records.map((rec) => (
          <KanbanCard
            key={rec.target}
            rec={rec}
            isActive={rec.target === activeRecord}
            isDragging={rec.target === isBeingDragged}
            canEdit={canEdit}
            onSelect={() => onSelectRecord(rec.target)}
            theme={theme}
            s={s}
          />
        ))}
        {records.length === 0 && (
          <div style={s.columnEmpty}>{canEdit ? 'Drop here' : 'Empty'}</div>
        )}
      </div>
    </div>
  );
}

interface KanbanCardProps {
  rec: EoState;
  isActive: boolean;
  isDragging: boolean;
  canEdit: boolean;
  onSelect: () => void;
  theme: Theme;
  s: Record<string, React.CSSProperties>;
}

function KanbanCard({ rec, isActive, isDragging, canEdit, onSelect, theme, s }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: rec.target,
    disabled: !canEdit,
  });
  const name = resolveRecordName(rec) ?? (rec.target.split('.').pop() || rec.target);

  const style: React.CSSProperties = {
    ...s.card,
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.4 : 1,
    borderColor: isActive ? theme.accent : theme.border,
    cursor: canEdit ? 'grab' : 'pointer',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={(e) => {
        // Ignore click during drag; dnd-kit uses pointer events so a real click
        // won't have any transform applied.
        if (transform) return;
        e.stopPropagation();
        onSelect();
      }}
    >
      <div style={s.cardTitle}>{name}</div>
      <div style={s.cardTarget}>{rec.target.split('.').pop()}</div>
    </div>
  );
}

interface FieldPickerProps {
  options: ColumnDef[];
  onPick: (key: string) => void;
  theme: Theme;
}

function FieldPicker({ options, onPick, theme }: FieldPickerProps) {
  if (options.length === 0) {
    return (
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 12 }}>
        No single-select fields found on this table.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, justifyContent: 'center' }}>
      {options.map((col) => (
        <button
          key={col.key}
          onClick={() => onPick(col.key)}
          style={{
            padding: '6px 12px',
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            background: theme.bgCard,
            color: theme.text,
            border: `1px solid ${theme.border}`,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          {col.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    wrap: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: t.bg,
    },
    board: {
      flex: 1,
      display: 'flex',
      gap: 12,
      padding: 16,
      overflowX: 'auto',
      overflowY: 'hidden',
      alignItems: 'flex-start',
    },
    column: {
      flex: '0 0 280px',
      maxHeight: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      overflow: 'hidden',
    },
    columnHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 12px',
      borderBottom: `1px solid ${t.border}`,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      color: t.text,
    },
    columnDot: {
      width: 10,
      height: 10,
      borderRadius: '50%',
      flexShrink: 0,
    },
    columnTitle: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    columnCount: {
      fontSize: 10,
      padding: '1px 7px',
      background: t.bgMuted,
      color: t.textMuted,
      borderRadius: 999,
    },
    columnBody: {
      flex: 1,
      overflowY: 'auto',
      padding: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      minHeight: 120,
      transition: 'background .12s, outline .12s',
    },
    columnEmpty: {
      fontSize: 10,
      color: t.textMuted,
      textAlign: 'center',
      padding: '12px 0',
      fontFamily: "'JetBrains Mono', monospace",
      opacity: 0.5,
      fontStyle: 'italic',
    },
    card: {
      padding: '10px 12px',
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      fontFamily: "'JetBrains Mono', monospace",
      transition: 'border-color .12s, box-shadow .12s',
      userSelect: 'none',
      touchAction: 'none',
    },
    cardTitle: {
      fontSize: 12,
      fontWeight: 500,
      color: t.text,
      marginBottom: 3,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    cardTarget: {
      fontSize: 9,
      color: t.textMuted,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    },
    emptyWrap: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      gap: 6,
      color: t.textMuted,
      background: t.bg,
    },
    emptyIcon: {
      fontSize: 36,
      opacity: 0.3,
      marginBottom: 4,
    },
    emptyTitle: {
      fontSize: 13,
      fontWeight: 500,
      color: t.text,
    },
    emptySub: {
      fontSize: 11,
      opacity: 0.75,
      textAlign: 'center',
      maxWidth: 340,
    },
    warningBanner: {
      padding: '10px 14px',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.warningBg,
      color: t.warningText,
      border: `1px solid ${t.warningBorder}`,
      borderRadius: 4,
      maxWidth: 440,
      textAlign: 'center',
    },
    infoBanner: {
      padding: '6px 14px',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bgMuted,
      color: t.textMuted,
      borderBottom: `1px solid ${t.border}`,
      textAlign: 'center',
    },
  };
}
