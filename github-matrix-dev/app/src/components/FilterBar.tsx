import { useState, useRef, useEffect, useCallback } from 'react';
import type { ColumnDef, FilterRule, FilterOperator } from './filter-types';
import { operatorsForType, OPERATOR_LABELS } from './filter-types';
import { useTheme, type Theme } from '../theme';
import { QueryFilterInput } from './QueryFilterInput';

type FilterMode = 'visual' | 'query';

interface FilterBarProps {
  columns: ColumnDef[];
  filters: FilterRule[];
  onFiltersChange: (filters: FilterRule[]) => void;
  conjunction: 'AND' | 'OR';
  onConjunctionChange: (c: 'AND' | 'OR') => void;
  onSaveSegment: (name: string) => void;
  /** Current scope (e.g. "app.tblClients") for EO/SQL query generation */
  scope?: string;
}

export function FilterBar({
  columns, filters, onFiltersChange,
  conjunction, onConjunctionChange, onSaveSegment,
  scope = '',
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [mode, setMode] = useState<FilterMode>('visual');
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  const updatePanelPos = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPanelPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePanelPos();
    window.addEventListener('resize', updatePanelPos);
    return () => window.removeEventListener('resize', updatePanelPos);
  }, [open, updatePanelPos]);

  function addFilter() {
    const field = columns[0]?.key || '';
    const ops = columns[0] ? operatorsForType(columns[0].type) : ['equals' as FilterOperator];
    onFiltersChange([
      ...filters,
      { id: crypto.randomUUID(), field, operator: ops[0], value: '' },
    ]);
  }

  function updateFilter(id: string, patch: Partial<FilterRule>) {
    onFiltersChange(filters.map((f) => {
      if (f.id !== id) return f;
      const updated = { ...f, ...patch };
      // Reset operator when field changes (if current op isn't valid for new type)
      if (patch.field && patch.field !== f.field) {
        const col = columns.find(c => c.key === patch.field);
        const validOps = col ? operatorsForType(col.type) : operatorsForType('text');
        if (!validOps.includes(updated.operator)) {
          updated.operator = validOps[0];
        }
        updated.value = '';
      }
      return updated;
    }));
  }

  function removeFilter(id: string) {
    onFiltersChange(filters.filter((f) => f.id !== id));
  }

  function handleSave() {
    if (!saveName.trim()) return;
    onSaveSegment(saveName.trim());
    setSaveName('');
    setShowSave(false);
  }

  const activeCount = filters.length;

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        style={{
          ...s.filterBtn,
          ...(activeCount > 0 ? s.filterBtnActive : {}),
        }}
        onClick={() => setOpen(!open)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="1,1 15,1 9,8 9,14 7,15 7,8" />
        </svg>
        Filter
        {activeCount > 0 && (
          <span style={s.badge}>{activeCount}</span>
        )}
      </button>

      {open && (
        <>
          <div style={s.backdrop} onClick={() => setOpen(false)} />
          <div style={{ ...s.panel, top: panelPos.top, right: panelPos.right }}>
            <div style={s.panelHeader}>
              <span style={s.panelTitle}>Filters</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  style={{ ...s.modeBtn, ...(mode === 'visual' ? s.modeBtnActive : {}) }}
                  onClick={() => setMode('visual')}
                >
                  Visual
                </button>
                <button
                  style={{ ...s.modeBtn, ...(mode === 'query' ? s.modeBtnActive : {}) }}
                  onClick={() => setMode('query')}
                >
                  EO / SQL
                </button>
                <button style={s.closeBtn} onClick={() => setOpen(false)} aria-label="Close filter panel">&times;</button>
              </div>
            </div>

            {mode === 'query' && (
              <QueryFilterInput
                columns={columns}
                scope={scope}
                currentFilters={filters}
                currentConjunction={conjunction}
                onApply={(rules, conj) => {
                  onFiltersChange(rules);
                  onConjunctionChange(conj);
                }}
              />
            )}

            {mode === 'visual' && filters.length === 0 && (
              <div style={s.emptyMsg}>No active filters. Add one to narrow your view.</div>
            )}

            {mode === 'visual' && filters.map((filter, idx) => {
              const col = columns.find(c => c.key === filter.field);
              const ops = col ? operatorsForType(col.type) : operatorsForType('text');
              const needsValue = !['is_empty', 'is_not_empty'].includes(filter.operator);
              const isSelect = col?.type === 'select';

              return (
                <div key={filter.id} style={s.filterRow}>
                  {/* Conjunction label */}
                  {idx === 0 ? (
                    <span style={s.conjLabel}>Where</span>
                  ) : (
                    <button
                      style={s.conjToggle}
                      onClick={() => onConjunctionChange(conjunction === 'AND' ? 'OR' : 'AND')}
                    >
                      {conjunction}
                    </button>
                  )}

                  {/* Field picker */}
                  <select
                    value={filter.field}
                    onChange={(e) => updateFilter(filter.id, { field: e.target.value })}
                    style={s.select}
                    aria-label="Filter field"
                  >
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>

                  {/* Operator picker */}
                  <select
                    value={filter.operator}
                    onChange={(e) => updateFilter(filter.id, { operator: e.target.value as FilterOperator })}
                    style={s.select}
                    aria-label="Filter operator"
                  >
                    {ops.map((op) => (
                      <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
                    ))}
                  </select>

                  {/* Value input */}
                  {needsValue && (
                    isSelect && col?.selectOptions ? (
                      <select
                        value={filter.value}
                        onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                        style={s.select}
                      >
                        <option value="">--</option>
                        {col.selectOptions.map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={col?.type === 'number' ? 'number' : 'text'}
                        value={filter.value}
                        onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                        placeholder="value"
                        aria-label="Filter value"
                        style={s.input}
                      />
                    )
                  )}

                  {/* Remove */}
                  <button
                    style={s.removeBtn}
                    onClick={() => removeFilter(filter.id)}
                    aria-label="Remove filter"
                  >
                    &times;
                  </button>
                </div>
              );
            })}

            {mode === 'visual' && <div style={s.panelFooter}>
              <button style={s.addBtn} onClick={addFilter}>
                + Add filter
              </button>

              {filters.length > 0 && (
                <>
                  <button
                    style={s.clearBtn}
                    onClick={() => onFiltersChange([])}
                  >
                    Clear all
                  </button>

                  <div style={{ flex: 1 }} />

                  {showSave ? (
                    <div style={s.saveRow}>
                      <input
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                        placeholder="Segment name"
                        aria-label="Segment name"
                        style={s.saveInput}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                      />
                      <button style={s.saveBtn} onClick={handleSave}>Save</button>
                      <button style={s.cancelBtn} onClick={() => setShowSave(false)}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      style={s.segBtn}
                      onClick={() => setShowSave(true)}
                    >
                      Save as segment
                    </button>
                  )}
                </>
              )}
            </div>}
          </div>
        </>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    filterBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 12px',
      fontSize: 12,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
    },
    filterBtnActive: {
      borderColor: t.accent,
      color: t.accent,
      background: t.accentBg,
    },
    badge: {
      fontSize: 10,
      fontWeight: 600,
      background: t.accent,
      color: '#fff',
      borderRadius: 8,
      padding: '0 5px',
      lineHeight: '16px',
    },
    backdrop: {
      position: 'fixed' as const,
      inset: 0,
      zIndex: 99,
    },
    panel: {
      position: 'fixed' as const,
      width: 560,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 4px 16px ${t.shadow}`,
      zIndex: 100,
    },
    panelHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 16px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    panelTitle: {
      fontSize: 12,
      fontWeight: 600,
      color: t.textHeading,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 18,
      color: t.textMuted,
      cursor: 'pointer',
      padding: 0,
      lineHeight: 1,
      marginLeft: 6,
    },
    modeBtn: {
      padding: '3px 8px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textMuted,
      cursor: 'pointer',
    },
    modeBtnActive: {
      background: t.accent,
      color: '#fff',
      borderColor: t.accent,
    },
    emptyMsg: {
      padding: '16px',
      fontSize: 12,
      color: t.textMuted,
    },
    filterRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '8px 16px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    conjLabel: {
      fontSize: 11,
      fontWeight: 500,
      color: t.textMuted,
      width: 44,
      flexShrink: 0,
      textAlign: 'right' as const,
    },
    conjToggle: {
      fontSize: 10,
      fontWeight: 600,
      color: t.accent,
      background: t.accentBg,
      border: `1px solid ${t.accentBorder}`,
      borderRadius: 4,
      padding: '2px 8px',
      cursor: 'pointer',
      width: 44,
      flexShrink: 0,
      textAlign: 'center' as const,
    },
    select: {
      padding: '6px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      minWidth: 80,
    },
    input: {
      padding: '6px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      flex: 1,
      minWidth: 60,
    },
    removeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
      flexShrink: 0,
    },
    panelFooter: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 16px',
      flexWrap: 'wrap' as const,
    },
    addBtn: {
      fontSize: 12,
      fontWeight: 500,
      color: t.accent,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
    },
    clearBtn: {
      fontSize: 12,
      fontWeight: 500,
      color: t.textMuted,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: 0,
    },
    segBtn: {
      fontSize: 11,
      fontWeight: 500,
      padding: '5px 10px',
      border: `1px solid ${t.danger}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.danger,
      cursor: 'pointer',
    },
    saveRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    saveInput: {
      padding: '5px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      width: 130,
    },
    saveBtn: {
      fontSize: 11,
      fontWeight: 600,
      padding: '5px 10px',
      border: 'none',
      borderRadius: 4,
      background: t.danger,
      color: '#fff',
      cursor: 'pointer',
    },
    cancelBtn: {
      fontSize: 11,
      padding: '5px 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
    },
  };
}
