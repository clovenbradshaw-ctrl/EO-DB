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
import { isDeleted } from '../db/tombstone';
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
      // Only direct children (record level), skip schema, sub-targets, and
      // tombstoned records — a link target that was deleted upstream should
      // not be pickable as a new edge.
      const depth = linkedTable.split('.').length + 1;
      const records = states.filter(s => {
        const parts = s.target.split('.');
        if (parts.length !== depth) return false;
        if (parts[parts.length - 1].startsWith('_')) return false;
        if (isDeleted(s)) return false;
        return true;
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
      top: 'calc(100% + 4px)',
      left: 0,
      zIndex: 200,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 10,
      boxShadow: '0 12px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
      minWidth: 320,
      maxWidth: 420,
      maxHeight: 380,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Search bar */}
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
          placeholder={`Search ${formatName(linkedTable.split('.').pop() ?? linkedTable)}…`}
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
            const rec = records.find(r => r.target.split('.').pop() === id);
            const name = rec ? getRecordDisplayName(rec) : id;
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
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
        {loading ? (
          <div style={{ padding: '12px 14px', fontSize: 12, color: t.textMuted }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '12px 14px', fontSize: 12, color: t.textMuted }}>No records found</div>
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
                {/* Checkbox indicator */}
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
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: isLinked ? 500 : 400 }}>{name}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: t.textMuted, flexShrink: 0 }}>{id}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
