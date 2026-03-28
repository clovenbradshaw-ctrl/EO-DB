import { useState } from 'react';
import type { ColumnDef, FilterRule, FilterOperator } from './filter-types';
import { operatorsForType, OPERATOR_LABELS } from './filter-types';

interface FilterBarProps {
  columns: ColumnDef[];
  filters: FilterRule[];
  onFiltersChange: (filters: FilterRule[]) => void;
  conjunction: 'AND' | 'OR';
  onConjunctionChange: (c: 'AND' | 'OR') => void;
  onSaveSegment: (name: string) => void;
}

export function FilterBar({
  columns, filters, onFiltersChange,
  conjunction, onConjunctionChange, onSaveSegment,
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);

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
        style={{
          ...styles.filterBtn,
          ...(activeCount > 0 ? styles.filterBtnActive : {}),
        }}
        onClick={() => setOpen(!open)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="1,1 15,1 9,8 9,14 7,15 7,8" />
        </svg>
        Filter
        {activeCount > 0 && (
          <span style={styles.badge}>{activeCount}</span>
        )}
      </button>

      {open && (
        <>
          <div style={styles.backdrop} onClick={() => setOpen(false)} />
          <div style={styles.panel}>
            <div style={styles.panelHeader}>
              <span style={styles.panelTitle}>Filters</span>
              <button style={styles.closeBtn} onClick={() => setOpen(false)}>&times;</button>
            </div>

            {filters.length === 0 && (
              <div style={styles.emptyMsg}>No active filters. Add one to narrow your view.</div>
            )}

            {filters.map((filter, idx) => {
              const col = columns.find(c => c.key === filter.field);
              const ops = col ? operatorsForType(col.type) : operatorsForType('text');
              const needsValue = !['is_empty', 'is_not_empty'].includes(filter.operator);
              const isSelect = col?.type === 'select';

              return (
                <div key={filter.id} style={styles.filterRow}>
                  {/* Conjunction label */}
                  {idx === 0 ? (
                    <span style={styles.conjLabel}>Where</span>
                  ) : (
                    <button
                      style={styles.conjToggle}
                      onClick={() => onConjunctionChange(conjunction === 'AND' ? 'OR' : 'AND')}
                    >
                      {conjunction}
                    </button>
                  )}

                  {/* Field picker */}
                  <select
                    value={filter.field}
                    onChange={(e) => updateFilter(filter.id, { field: e.target.value })}
                    style={styles.select}
                  >
                    {columns.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>

                  {/* Operator picker */}
                  <select
                    value={filter.operator}
                    onChange={(e) => updateFilter(filter.id, { operator: e.target.value as FilterOperator })}
                    style={styles.select}
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
                        style={styles.select}
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
                        style={styles.input}
                      />
                    )
                  )}

                  {/* Remove */}
                  <button
                    style={styles.removeBtn}
                    onClick={() => removeFilter(filter.id)}
                  >
                    &times;
                  </button>
                </div>
              );
            })}

            <div style={styles.panelFooter}>
              <button style={styles.addBtn} onClick={addFilter}>
                + Add filter
              </button>

              {filters.length > 0 && (
                <>
                  <button
                    style={styles.clearBtn}
                    onClick={() => onFiltersChange([])}
                  >
                    Clear all
                  </button>

                  <div style={{ flex: 1 }} />

                  {showSave ? (
                    <div style={styles.saveRow}>
                      <input
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                        placeholder="Segment name"
                        style={styles.saveInput}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
                      />
                      <button style={styles.saveBtn} onClick={handleSave}>Save</button>
                      <button style={styles.cancelBtn} onClick={() => setShowSave(false)}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      style={styles.segBtn}
                      onClick={() => setShowSave(true)}
                    >
                      Save as segment
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  filterBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: '#fff',
    color: '#2c2a26',
    cursor: 'pointer',
  },
  filterBtnActive: {
    borderColor: '#1a6dd4',
    color: '#1a6dd4',
    background: '#eef5fd',
  },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    background: '#1a6dd4',
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
    position: 'absolute' as const,
    right: 0,
    top: '100%',
    marginTop: 4,
    width: 560,
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
    zIndex: 100,
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #f0eeeb',
  },
  panelTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#1a1816',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 18,
    color: '#aba69e',
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
  },
  emptyMsg: {
    padding: '16px',
    fontSize: 12,
    color: '#aba69e',
  },
  filterRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    borderBottom: '1px solid #f0eeeb',
  },
  conjLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: '#aba69e',
    width: 44,
    flexShrink: 0,
    textAlign: 'right' as const,
  },
  conjToggle: {
    fontSize: 10,
    fontWeight: 600,
    color: '#1a6dd4',
    background: '#eef5fd',
    border: '1px solid #c5d9f0',
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
    border: '1px solid #e5e2dd',
    borderRadius: 4,
    background: '#faf9f7',
    color: '#2c2a26',
    outline: 'none',
    minWidth: 80,
  },
  input: {
    padding: '6px 8px',
    fontSize: 12,
    border: '1px solid #e5e2dd',
    borderRadius: 4,
    background: '#faf9f7',
    color: '#2c2a26',
    outline: 'none',
    flex: 1,
    minWidth: 60,
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    color: '#aba69e',
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
    color: '#1a6dd4',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  },
  clearBtn: {
    fontSize: 12,
    fontWeight: 500,
    color: '#aba69e',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  },
  segBtn: {
    fontSize: 11,
    fontWeight: 500,
    padding: '5px 10px',
    border: '1px solid #d9487a',
    borderRadius: 5,
    background: '#fff',
    color: '#d9487a',
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
    border: '1px solid #e5e2dd',
    borderRadius: 4,
    background: '#faf9f7',
    color: '#2c2a26',
    outline: 'none',
    width: 130,
  },
  saveBtn: {
    fontSize: 11,
    fontWeight: 600,
    padding: '5px 10px',
    border: 'none',
    borderRadius: 4,
    background: '#d9487a',
    color: '#fff',
    cursor: 'pointer',
  },
  cancelBtn: {
    fontSize: 11,
    padding: '5px 8px',
    border: '1px solid #e5e2dd',
    borderRadius: 4,
    background: 'transparent',
    color: '#7a756d',
    cursor: 'pointer',
  },
};
