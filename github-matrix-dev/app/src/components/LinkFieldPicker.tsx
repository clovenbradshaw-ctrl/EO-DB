/**
 * LinkFieldPicker — inline search picker for Link-type fields.
 *
 * Loads all records from the linked table, filters by the user's search text,
 * and lets the user add/remove linked record IDs. Dispatches a DEF event to
 * update the field value on the source record.
 */

import { useState, useEffect, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import type { EoState } from '../db/types';
import { formatName } from './scope-picker-utils';
import { X, MagnifyingGlass } from '@phosphor-icons/react';

export interface LinkFieldPickerProps {
  /** Key of the field being edited on the source record. */
  fieldKey: string;
  /** EO scope path of the table to link to, e.g. "import.events". */
  linkedTable: string;
  /** Currently linked record IDs, e.g. ["EVT-089", "EVT-010"]. */
  currentIds: string[];
  /** Called when the picker should close. */
  onClose: () => void;
  /** Called with the updated ID array after add/remove. */
  onChange: (updatedIds: string[]) => void;
}

function getRecordDisplayName(state: EoState): string {
  const v = state.value;
  if (!v || typeof v !== 'object') return state.target.split('.').pop() ?? state.target;
  return (
    v.name ?? v.title ?? v.case_name ?? v.matter_name ?? v.full_name ?? v.display_name ??
    state.target.split('.').pop() ?? state.target
  );
}

export function LinkFieldPicker({ fieldKey, linkedTable, currentIds, onClose, onChange }: LinkFieldPickerProps) {
  void fieldKey; // used by caller for dispatch context
  const { theme: t } = useTheme();
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);

  const [records, setRecords] = useState<EoState[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStateByPrefix(linkedTable + '.').then(states => {
      if (cancelled) return;
      // Only direct children (record level), skip schema and sub-targets
      const depth = linkedTable.split('.').length + 1;
      const records = states.filter(s => {
        const parts = s.target.split('.');
        return parts.length === depth && !parts[parts.length - 1].startsWith('_');
      });
      setRecords(records);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [linkedTable, getStateByPrefix]);

  const filtered = useMemo(() => {
    if (!search.trim()) return records;
    const q = search.toLowerCase();
    return records.filter(r => {
      const id = r.target.split('.').pop() ?? '';
      const name = getRecordDisplayName(r).toLowerCase();
      return id.toLowerCase().includes(q) || name.includes(q);
    });
  }, [records, search]);

  const currentSet = useMemo(() => new Set(currentIds), [currentIds]);

  function toggle(id: string) {
    if (currentSet.has(id)) {
      onChange(currentIds.filter(x => x !== id));
    } else {
      onChange([...currentIds, id]);
    }
  }

  return (
    <div style={{
      position: 'absolute',
      top: '100%',
      left: 0,
      zIndex: 200,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 8px 30px ${t.shadow}`,
      minWidth: 260,
      maxWidth: 360,
      maxHeight: 360,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Search bar */}
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${t.borderLight}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <MagnifyingGlass size={13} color={t.textMuted} />
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${formatName(linkedTable.split('.').pop() ?? linkedTable)}…`}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontSize: 12,
            color: t.text,
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: t.textMuted, lineHeight: 1 }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Currently linked chips */}
      {currentIds.length > 0 && (
        <div style={{ padding: '6px 10px', borderBottom: `1px solid ${t.borderLight}`, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {currentIds.map(id => {
            const rec = records.find(r => r.target.split('.').pop() === id);
            const name = rec ? getRecordDisplayName(rec) : id;
            return (
              <span
                key={id}
                onClick={() => toggle(id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontSize: 11,
                  background: `${t.purple}20`,
                  border: `1px solid ${t.purple}50`,
                  color: t.purple,
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {id}
                {name !== id && <span style={{ color: t.text, fontWeight: 400, fontFamily: 'inherit' }}>{' · '}{name}</span>}
                <X size={10} />
              </span>
            );
          })}
        </div>
      )}

      {/* Record list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {loading ? (
          <div style={{ padding: '10px 12px', fontSize: 12, color: t.textMuted }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: 12, color: t.textMuted }}>No records found</div>
        ) : (
          filtered.map(rec => {
            const id = rec.target.split('.').pop() ?? rec.target;
            const name = getRecordDisplayName(rec);
            const isLinked = currentSet.has(id);
            return (
              <div
                key={rec.target}
                onClick={() => toggle(id)}
                style={{
                  padding: '7px 12px',
                  fontSize: 12,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: isLinked ? `${t.purple}10` : 'transparent',
                  color: t.text,
                }}
                onMouseEnter={e => { if (!isLinked) (e.currentTarget as HTMLElement).style.background = t.bgHover ?? t.bgMuted; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isLinked ? `${t.purple}10` : 'transparent'; }}
              >
                {/* Checkbox indicator */}
                <span style={{
                  width: 13,
                  height: 13,
                  borderRadius: 3,
                  border: `1.5px solid ${isLinked ? t.purple : t.border}`,
                  background: isLinked ? t.purple : 'transparent',
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>{id}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
