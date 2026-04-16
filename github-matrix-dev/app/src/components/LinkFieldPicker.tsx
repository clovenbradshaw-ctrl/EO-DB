/**
 * LinkFieldPicker — modal search picker for Link-type fields.
 *
 * Loads all records from one or more linked tables, filters by the user's
 * search text, and lets the user add/remove linked record IDs. Dispatches
 * a DEF event (via onChange) to update the field value on the source record.
 *
 * Supports multiple source tables: when more than one table is configured
 * for a link field, records from every table are combined into a single
 * pickable list, each record labelled with its source table.
 */

import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import type { EoState } from '../db/types';
import { isDeleted } from '../db/tombstone';
import { formatName } from './scope-picker-utils';
import { X, MagnifyingGlass } from '@phosphor-icons/react';

export interface LinkFieldPickerProps {
  /** Key of the field being edited on the source record. */
  fieldKey: string;
  /**
   * EO scope path(s) of the table(s) to link to, e.g. ["import.events"] or
   * ["import.events", "import.cases"]. Accepts a single string for backward
   * compatibility with legacy single-table link fields.
   */
  linkedTables: string[] | string;
  /** Currently linked record IDs, e.g. ["EVT-089", "EVT-010"]. */
  currentIds: string[];
  /** Called when the picker should close. */
  onClose: () => void;
  /** Called with the updated ID array after add/remove. */
  onChange: (updatedIds: string[]) => void;
}

interface PickerRecord {
  state: EoState;
  id: string;
  name: string;
  table: string;
  tableName: string;
}

function getRecordDisplayName(state: EoState): string {
  const v = state.value;
  if (!v || typeof v !== 'object') return state.target.split('.').pop() ?? state.target;
  return (
    v.name ?? v.title ?? v.case_name ?? v.matter_name ?? v.full_name ?? v.display_name ??
    state.target.split('.').pop() ?? state.target
  );
}

