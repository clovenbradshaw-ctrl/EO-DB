import { useEffect, useState, useMemo, useRef } from 'react';
import { useEoStore } from '../store/eo-store';
import { useSliceStore } from '../store/slice-store';
import { SLICE_TYPE_META, type SavedSlice, type TableSliceConfig, type SliceType } from './slice-types';
import { deriveColumns, type ColumnDef } from './filter-types';
import { formatName } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';

interface SlicesBrowserProps {
  /** Current scope (object path). If null, the panel shows a "select an object" state. */
  scope: string | null;
  /** Number of records under the current scope (shown in the pinned chip). */
  recordCount: number;
  /** Matrix user ID — required for attributing created slices. */
  userId: string;
  onBack: () => void;
  onSelectSlice: (slice: SavedSlice) => void;
}

export function SlicesBrowser({ scope, recordCount, userId, onBack, onSelectSlice }: SlicesBrowserProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const registerSavedSlices = useSliceStore((s) => s.registerSavedSlices);
  const savedSlices = useSliceStore((s) => s.savedSlices);
  const sig = useSliceStore((s) => (scope ? s.getSig(scope) : null));
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const hasLoadedOnce = useRef(false);
  const prevSlicesKeyRef = useRef<string>('');

  // --- Create-slice popover state ---
  const [showCreate, setShowCreate] = useState(false);
  const [newSliceName, setNewSliceName] = useState('');
  const [newSliceType, setNewSliceType] = useState<SliceType>('grid');
  const [newSliceVisibility, setNewSliceVisibility] = useState<'private' | 'shared'>('shared');
  const [newKanbanField, setNewKanbanField] = useState('');
  const [creating, setCreating] = useState(false);

  // Derive available columns and unique value counts from scope records for kanban field selection
  const [scopeColumns, setScopeColumns] = useState<ColumnDef[]>([]);
  const [fieldUniqueCounts, setFieldUniqueCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!ready || !scope || !showCreate) return;
    const scopeDepth = scope.split('.').length + 1;
    getStateByPrefix(scope + '.').then((states) => {
      const records = states.filter(
        (st) =>
          st.target.split('.').length === scopeDepth &&
          !st.target.includes('._') &&
          st.value != null,
      );
      setScopeColumns(deriveColumns(records));

      // Count unique values per field for kanban warning
      const counts: Record<string, Set<string>> = {};
      for (const rec of records) {
        if (!rec.value || typeof rec.value !== 'object') continue;
        const source = rec.value.fields && typeof rec.value.fields === 'object' && !Array.isArray(rec.value.fields)
          ? rec.value.fields as Record<string, any>
          : rec.value;
        for (const [key, val] of Object.entries(source)) {
          if (key.startsWith('_')) continue;
          if (!counts[key]) counts[key] = new Set();
          if (val != null) counts[key].add(String(val));
        }
      }
      const numericCounts: Record<string, number> = {};
      for (const [key, set] of Object.entries(counts)) {
        numericCounts[key] = set.size;
      }
      setFieldUniqueCounts(numericCounts);
    });
  }, [ready, scope, showCreate, getStateByPrefix]);

  // Load saved slices for the current scope only
  useEffect(() => {
    if (!ready || !scope) {
      setLoading(false);
      return;
    }
    if (!hasLoadedOnce.current) setLoading(true);

    getStateByPrefix(`${scope}._slices.`).then((states) => {
      const key = states.map(s => s.target + ':' + s.last_seq).join('|');
      if (key === prevSlicesKeyRef.current) {
        hasLoadedOnce.current = true;
        setLoading(false);
        return;
      }
      prevSlicesKeyRef.current = key;

      const sliceDepth = scope.split('.').length + 2; // scope._slices.sliceId
      const slices: SavedSlice[] = states
        .filter(
          (st) =>
            st.target.split('.').length === sliceDepth &&
            st.value?.name &&
            !st.value?._deleted,
        )
        .map((st) => ({
          id: st.target.split('.').pop()!,
          name: st.value.name,
          scope,
          sliceType: st.value.sliceType || 'grid',
          config: st.value.config || {
            columnOrder: [],
            columnWidths: {},
            hiddenColumns: [],
            sorts: [],
            filters: [],
            filterConjunction: 'AND',
            showLastUpdated: true,
          },
          visibility: st.value.visibility || 'shared',
          createdBy: st.value.createdBy || st.last_agent,
          createdAt: st.value.createdAt || st.last_ts,
          updatedAt: st.value.updatedAt || st.last_ts,
          roomId: st.value.roomId,
        }));
      if (slices.length > 0) {
        registerSavedSlices(slices);
      }
      hasLoadedOnce.current = true;
      setLoading(false);
    });
  }, [ready, lastSeq, getStateByPrefix, scope, registerSavedSlices]);

  // Reset loaded flag when scope changes
  useEffect(() => {
    hasLoadedOnce.current = false;
  }, [scope]);

  // Slices belonging to the current scope, filtered by search query
  const { personalSlices, collaborativeSlices } = useMemo(() => {
    if (!scope) return { personalSlices: [], collaborativeSlices: [] };
    const q = query.trim().toLowerCase();
    const all = Object.values(savedSlices).filter(
      (v) => v.scope === scope && (!q || v.name.toLowerCase().includes(q)),
    );
    all.sort((a, b) => a.name.localeCompare(b.name));
    return {
      personalSlices: all.filter((v) => v.visibility === 'private'),
      collaborativeSlices: all.filter((v) => v.visibility === 'shared'),
    };
  }, [savedSlices, scope, query]);

  // Synthetic default grid slice (always shown under personal)
  function makeDefaultSlice(s: string): SavedSlice {
    return {
      id: '',
      name: 'Grid view',
      scope: s,
      sliceType: 'grid',
      config: {
        columnOrder: [],
        columnWidths: {},
        hiddenColumns: [],
        sorts: [],
        filters: [],
        filterConjunction: 'AND',
        showLastUpdated: true,
      },
      visibility: 'shared',
      createdBy: '',
      createdAt: '',
      updatedAt: '',
    };
  }

  const defaultMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return !q || 'grid view'.includes(q);
  }, [query]);

  function resetCreateForm() {
    setNewSliceName('');
    setNewSliceType('grid');
    setNewSliceVisibility('shared');
    setNewKanbanField('');
  }

  async function handleCreateSlice() {
    if (!scope || !newSliceName.trim() || creating) return;
    setCreating(true);
    const sliceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const now = new Date().toISOString();
    const config: TableSliceConfig = {
      columnOrder: [],
      columnWidths: {},
      hiddenColumns: [],
      sorts: [],
      filters: [],
      filterConjunction: 'AND',
      showLastUpdated: true,
      ...(newSliceType === 'kanban' && newKanbanField ? { kanbanField: newKanbanField } : {}),
    };
    const name = newSliceName.trim();
    try {
      await dispatch({
        op: 'INS',
        target: `${scope}._slices.${sliceId}`,
        operand: {
          name,
          sliceType: newSliceType,
          config,
          visibility: newSliceVisibility,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        },
        agent: `user:${userId}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });
      const savedSlice: SavedSlice = {
        id: sliceId,
        name,
        scope,
        sliceType: newSliceType,
        config,
        visibility: newSliceVisibility,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      registerSavedSlices([savedSlice]);
      setShowCreate(false);
      resetCreateForm();
      onSelectSlice(savedSlice);
    } catch (err) {
      console.error('[SlicesBrowser] Failed to create slice:', err);
      // Still register the slice optimistically — the fold may have succeeded
      // even if a downstream step (e.g. Matrix send) threw.
      const savedSlice: SavedSlice = {
        id: sliceId,
        name,
        scope,
        sliceType: newSliceType,
        config,
        visibility: newSliceVisibility,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      registerSavedSlices([savedSlice]);
      setShowCreate(false);
      resetCreateForm();
      onSelectSlice(savedSlice);
    } finally {
      setCreating(false);
    }
  }

  const scopeLabel = scope ? formatName(scope.split('.').pop() || scope) : '';
  const activeSliceId = sig?.activeSliceId ?? null;
  const defaultIsActive = scope != null && activeSliceId == null;

  function renderSliceRow(slice: SavedSlice, isActive: boolean) {
    const vtMeta = SLICE_TYPE_META[(slice.sliceType || 'grid') as SliceType];
    const isPrivate = slice.visibility === 'private';
    return (
      <div
        key={slice.id || '__default__'}
        style={{ ...s.sliceItem, ...(isActive ? s.sliceItemActive : {}) }}
        onClick={() => onSelectSlice(slice)}
      >
        <span style={{ ...s.sliceIcon, ...(isActive ? { color: theme.accent } : {}) }}>
          {isPrivate ? '\uD83D\uDD12' : vtMeta.icon}
        </span>
        <span style={s.sliceName}>{slice.name}</span>
        <span style={s.sliceBadge}>
          {isPrivate ? 'private' : vtMeta.label.toLowerCase()}
        </span>
      </div>
    );
  }

  return (
    <div style={s.container}>
      {/* Header: back arrow + title */}
      <div style={s.header}>
        <button onClick={onBack} style={s.backBtn} title="Back to navigation">
          {'\u2190'}
        </button>
        <span style={s.title}>Slices</span>
      </div>

      {/* Search */}
      <div style={s.searchWrap}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a slice…"
          style={s.searchInput}
        />
      </div>

      {/* Scrollable list */}
      <div style={s.scroll}>
        {!scope ? (
          <div style={s.empty}>
            <span style={{ opacity: 0.4, fontSize: 18 }}>{'\u229E'}</span>
            <span>No object selected</span>
            <span style={{ fontSize: 10, color: theme.textMuted, textAlign: 'center' }}>
              Go back and select an object to browse its slices.
            </span>
          </div>
        ) : loading ? (
          <div style={s.empty}>Loading{'\u2026'}</div>
        ) : (
          <>
            {/* Personal slices */}
            <div style={s.sectionLabel}>Personal slices</div>
            {defaultMatches && renderSliceRow(makeDefaultSlice(scope), defaultIsActive)}
            {personalSlices.map((v) => renderSliceRow(v, v.id === activeSliceId))}
            {!defaultMatches && personalSlices.length === 0 && (
              <div style={s.sectionEmpty}>No matches</div>
            )}

            {/* Collaborative slices */}
            {(collaborativeSlices.length > 0 || query.trim() === '') && (
              <>
                <div style={{ ...s.sectionLabel, marginTop: 12 }}>Collaborative slices</div>
                {collaborativeSlices.length > 0 ? (
                  collaborativeSlices.map((v) => renderSliceRow(v, v.id === activeSliceId))
                ) : (
                  <div style={s.sectionEmpty}>None yet</div>
                )}
              </>
            )}

            {/* Create a slice — inline like Airtable */}
            {!showCreate ? (
              <button
                style={s.createBtn}
                onClick={() => setShowCreate(true)}
                title="Create a new slice for this object"
              >
                + Create a slice
              </button>
            ) : (
              <div style={s.inlineCreateForm}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: theme.textHeading }}>
                  New slice
                </div>
                <input
                  autoFocus
                  value={newSliceName}
                  onChange={(e) => setNewSliceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateSlice();
                    if (e.key === 'Escape') { setShowCreate(false); resetCreateForm(); }
                  }}
                  placeholder="Slice name…"
                  style={s.nameInput}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' as const }}>
                  {(Object.keys(SLICE_TYPE_META) as SliceType[]).map((vt) => {
                    const meta = SLICE_TYPE_META[vt];
                    const active = newSliceType === vt;
                    return (
                      <button
                        key={vt}
                        onClick={() => setNewSliceType(vt)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '4px 8px', fontSize: 11, fontWeight: active ? 600 : 400,
                          border: `1px solid ${active ? theme.accent : theme.border}`,
                          borderRadius: 4, cursor: 'pointer',
                          background: active ? theme.accentBg : 'transparent',
                          color: active ? theme.accent : theme.textSecondary,
                        }}
                      >
                        <span style={{ fontSize: 12 }}>{meta.icon}</span>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
                {/* Kanban field selection */}
                {newSliceType === 'kanban' && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 500, color: theme.textSecondary, marginBottom: 4 }}>
                      Group by field
                    </div>
                    <select
                      value={newKanbanField}
                      onChange={(e) => setNewKanbanField(e.target.value)}
                      style={{
                        width: '100%',
                        height: 32,
                        fontSize: 12,
                        padding: '0 8px',
                        border: `1px solid ${theme.border}`,
                        borderRadius: 4,
                        background: theme.bgCard,
                        color: theme.text,
                        outline: 'none',
                        boxSizing: 'border-box' as const,
                        cursor: 'pointer',
                      }}
                    >
                      <option value="">Select a field{'\u2026'}</option>
                      {scopeColumns.map((col) => (
                        <option key={col.key} value={col.key}>
                          {col.label}{fieldUniqueCounts[col.key] != null ? ` (${fieldUniqueCounts[col.key]} values)` : ''}
                        </option>
                      ))}
                    </select>
                    {newKanbanField && fieldUniqueCounts[newKanbanField] > 15 && (
                      <div style={{
                        marginTop: 4,
                        padding: '4px 8px',
                        fontSize: 11,
                        color: '#b45309',
                        background: '#fef3c7',
                        border: '1px solid #fde68a',
                        borderRadius: 4,
                      }}>
                        This field has {fieldUniqueCounts[newKanbanField]} unique values. Kanban boards work best with 15 or fewer columns.
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    style={newSliceVisibility === 'private' ? s.visBtnActive : s.visBtn}
                    onClick={() => setNewSliceVisibility('private')}
                  >
                    {'\uD83D\uDD12'} Private
                  </button>
                  <button
                    style={newSliceVisibility === 'shared' ? s.visBtnActive : s.visBtn}
                    onClick={() => setNewSliceVisibility('shared')}
                  >
                    {'\uD83D\uDD13'} Shared
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button
                    style={s.inlineCancelBtn}
                    onClick={() => { setShowCreate(false); resetCreateForm(); }}
                  >
                    Cancel
                  </button>
                  <button
                    style={(!newSliceName.trim() || creating || (newSliceType === 'kanban' && !newKanbanField)) ? s.modalCreateBtnDisabled : s.modalCreateBtn}
                    onClick={handleCreateSlice}
                    disabled={!newSliceName.trim() || creating || (newSliceType === 'kanban' && !newKanbanField)}
                  >
                    {creating ? 'Creating\u2026' : 'Create slice'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Pinned scope chip at bottom */}
      {scope && (
        <div style={s.scopeChipWrap}>
          <div style={s.scopeChip}>
            <span style={s.scopeChipName}>{scopeLabel}</span>
            <span style={s.scopeChipSep}>{'\u00B7'}</span>
            <span style={s.scopeChipMeta}>{recordCount} records</span>
          </div>
        </div>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      overflow: 'hidden',
      minHeight: 0,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 14px 10px',
      flexShrink: 0,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      color: t.text,
      cursor: 'pointer',
      fontSize: 16,
      lineHeight: 1,
      padding: '4px 6px',
      borderRadius: 4,
      display: 'flex',
      alignItems: 'center',
    },
    title: {
      fontSize: 14,
      fontWeight: 600,
      color: t.textHeading,
      flex: 1,
    },
    searchWrap: {
      padding: '0 12px 10px',
      flexShrink: 0,
    },
    searchInput: {
      width: '100%',
      padding: '6px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgMuted,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box',
    } as React.CSSProperties,
    scroll: {
      flex: 1,
      overflowY: 'auto',
      padding: '4px 0 8px',
      minHeight: 0,
    },
    empty: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '32px 16px',
      fontSize: 12,
      color: t.textSecondary,
    },
    sectionLabel: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      letterSpacing: '0.5px',
      textTransform: 'uppercase' as const,
      padding: '8px 16px 4px',
    },
    sectionEmpty: {
      padding: '4px 16px 4px',
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic' as const,
    },
    sliceItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      margin: '0 6px',
      cursor: 'pointer',
      borderRadius: 6,
      fontSize: 12,
      color: t.text,
      transition: 'background 0.1s',
    } as React.CSSProperties,
    sliceItemActive: {
      background: t.accentBg,
      color: t.accent,
      fontWeight: 500,
    } as React.CSSProperties,
    sliceIcon: {
      fontSize: 12,
      opacity: 0.7,
      flexShrink: 0,
      width: 14,
      textAlign: 'center' as const,
      color: 'inherit',
    },
    sliceName: {
      flex: 1,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      color: 'inherit',
    },
    sliceBadge: {
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
      fontFamily: "'JetBrains Mono', monospace",
    },
    createBtn: {
      display: 'block',
      margin: '12px 12px 4px',
      padding: '6px 10px',
      background: 'none',
      border: 'none',
      color: t.accent,
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 500,
      textAlign: 'left' as const,
      borderRadius: 4,
    },
    scopeChipWrap: {
      padding: '8px 12px 12px',
      borderTop: `1px solid ${t.border}`,
      flexShrink: 0,
    },
    scopeChip: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      fontSize: 11,
    },
    scopeChipName: {
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      fontWeight: 500,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    scopeChipSep: {
      color: t.textMuted,
      flexShrink: 0,
    },
    scopeChipMeta: {
      color: t.textMuted,
      flexShrink: 0,
    },
    inlineCreateForm: {
      margin: '8px 12px 4px',
      padding: 12,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
    },
    inlineCancelBtn: {
      flex: 1,
      padding: '8px 0',
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
    },
    nameInput: {
      width: '100%',
      height: 32,
      fontSize: 12,
      padding: '0 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },
    visBtn: {
      flex: 1,
      padding: '6px 0',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
    },
    visBtnActive: {
      flex: 1,
      padding: '6px 0',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      background: t.accentBg,
      color: t.accent,
      cursor: 'pointer',
    },
    modalCreateBtn: {
      width: '100%',
      marginTop: 12,
      padding: '8px 0',
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 6,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
    },
    modalCreateBtnDisabled: {
      width: '100%',
      marginTop: 12,
      padding: '8px 0',
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgMuted,
      color: t.textMuted,
      cursor: 'not-allowed',
      opacity: 0.6,
    },
  };
}
