/**
 * RelationshipFieldPanel — renders a relationship-type field as a mini-table.
 *
 * A relationship field stores data as CON edges with edge_type = fieldKey
 * and an optional attrs object carrying typed attribute values. This panel:
 *
 *   - Shows existing edges filtered by edge_type as a table with attribute columns
 *   - Lets users add new edges (search for a record + fill in attribute values)
 *   - Lets users remove edges
 *   - Lets users edit edge attribute values (dispatches remove + re-add)
 *
 * Edge attr definitions come from the field schema constraints:
 *   scope._schema.fieldKey.constraint.edgeAttr_{key} → { label, type, options? }
 */

import { useState, useEffect, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { EoState, EdgeAttrDef } from '../db/types';
import { isDeleted } from '../db/tombstone';
import { formatName } from './scope-picker-utils';
import { MagnifyingGlass, Plus, X, PencilSimple, Check } from '@phosphor-icons/react';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RelationshipEdge {
  dest: string;
  edge_type?: string;
  attrs?: Record<string, unknown>;
}

export interface RelationshipFieldPanelProps {
  fieldKey: string;
  figure: EoState;
  linkedTable: string;
  edgeAttrDefs: EdgeAttrDef[];
  edges: RelationshipEdge[];
  onNavigate: (target: string) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRecordDisplayName(state: EoState): string {
  const v = state.value;
  if (!v || typeof v !== 'object') return state.target.split('.').pop() ?? state.target;
  return (
    v.name ?? v.title ?? v.case_name ?? v.matter_name ?? v.full_name ?? v.display_name ??
    state.target.split('.').pop() ?? state.target
  );
}

// ─── Attr editor for a single edge ──────────────────────────────────────────

interface AttrEditorProps {
  attrDefs: EdgeAttrDef[];
  initial: Record<string, unknown>;
  onSave: (attrs: Record<string, unknown>) => void;
  onCancel: () => void;
  t: Theme;
}

function AttrEditor({ attrDefs, initial, onSave, onCancel, t }: AttrEditorProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const def of attrDefs) out[def.key] = String(initial[def.key] ?? '');
    return out;
  });

  function set(key: string, val: string) {
    setValues(prev => ({ ...prev, [key]: val }));
  }

  function handleSave() {
    const out: Record<string, unknown> = {};
    for (const def of attrDefs) {
      const raw = values[def.key];
      if (raw === '') continue;
      out[def.key] = def.type === 'number' ? Number(raw) : raw;
    }
    onSave(out);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
      {attrDefs.map(def => (
        <div key={def.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 11, color: t.textMuted, minWidth: 80, flexShrink: 0, fontFamily: "'JetBrains Mono', monospace" }}>
            {def.label}
          </label>
          {def.type === 'select' && def.options ? (
            <select
              value={values[def.key]}
              onChange={e => set(def.key, e.target.value)}
              style={{ flex: 1, fontSize: 12, background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 4, padding: '2px 6px', color: t.text }}
            >
              <option value="">—</option>
              {def.options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
              value={values[def.key]}
              onChange={e => set(def.key, e.target.value)}
              style={{ flex: 1, fontSize: 12, background: t.bgMuted, border: `1px solid ${t.border}`, borderRadius: 4, padding: '3px 8px', color: t.text, outline: 'none' }}
            />
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <button
          onClick={handleSave}
          style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, background: t.purple, color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <Check size={11} /> Save
        </button>
        <button
          onClick={onCancel}
          style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, background: t.bgMuted, color: t.textSecondary, border: `1px solid ${t.borderLight}`, cursor: 'pointer' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Record search for adding a new edge ─────────────────────────────────────

interface RecordSearchProps {
  linkedTable: string;
  excludeDests: Set<string>;
  onSelect: (fullTarget: string, shortId: string) => void;
  onClose: () => void;
  t: Theme;
}

function RecordSearch({ linkedTable, excludeDests, onSelect, onClose, t }: RecordSearchProps) {
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);
  const [records, setRecords] = useState<EoState[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const depth = linkedTable.split('.').length + 1;
    getStateByPrefix(linkedTable + '.').then(states => {
      setRecords(states.filter(s => {
        const parts = s.target.split('.');
        if (parts.length !== depth) return false;
        if (parts[parts.length - 1].startsWith('_')) return false;
        if (isDeleted(s)) return false;
        return true;
      }));
    });
  }, [linkedTable, getStateByPrefix]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return records.filter(r => {
      if (excludeDests.has(r.target)) return false;
      if (!q) return true;
      const id = r.target.split('.').pop() ?? '';
      return id.toLowerCase().includes(q) || getRecordDisplayName(r).toLowerCase().includes(q);
    });
  }, [records, search, excludeDests]);

  return (
    <div style={{
      position: 'absolute',
      top: '100%',
      left: 0,
      zIndex: 300,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 8px 30px ${t.shadow}`,
      minWidth: 260,
      maxWidth: 360,
      maxHeight: 280,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ padding: '6px 10px', borderBottom: `1px solid ${t.borderLight}`, display: 'flex', alignItems: 'center', gap: 6 }}>
        <MagnifyingGlass size={12} color={t.textMuted} />
        <input
          autoFocus
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${formatName(linkedTable.split('.').pop() ?? linkedTable)}…`}
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 12, color: t.text, fontFamily: 'inherit' }}
        />
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: t.textMuted }}>
          <X size={12} />
        </button>
      </div>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '8px 12px', fontSize: 12, color: t.textMuted }}>No records found</div>
        ) : filtered.map(rec => {
          const shortId = rec.target.split('.').pop() ?? rec.target;
          const name = getRecordDisplayName(rec);
          return (
            <div
              key={rec.target}
              onClick={() => onSelect(rec.target, shortId)}
              style={{ padding: '6px 12px', fontSize: 12, cursor: 'pointer', display: 'flex', gap: 8, color: t.text }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = t.bgHover ?? t.bgMuted; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary, flexShrink: 0 }}>{shortId}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function RelationshipFieldPanel({
  fieldKey,
  figure,
  linkedTable,
  edgeAttrDefs,
  edges,
  onNavigate,
}: RelationshipFieldPanelProps) {
  const { theme: t } = useTheme();
  const dispatch = useEoStore(s => s.dispatch);
  const getStateByPrefix = useEoStore(s => s.getStateByPrefix);

  // Resolved display names for connected records
  const [resolvedNames, setResolvedNames] = useState<Map<string, string>>(new Map());
  const [showSearch, setShowSearch] = useState(false);
  const [pendingAdd, setPendingAdd] = useState<{ dest: string; shortId: string } | null>(null);
  const [editingDest, setEditingDest] = useState<string | null>(null);

  // Resolve display names for all connected records
  useEffect(() => {
    if (edges.length === 0) return;
    const depth = linkedTable.split('.').length + 1;
    getStateByPrefix(linkedTable + '.').then(states => {
      const map = new Map<string, string>();
      for (const s of states) {
        const parts = s.target.split('.');
        if (parts.length !== depth) continue;
        const shortId = parts[parts.length - 1];
        map.set(shortId, getRecordDisplayName(s));
        map.set(s.target, getRecordDisplayName(s));
      }
      setResolvedNames(map);
    });
  }, [edges, linkedTable, getStateByPrefix]);

  const existingDests = useMemo(() => new Set(edges.map(e => e.dest)), [edges]);

  async function addEdge(dest: string, attrs: Record<string, unknown>) {
    await dispatch({
      op: 'CON',
      target: figure.target,
      operand: {
        added: [{ dest, attrs }],
        edge_type: fieldKey,
      },
      agent: 'user',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    });
    setShowSearch(false);
    setPendingAdd(null);
  }

  async function removeEdge(dest: string) {
    await dispatch({
      op: 'CON',
      target: figure.target,
      operand: {
        removed: [dest],
        edge_type: fieldKey,
      },
      agent: 'user',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    });
  }

  async function updateEdgeAttrs(dest: string, newAttrs: Record<string, unknown>) {
    // Remove then re-add with updated attrs
    await dispatch({
      op: 'CON',
      target: figure.target,
      operand: { removed: [dest], edge_type: fieldKey },
      agent: 'user',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    });
    await dispatch({
      op: 'CON',
      target: figure.target,
      operand: { added: [{ dest, attrs: newAttrs }], edge_type: fieldKey },
      agent: 'user',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    });
    setEditingDest(null);
  }

  const hasAttrs = edgeAttrDefs.length > 0;

  return (
    <div style={{ position: 'relative' }}>
      {edges.length === 0 && !showSearch ? (
        <span style={{ fontSize: 12, color: t.textMuted, fontStyle: 'italic' }}>none</span>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          {edges.length > 0 && (
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '2px 8px 4px 0', fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}>
                  ID
                </th>
                {hasAttrs && edgeAttrDefs.map(def => (
                  <th key={def.key} style={{ textAlign: 'left', padding: '2px 8px 4px', fontSize: 10, fontWeight: 600, color: t.textMuted, fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.05em' }}>
                    {def.label}
                  </th>
                ))}
                <th style={{ width: 40 }} />
              </tr>
            </thead>
          )}
          <tbody>
            {edges.map(edge => {
              const shortId = edge.dest.split('.').pop() ?? edge.dest;
              const name = resolvedNames.get(shortId) ?? resolvedNames.get(edge.dest);
              const isEditing = editingDest === edge.dest;
              return (
                <tr key={edge.dest} style={{ borderTop: `1px solid ${t.borderLight}` }}>
                  <td style={{ padding: '5px 8px 5px 0', verticalAlign: 'top' }}>
                    <span
                      onClick={() => onNavigate(edge.dest)}
                      style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.purple, cursor: 'pointer' }}
                    >
                      {shortId}
                    </span>
                    {name && (
                      <span style={{ fontSize: 11, color: t.textSecondary, marginLeft: 4 }}>· {name}</span>
                    )}
                  </td>
                  {hasAttrs && !isEditing && edgeAttrDefs.map(def => (
                    <td key={def.key} style={{ padding: '5px 8px', verticalAlign: 'top', color: t.text }}>
                      {edge.attrs?.[def.key] !== undefined ? String(edge.attrs[def.key]) : (
                        <span style={{ color: t.textMuted }}>—</span>
                      )}
                    </td>
                  ))}
                  {isEditing && hasAttrs && (
                    <td colSpan={edgeAttrDefs.length} style={{ padding: '4px 8px', verticalAlign: 'top' }}>
                      <AttrEditor
                        attrDefs={edgeAttrDefs}
                        initial={edge.attrs ?? {}}
                        onSave={attrs => updateEdgeAttrs(edge.dest, attrs)}
                        onCancel={() => setEditingDest(null)}
                        t={t}
                      />
                    </td>
                  )}
                  <td style={{ padding: '4px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      {hasAttrs && !isEditing && (
                        <button
                          onClick={() => setEditingDest(edge.dest)}
                          title="Edit attributes"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', color: t.textMuted, borderRadius: 3 }}
                        >
                          <PencilSimple size={12} />
                        </button>
                      )}
                      <button
                        onClick={() => removeEdge(edge.dest)}
                        title="Remove connection"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', color: t.textMuted, borderRadius: 3 }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* Add new connection */}
      <div style={{ marginTop: edges.length > 0 ? 6 : 0, position: 'relative', display: 'inline-block' }}>
        {!showSearch && !pendingAdd && (
          <button
            onClick={() => setShowSearch(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 4,
              background: 'transparent',
              border: `1px solid ${t.borderLight}`,
              color: t.textMuted,
              cursor: 'pointer',
            }}
          >
            <Plus size={10} /> Add connection
          </button>
        )}

        {showSearch && !pendingAdd && (
          <RecordSearch
            linkedTable={linkedTable}
            excludeDests={existingDests}
            onSelect={(dest, shortId) => {
              if (edgeAttrDefs.length === 0) {
                addEdge(dest, {});
              } else {
                setPendingAdd({ dest, shortId });
                setShowSearch(false);
              }
            }}
            onClose={() => setShowSearch(false)}
            t={t}
          />
        )}

        {pendingAdd && (
          <div style={{ padding: '8px 0' }}>
            <div style={{ fontSize: 12, color: t.textSecondary, marginBottom: 4 }}>
              Adding connection to <span style={{ fontFamily: "'JetBrains Mono', monospace", color: t.purple }}>{pendingAdd.shortId}</span>
            </div>
            <AttrEditor
              attrDefs={edgeAttrDefs}
              initial={{}}
              onSave={attrs => addEdge(pendingAdd.dest, attrs)}
              onCancel={() => setPendingAdd(null)}
              t={t}
            />
          </div>
        )}
      </div>
    </div>
  );
}