export function LinkFieldPicker({ fieldKey, linkedTables, currentIds, onClose, onChange }: LinkFieldPickerProps) {
  void fieldKey; // used by caller for dispatch context
  const { theme: t } = useTheme();
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);

  const tables = useMemo(() => {
    const arr = Array.isArray(linkedTables) ? linkedTables : [linkedTables];
    return arr.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }, [linkedTables]);

  const [records, setRecords] = useState<PickerRecord[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [tableFilter, setTableFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all(
      tables.map(async (tableScope) => {
        const states = await getStateByPrefix(tableScope + '.');
        const depth = tableScope.split('.').length + 1;
        const tableName = formatName(tableScope.split('.').pop() ?? tableScope);
        const out: PickerRecord[] = [];
        for (const s of states) {
          const parts = s.target.split('.');
          if (parts.length !== depth) continue;
          if (parts[parts.length - 1].startsWith('_')) continue;
          if (isDeleted(s)) continue;
          out.push({
            state: s,
            id: parts[parts.length - 1],
            name: getRecordDisplayName(s),
            table: tableScope,
            tableName,
          });
        }
        return out;
      }),
    ).then(results => {
      if (cancelled) return;
      const flat = results.flat();
      flat.sort((a, b) => a.name.localeCompare(b.name));
      setRecords(flat);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [tables, getStateByPrefix]);

  const filtered = useMemo(() => {
    let out = records;
    if (tableFilter) out = out.filter(r => r.table === tableFilter);
    const q = search.trim().toLowerCase();
    if (q) out = out.filter(r => r.id.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    return out;
  }, [records, search, tableFilter]);

  const currentSet = useMemo(() => new Set(currentIds), [currentIds]);

  function toggle(id: string) {
    if (currentSet.has(id)) {
      onChange(currentIds.filter(x => x !== id));
    } else {
      onChange([...currentIds, id]);
    }
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const placeholder = tables.length === 1
    ? `Search ${formatName(tables[0].split('.').pop() ?? tables[0])}…`
    : `Search ${tables.length} tables…`;

  const multiTable = tables.length > 1;

  return createPortal(
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 9998,
        }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 9999,
          background: t.bgCard,
          border: `1px solid ${t.border}`,
          borderRadius: 10,
          boxShadow: '0 12px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
          width: 480,
          maxWidth: '90vw',
          maxHeight: '80vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header / search */}
        <div style={{
          padding: '10px 12px',
          background: t.bgHover,
          borderBottom: `1px solid ${t.borderLight}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <MagnifyingGlass size={14} color={t.textMuted} weight="bold" />
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={placeholder}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: 13,
              color: t.text,
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 2,
              color: t.textMuted,
              lineHeight: 0,
              borderRadius: 4,
              display: 'inline-flex',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = t.bgMuted; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
          >
            <X size={13} weight="bold" />
          </button>
        </div>

        {/* Table filter tabs — only shown when linking to multiple tables */}
        {multiTable && (
          <div style={{
            padding: '6px 10px',
            borderBottom: `1px solid ${t.borderLight}`,
            display: 'flex',
            gap: 4,
            flexWrap: 'wrap',
          }}>
            <TableTab active={tableFilter === null} label="All" onClick={() => setTableFilter(null)} t={t} />
            {tables.map(tbl => (
              <TableTab
                key={tbl}
                active={tableFilter === tbl}
                label={formatName(tbl.split('.').pop() ?? tbl)}
                onClick={() => setTableFilter(tbl)}
                t={t}
              />
            ))}
          </div>
        )}

        {/* Currently linked chips */}
        {currentIds.length > 0 && (
          <div style={{
            padding: '8px 12px',
            borderBottom: `1px solid ${t.borderLight}`,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
          }}>
            {currentIds.map(id => {
              const rec = records.find(r => r.id === id);
              const name = rec ? rec.name : id;
              return (
                <span
                  key={id}
                  onClick={() => toggle(id)}
                  title={`Remove ${name}`}
                  onMouseEnter={e => {
                    const el = e.currentTarget as HTMLElement;
                    el.style.background = t.purple;
                    el.style.color = '#fff';
                    el.style.borderColor = t.purple;
                    const x = el.querySelector('[data-chip-x]') as HTMLElement | null;
                    if (x) x.style.opacity = '1';
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget as HTMLElement;
                    el.style.background = t.purpleBg;
                    el.style.color = t.purple;
                    el.style.borderColor = t.purpleBorder;
                    const x = el.querySelector('[data-chip-x]') as HTMLElement | null;
                    if (x) x.style.opacity = '0.55';
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '2px 9px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 500,
                    lineHeight: 1.4,
                    background: t.purpleBg,
                    border: `1px solid ${t.purpleBorder}`,
                    color: t.purple,
                    cursor: 'pointer',
                    maxWidth: 260,
                    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
                  }}
                >
                  <span style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>{name !== id ? name : id}</span>
                  <span data-chip-x style={{ opacity: 0.55, display: 'inline-flex', lineHeight: 0, flexShrink: 0, transition: 'opacity 0.12s' }}>
                    <X size={10} weight="bold" />
                  </span>
                </span>
              );
            })}
          </div>
        )}

        {/* Record list */}
        <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0', minHeight: 120 }}>
          {loading ? (
            <div style={{ padding: '12px 14px', fontSize: 12, color: t.textMuted }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '12px 14px', fontSize: 12, color: t.textMuted }}>No records found</div>
          ) : (
            filtered.map(rec => {
              const isLinked = currentSet.has(rec.id);
              return (
                <div
                  key={rec.state.target}
                  onClick={() => toggle(rec.id)}
                  style={{
                    padding: '8px 12px',
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: isLinked ? `${t.purple}14` : 'transparent',
                    boxShadow: isLinked ? `inset 3px 0 0 ${t.purple}` : 'none',
                    color: t.text,
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (!isLinked) (e.currentTarget as HTMLElement).style.background = t.bgHover ?? t.bgMuted; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isLinked ? `${t.purple}14` : 'transparent'; }}
                >
                  <span style={{
                    width: 14,
                    height: 14,
                    borderRadius: 3,
                    border: `1.5px solid ${isLinked ? t.purple : t.border}`,
                    background: isLinked ? t.purple : 'transparent',
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: 9,
                    lineHeight: 1,
                    fontWeight: 700,
                  }}>{isLinked ? '✓' : ''}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isLinked ? 500 : 400 }}>{rec.name}</span>
                  {multiTable && (
                    <span style={{
                      fontSize: 10,
                      color: t.textMuted,
                      background: t.bgMuted,
                      padding: '1px 6px',
                      borderRadius: 999,
                      flexShrink: 0,
                    }}>{rec.tableName}</span>
                  )}
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{rec.id}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

function TableTab({ active, label, onClick, t }: {
  active: boolean;
  label: string;
  onClick: () => void;
  t: ReturnType<typeof useTheme>['theme'];
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? t.purple : 'transparent',
        color: active ? '#fff' : t.textMuted,
        border: `1px solid ${active ? t.purple : t.borderLight}`,
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: 11,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
}
