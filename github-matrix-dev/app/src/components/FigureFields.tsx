import { useState, useEffect, useMemo, useRef } from 'react';
import type { EoState, EdgeAttrDef, EoEvent } from '../db/types';
import { reconstructAt } from './RecordTimeline';
import { useEoStore } from '../store/eo-store';
import { buildFieldNameMapFromSchema, buildFieldNameMap } from './filter-types';
import { formatName } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useIdResolver, isEntityId, isEntityIdArray, type IdResolver } from '../hooks/useIdResolver';
import { syncEditToAirtable } from '../ingestion/airtable-writeback';
import { getAirtableTypeIcon, getAirtableTypeColor } from './field-type-icons';
import { groupSchemaStates, extractEdgeAttrDefs } from '../db/schema-rules';
import { LinkFieldPicker } from './LinkFieldPicker';
import { RelationshipFieldPanel } from './RelationshipFieldPanel';

interface FieldTypeSchema {
  type?: string;
  linkedTable?: string;
  edgeAttrDefs?: EdgeAttrDef[];
}

interface FigureFieldsProps {
  figure: EoState;
  onNavigate: (target: string) => void;
  profileFields?: string[];
  /** When set, display fields as of this epoch-ms timestamp (time travel mode). */
  recordTs?: number | null;
  /** Full event log for this record, used to reconstruct historical values. */
  allEvents?: EoEvent[];
}

export function FigureFields({ figure, onNavigate, profileFields, recordTs, allEvents }: FigureFieldsProps) {
  const dispatch = useEoStore((s) => s.dispatch);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const value = figure.value;

  // ── Container-query 2-column layout ──────────────────────────────────────
  // Use a ResizeObserver on our own grid container to decide whether to show
  // fields as 1 or 2 columns. This works whether the drawer is 360px or 900px,
  // regardless of window width.
  const gridRef = useRef<HTMLDivElement>(null);
  const [twoColumn, setTwoColumn] = useState(false);
  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        setTwoColumn(w >= 560);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reconstruct field values at the selected timestamp when in time-travel mode
  const historicValue = useMemo<Record<string, unknown>>(() => {
    if (!recordTs || !allEvents || allEvents.length === 0) return value as Record<string, unknown>;
    return reconstructAt(value as Record<string, unknown>, allEvents, recordTs);
  }, [recordTs, allEvents, value]);

  // Per-field history: walk DEF events oldest→newest, tracking every value each
  // field has held. Used to render the compact "values over time" trail under
  // each cell while time travel is active.
  const fieldHistories = useMemo<Map<string, Array<{ ts: number; value: unknown }>>>(() => {
    const out = new Map<string, Array<{ ts: number; value: unknown }>>();
    if (!allEvents || allEvents.length === 0) return out;

    const defs = allEvents
      .filter((e) => e.op === 'DEF')
      .slice()
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    const push = (key: string, ts: number, v: unknown) => {
      if (key.startsWith('_')) return;
      const prior = out.get(key);
      // Dedupe consecutive identical values so the trail stays compact.
      if (prior && prior.length > 0 && JSON.stringify(prior[prior.length - 1].value) === JSON.stringify(v)) return;
      if (!prior) out.set(key, [{ ts, value: v }]);
      else prior.push({ ts, value: v });
    };

    for (const evt of defs) {
      const ts = new Date(evt.ts).getTime();
      const op = evt.operand as Record<string, unknown> | undefined;
      if (!op || typeof op !== 'object') continue;
      for (const [k, v] of Object.entries(op)) {
        if (k === 'fields' && v && typeof v === 'object' && !Array.isArray(v)) {
          // Flattened fields sub-object — treat each inner key as its own field
          for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) push(fk, ts, fv);
        } else {
          push(k, ts, v);
        }
      }
    }
    return out;
  }, [allEvents]);

  const scopeRoot = figure.target.split('.')[0];
  const resolver = useIdResolver(scopeRoot);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; fieldKey: string } | null>(null);
  const [editing, setEditing] = useState<{ fieldKey: string; value: string } | null>(null);
  const [displayNameEdit, setDisplayNameEdit] = useState<{ fieldKey: string; currentLabel: string } | null>(null);

  // Fetch schema-level field name map and type info for the parent table scope
  const [schemaFieldNames, setSchemaFieldNames] = useState<Map<string, string>>(new Map());
  const [fieldTypeMap, setFieldTypeMap] = useState<Map<string, FieldTypeSchema>>(new Map());
  const tableScope = useMemo(() => {
    const parts = figure.target.split('.');
    // Table scope is everything except the last segment (the record ID)
    return parts.length > 1 ? parts.slice(0, -1).join('.') : figure.target;
  }, [figure.target]);

  // State for open link pickers: fieldKey → true/false
  const [openLinkPicker, setOpenLinkPicker] = useState<string | null>(null);

  useEffect(() => {
    getStateByPrefix(tableScope + '._schema.').then((allSchemaStates) => {
      const schemaPrefix = tableScope + '._schema.';
      const schemaDepth = tableScope.split('.').length + 2;
      const fieldStates = allSchemaStates.filter(
        (st) => st.target.split('.').length === schemaDepth && !st.value?._alias,
      );
      if (fieldStates.length > 0) {
        setSchemaFieldNames(buildFieldNameMapFromSchema(fieldStates));
      } else {
        // Fallback: read field metadata from table entity's value.fields array
        getState(tableScope).then((scopeState) => {
          const fields = scopeState?.value?.fields;
          if (Array.isArray(fields)) {
            setSchemaFieldNames(buildFieldNameMap(fields));
          }
        });
      }

      // Build field type map from the full schema tree (includes .type and .constraint.*)
      const grouped = groupSchemaStates(allSchemaStates, schemaPrefix);
      const typeMap = new Map<string, FieldTypeSchema>();
      for (const [key, fs] of grouped) {
        const typeDef = fs.typeDef?.value;
        if (!typeDef?.type) continue;
        typeMap.set(key, {
          type: typeDef.type,
          linkedTable: typeDef.linkedTable,
          edgeAttrDefs: typeDef.type === 'relationship' ? extractEdgeAttrDefs(fs) : [],
        });
      }
      setFieldTypeMap(typeMap);
    });
  }, [tableScope, getStateByPrefix, getState]);

  if (!value || typeof value !== 'object') {
    return <div style={s.mono}>{JSON.stringify(value)}</div>;
  }

  // In time-travel mode, show entries from historicValue (reconstructed at recordTs)
  const displayValue = recordTs ? historicValue : (value as Record<string, unknown>);
  let entries = Object.entries(displayValue).filter(([k]) => !k.startsWith('_') && k !== 'linked' && k !== 'edge_type');

  // Flatten the "fields" sub-object: promote each sub-key to a top-level entry
  const fieldsObj = entries.find(([k]) => k === 'fields');
  if (fieldsObj && typeof fieldsObj[1] === 'object' && fieldsObj[1] !== null && !Array.isArray(fieldsObj[1])) {
    const subEntries = Object.entries(fieldsObj[1] as Record<string, unknown>);
    entries = [
      ...entries.filter(([k]) => k !== 'fields'),
      ...subEntries,
    ];
  }

  // Display name overrides stored in _fieldLabels on the figure
  const fieldLabels: Record<string, string> = (value as any)._fieldLabels || {};

  // Filter and order by profileFields if provided
  if (profileFields && profileFields.length > 0) {
    const allowed = new Set(profileFields);
    const filtered = entries.filter(([k]) => allowed.has(k));
    // Maintain profileFields order
    filtered.sort((a, b) => profileFields.indexOf(a[0]) - profileFields.indexOf(b[0]));
    entries = filtered;
  }

  // Active editing signals from other agents: fieldKey → { agent, draft, since }
  // Filter out stale entries client-side (tab-close survivors) so badges don't
  // linger until the next fold write cleans them up.
  const SIG_TTL_MS = 5 * 60 * 1000;
  const rawSigs: Record<string, { agent: string; draft: string; since: string }> =
    (value as any)._sigs ?? {};
  const now = Date.now();
  const sigs = Object.fromEntries(
    Object.entries(rawSigs).filter(([, e]) => now - Date.parse(e.since) < SIG_TTL_MS),
  );

  function shortAgent(agentId: string): string {
    // "@alice:matrix.org" → "alice", "user" → "user"
    const match = agentId.match(/^@?([^:@]+)/);
    return match ? match[1] : agentId;
  }

  function dispatchSig(fieldKey: string, opts: { draft: string } | { editing: false }) {
    dispatch({
      op: 'SIG' as any,
      target: figure.target,
      operand: { fieldKey, ...opts },
      agent: 'user',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    }).catch(() => {});
  }

  function handleContextMenu(e: React.MouseEvent, fieldKey: string) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, fieldKey });
  }

  function getContextMenuItems(fieldKey: string): ContextMenuItem[] {
    const currentVal = value[fieldKey];
    const currentLabel = fieldLabels[fieldKey] || '';
    return [
      {
        label: 'Edit value',
        onClick: () => {
          const strVal = currentVal != null && typeof currentVal === 'object'
            ? JSON.stringify(currentVal, null, 2)
            : String(currentVal ?? '');
          setEditing({ fieldKey, value: strVal });
          dispatchSig(fieldKey, { draft: strVal });
          setContextMenu(null);
        },
      },
      {
        label: currentLabel ? `Rename (${currentLabel})` : 'Set display name…',
        onClick: () => {
          setDisplayNameEdit({ fieldKey, currentLabel });
          setContextMenu(null);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Copy field name',
        onClick: () => navigator.clipboard.writeText(fieldKey),
      },
    ];
  }

  async function handleEditSave(fieldKey: string, rawValue: string) {
    let parsed: any = rawValue;
    try { parsed = JSON.parse(rawValue); } catch { /* keep as string */ }
    setEditing(null);
    try {
      await dispatch({
        op: 'DEF',
        target: figure.target,
        operand: { [fieldKey]: parsed },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      syncEditToAirtable({ target: figure.target, fieldKey, value: parsed, getStateByPrefix }).catch(console.warn);
    } catch { /* ignore */ }
  }

  async function handleDisplayNameSave(fieldKey: string, newLabel: string) {
    const updated = { ...fieldLabels, [fieldKey]: newLabel || undefined };
    // Clean up empty entries
    for (const k of Object.keys(updated)) {
      if (!updated[k]) delete updated[k];
    }
    try {
      await dispatch({
        op: 'DEF',
        target: figure.target,
        operand: { _fieldLabels: Object.keys(updated).length > 0 ? updated : undefined },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setDisplayNameEdit(null);
  }

  async function handleLinkRemove(fieldKey: string, idToRemove: string, currentIds: string[]) {
    const updatedIds = currentIds.filter(id => id !== idToRemove);
    await dispatch({
      op: 'DEF',
      target: figure.target,
      operand: { [fieldKey]: updatedIds },
      agent: 'user',
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    });
  }

  return (
    <div
      ref={gridRef}
      style={{
        ...s.grid,
        gridTemplateColumns: twoColumn ? 'repeat(2, minmax(0, 1fr))' : '1fr',
        columnGap: twoColumn ? 24 : 0,
      }}
    >
      {entries.map(([key, val]) => {
        const fts = fieldTypeMap.get(key);

        // Parse JSON-stringified arrays before pattern detection (e.g. '["ATT-005"]')
        let parsedVal: unknown = val;
        if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
          try { const p = JSON.parse(val); if (Array.isArray(p)) parsedVal = p; } catch { /* keep */ }
        }

        // Treat entity-ID array values as link fields even without an explicit schema definition
        const valIsIdArray = isEntityIdArray(parsedVal);
        const isLinkField = fts?.type === 'link' || valIsIdArray;

        // Infer linked table from resolver when no explicit schema definition exists
        const effectiveLinkedTable = fts?.linkedTable ?? (() => {
          if (!valIsIdArray || !Array.isArray(parsedVal) || parsedVal.length === 0) return undefined;
          const resolved = resolver.resolve(parsedVal[0]);
          if (!resolved) return undefined;
          return resolved.target.split('.').slice(0, -1).join('.');
        })();

        // Time-travel: was this field's value different from current?
        const isHistoric = !!recordTs;
        const currentVal = (value as Record<string, unknown>)[key];
        const valueChanged = isHistoric && JSON.stringify(val) !== JSON.stringify(currentVal);
        const notYetRecorded = isHistoric && val === undefined;
        return (
          <div
            key={key}
            style={{ ...s.cell, ...(notYetRecorded ? { opacity: 0.3 } : {}) }}
            onContextMenu={(e) => handleContextMenu(e, key)}
          >
            <div style={s.label}>
              {fieldLabels[key] || schemaFieldNames.get(key) || (key.startsWith('fld') ? formatName(key) : key)}
              {value._computed && key === '_computed' && (
                <span style={s.evaBadge}>EVA</span>
              )}
              {sigs[key] && (
                <span style={s.sigBadge} title={`${sigs[key].agent} is editing`}>
                  {shortAgent(sigs[key].agent)} editing…
                </span>
              )}
            </div>
            <div
              style={{ ...s.value, cursor: editing?.fieldKey === key ? 'auto' : (isLinkField ? 'default' : 'text'), position: 'relative' as const }}
              onDoubleClick={() => {
                if (editing?.fieldKey === key || isLinkField) return;
                const currentVal = value[key];
                const strVal = currentVal != null && typeof currentVal === 'object'
                  ? JSON.stringify(currentVal, null, 2)
                  : String(currentVal ?? '');
                setEditing({ fieldKey: key, value: strVal });
                dispatchSig(key, { draft: strVal });
              }}
            >
              {editing?.fieldKey === key ? (
                <form
                  style={{ width: '100%' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const input = (e.target as HTMLFormElement).elements.namedItem('fieldVal') as HTMLInputElement;
                    handleEditSave(key, input.value);
                  }}
                >
                  <input
                    name="fieldVal"
                    autoFocus
                    defaultValue={editing.value}
                    style={{
                      width: '100%',
                      padding: '4px 6px',
                      fontSize: 13,
                      border: `1px solid ${theme.accent}`,
                      borderRadius: 4,
                      background: theme.bg,
                      color: theme.text,
                      outline: 'none',
                      boxSizing: 'border-box' as const,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        dispatchSig(key, { editing: false });
                        setEditing(null);
                      }
                    }}
                    onBlur={(e) => handleEditSave(key, e.target.value)}
                  />
                </form>
              ) : isLinkField ? (
                /* Airtable-style inline link field cell */
                <div style={{ position: 'relative' as const }}>
                  {notYetRecorded ? (
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: theme.textMuted,
                      fontStyle: 'italic' as const,
                    }}>not yet recorded</span>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap' as const,
                        gap: 4,
                        alignItems: 'center',
                        padding: '3px 4px',
                        borderRadius: 4,
                        border: `1px solid ${openLinkPicker === key ? theme.accent : theme.borderLight}`,
                        cursor: effectiveLinkedTable && !recordTs ? 'pointer' : 'default',
                        minHeight: 28,
                        background: openLinkPicker === key ? `${theme.accent}10` : 'transparent',
                        transition: 'border-color 0.15s',
                      }}
                      onClick={() => {
                        if (effectiveLinkedTable && !recordTs && openLinkPicker !== key)
                          setOpenLinkPicker(key);
                      }}
                    >
                      {Array.isArray(parsedVal) && (parsedVal as string[]).map((id: string) => {
                        const resolved = resolver.resolve(id);
                        return (
                          <span key={id} style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 3,
                            padding: '2px 4px 2px 8px',
                            borderRadius: 4,
                            fontSize: 12,
                            background: theme.bgMuted,
                            border: `1px solid ${theme.borderLight}`,
                            fontFamily: "'JetBrains Mono', monospace",
                            color: resolved ? theme.purple : theme.textSecondary,
                          }}>
                            <span
                              onClick={e => { e.stopPropagation(); if (resolved) onNavigate(resolved.target); }}
                              style={{ cursor: resolved ? 'pointer' : 'default' }}
                            >
                              {id}
                              {resolved?.name && (
                                <span style={{ fontWeight: 400, color: theme.text, marginLeft: 4, fontFamily: 'inherit', fontSize: 11 }}>{resolved.name}</span>
                              )}
                            </span>
                            {!recordTs && (
                              <span
                                onClick={e => {
                                  e.stopPropagation();
                                  if (Array.isArray(parsedVal)) handleLinkRemove(key, id, parsedVal as string[]);
                                }}
                                style={{
                                  marginLeft: 2,
                                  cursor: 'pointer',
                                  color: theme.textMuted,
                                  lineHeight: 1,
                                  fontSize: 14,
                                  fontWeight: 300,
                                  padding: '0 2px',
                                  opacity: 0.7,
                                }}
                                title="Remove link"
                              >×</span>
                            )}
                          </span>
                        );
                      })}
                      {effectiveLinkedTable && !recordTs && (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 20,
                          height: 20,
                          borderRadius: 3,
                          fontSize: 16,
                          lineHeight: '1',
                          color: theme.textMuted,
                          cursor: 'pointer',
                          flexShrink: 0,
                        }}>+</span>
                      )}
                      {valueChanged && (
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 9,
                          color: theme.textMuted,
                          border: `1px solid ${theme.border}`,
                          padding: '1px 5px',
                          borderRadius: 3,
                          flexShrink: 0,
                        }}>was</span>
                      )}
                    </div>
                  )}
                  {openLinkPicker === key && effectiveLinkedTable && (
                    <>
                      <div style={{ position: 'fixed' as const, inset: 0, zIndex: 199 }} onClick={() => setOpenLinkPicker(null)} />
                      <LinkFieldPicker
                        fieldKey={key}
                        linkedTable={effectiveLinkedTable}
                        currentIds={Array.isArray(parsedVal) ? parsedVal as string[] : []}
                        onClose={() => setOpenLinkPicker(null)}
                        onChange={async (updatedIds) => {
                          await dispatch({
                            op: 'DEF',
                            target: figure.target,
                            operand: { [key]: updatedIds },
                            agent: 'user',
                            ts: new Date().toISOString(),
                            acquired_ts: new Date().toISOString(),
                          });
                        }}
                      />
                    </>
                  )}
                </div>
              ) : (
                <>
                  {notYetRecorded ? (
                    <span style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: theme.textMuted,
                      fontStyle: 'italic' as const,
                    }}>not yet recorded</span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {renderFieldValue(val, onNavigate, theme, resolver)}
                      {valueChanged && (
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 9,
                          color: theme.textMuted,
                          border: `1px solid ${theme.border}`,
                          padding: '1px 5px',
                          borderRadius: 3,
                          flexShrink: 0,
                        }}>was</span>
                      )}
                    </span>
                  )}
                </>
              )}
            </div>
            {isHistoric && (
              <FieldHistoryTrail
                history={fieldHistories.get(key) ?? []}
                recordTs={recordTs ?? null}
                theme={theme}
              />
            )}
          </div>
        );
      })}

      {/* Relationship fields: data lives in _edges, not in value properties */}
      {[...fieldTypeMap.entries()]
        .filter(([, fts]) => fts.type === 'relationship')
        .map(([key, fts]) => {
          const allEdges: Array<{ dest: string; edge_type?: string; attrs?: Record<string, unknown> }> =
            Array.isArray(value._edges) ? value._edges : [];
          const fieldEdges = allEdges.filter(e => e.edge_type === key);
          return (
            <div key={`rel_${key}`} style={s.cell}>
              <div style={s.label}>
                {fieldLabels[key] || schemaFieldNames.get(key) || key}
              </div>
              <div style={s.value}>
                <RelationshipFieldPanel
                  fieldKey={key}
                  figure={figure}
                  linkedTable={fts.linkedTable ?? ''}
                  edgeAttrDefs={fts.edgeAttrDefs ?? []}
                  edges={fieldEdges}
                  onNavigate={onNavigate}
                />
              </div>
            </div>
          );
        })
      }

      {/* Right-click context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.fieldKey)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Display name editor popover */}
      {displayNameEdit && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setDisplayNameEdit(null)}
          />
          <div style={{
            position: 'fixed',
            left: '50%',
            top: '30%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
            padding: 16,
            minWidth: 280,
          }}>
            <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>Display name</div>
            <div style={{ fontSize: 10, color: theme.textMuted, marginBottom: 8, fontFamily: "'JetBrains Mono', monospace" }}>
              Field: {displayNameEdit.fieldKey}
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              const input = (e.target as HTMLFormElement).elements.namedItem('displayName') as HTMLInputElement;
              handleDisplayNameSave(displayNameEdit.fieldKey, input.value.trim());
            }}>
              <input
                name="displayName"
                autoFocus
                defaultValue={displayNameEdit.currentLabel}
                placeholder="Enter display name..."
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  fontSize: 13,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 4,
                  background: theme.bg,
                  color: theme.text,
                  outline: 'none',
                  boxSizing: 'border-box' as const,
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setDisplayNameEdit(null);
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setDisplayNameEdit(null)}
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 4,
                    background: 'transparent',
                    color: theme.text,
                    cursor: 'pointer',
                  }}
                >Cancel</button>
                <button
                  type="submit"
                  style={{
                    padding: '4px 12px',
                    fontSize: 12,
                    border: 'none',
                    borderRadius: 4,
                    background: theme.accent,
                    color: '#fff',
                    cursor: 'pointer',
                  }}
                >Save</button>
              </div>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

/** Detect an array of Airtable field-definition objects: [{id, name, type, ...}] */
function isAirtableFieldArray(val: unknown): val is Array<{ id: string; name: string; type: string }> {
  if (!Array.isArray(val) || val.length === 0) return false;
  const first = val[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    'id' in first &&
    'name' in first &&
    'type' in first
  );
}

/** Detect an array where every element is a non-null, non-string object */
function isObjectArray(val: unknown): val is Record<string, unknown>[] {
  return (
    Array.isArray(val) &&
    val.length > 0 &&
    val.every((v) => typeof v === 'object' && v !== null)
  );
}

/**
 * Render a compact "values over time" trail under a field cell while the
 * per-record time-scrubber is active. Shows every distinct value the field
 * has held with its timestamp; the entry at or just before `recordTs` is
 * highlighted so the user can see which historical point they're looking at.
 */
function FieldHistoryTrail({
  history,
  recordTs,
  theme: t,
}: {
  history: Array<{ ts: number; value: unknown }>;
  recordTs: number | null;
  theme: Theme;
}) {
  if (!history || history.length < 2) return null;

  // Find the index of the entry whose ts is the latest <= recordTs
  let activeIdx = -1;
  if (recordTs != null) {
    for (let i = 0; i < history.length; i++) {
      if (history[i].ts <= recordTs) activeIdx = i;
    }
  }

  const formatValue = (v: unknown): string => {
    if (v === undefined) return '∅';
    if (v === null) return 'null';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      const s = JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 57) + '…' : s;
    } catch {
      return String(v);
    }
  };

  const formatDate = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  };

  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 5,
        borderTop: `1px dashed ${t.borderLight}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: t.textMuted,
          opacity: 0.7,
          marginBottom: 1,
        }}
      >
        values over time
      </div>
      {history.map((entry, i) => {
        const isActive = i === activeIdx;
        return (
          <div
            key={`${entry.ts}-${i}`}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              color: isActive ? t.text : t.textMuted,
              opacity: isActive ? 1 : 0.75,
              lineHeight: 1.35,
            }}
          >
            <span
              style={{
                width: 4,
                height: 4,
                borderRadius: '50%',
                background: isActive ? t.accent : t.border,
                flexShrink: 0,
                alignSelf: 'center',
              }}
            />
            <span
              style={{
                color: isActive ? t.accent : t.textMuted,
                minWidth: 54,
                flexShrink: 0,
              }}
            >
              {formatDate(entry.ts)}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: isActive ? 500 : 400,
              }}
              title={formatValue(entry.value)}
            >
              {formatValue(entry.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function renderFieldValue(
  val: any,
  onNavigate: (t: string) => void,
  t: Theme,
  resolver: IdResolver,
): React.ReactNode {
  // Parse JSON-stringified arrays/objects (e.g. values stored as '["EVT-089","EVT-010"]')
  if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
    try { const p = JSON.parse(val); if (Array.isArray(p)) val = p; } catch { /* keep as string */ }
  }
  if (typeof val === 'string' && val.startsWith('{') && val.endsWith('}')) {
    try { const p = JSON.parse(val); if (p && typeof p === 'object' && !Array.isArray(p)) val = p; } catch { /* keep as string */ }
  }

  // Object with CON linked array
  if (typeof val === 'object' && val !== null && val.linked && Array.isArray(val.linked)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {val.linked.map((target: string) => {
          const resolved = resolver.resolveTarget(target);
          const shortId = target.split('.').pop() || target;
          return (
            <div
              key={target}
              onClick={() => onNavigate(target)}
              style={{ color: t.purple, cursor: 'pointer', fontSize: 13 }}
            >
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{shortId}</span>
              {resolved?.name && (
                <span style={{ color: t.text, fontWeight: 400 }}>{' · '}{resolved.name}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Array of entity IDs
  if (isEntityIdArray(val)) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {val.map((id: string) => {
          const resolved = resolver.resolve(id);
          return (
            <span
              key={id}
              onClick={resolved ? () => onNavigate(resolved.target) : undefined}
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 4,
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 12,
                background: t.bgMuted,
                border: `1px solid ${t.borderLight}`,
                color: resolved ? t.purple : t.textSecondary,
                cursor: resolved ? 'pointer' : 'default',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {id}
              {resolved?.name && (
                <span style={{ fontFamily: 'inherit', fontSize: 11, color: t.text, fontWeight: 400 }}>{' · '}{resolved.name}</span>
              )}
            </span>
          );
        })}
      </div>
    );
  }

  // Array of target-path strings (e.g. ["import.cases.CASE-001", ...]) — render as clickable links
  if (Array.isArray(val) && val.length > 0 && val.every((v: unknown) => typeof v === 'string' && (v as string).includes('.'))) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {val.map((target: string) => {
          const resolved = resolver.resolveTarget(target);
          const shortId = target.split('.').pop() || target;
          return (
            <div
              key={target}
              onClick={() => onNavigate(target)}
              style={{ color: t.purple, cursor: 'pointer', fontSize: 13 }}
            >
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{shortId}</span>
              {resolved?.name && (
                <span style={{ color: t.text, fontWeight: 400 }}>{' · '}{resolved.name}</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // Airtable field-definition array: [{id, name, type, description?, ...}]
  if (isAirtableFieldArray(val)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {val.map((field) => {
          const icon = getAirtableTypeIcon(field.type);
          const color = getAirtableTypeColor(field.type);
          const desc = (field as Record<string, unknown>).description as string | undefined;
          return (
            <div
              key={field.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 0',
                borderBottom: `1px solid ${t.borderLight}`,
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 20,
                  borderRadius: 4,
                  fontSize: 9,
                  fontFamily: "'JetBrains Mono', monospace",
                  background: t.bgMuted,
                  color,
                  flexShrink: 0,
                  letterSpacing: '-0.5px',
                }}
              >
                {icon}
              </span>
              <span style={{ fontSize: 13, color: t.text, flex: 1, minWidth: 0 }}>
                {field.name}
                {desc && (
                  <span style={{ fontSize: 11, color: t.textMuted, marginLeft: 8 }}>{desc}</span>
                )}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: t.textMuted,
                  fontFamily: "'JetBrains Mono', monospace",
                  flexShrink: 0,
                }}
              >
                {field.type}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  // Generic object array — render each item as an expandable key-value block
  if (isObjectArray(val)) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {val.map((item, i) => (
          <div
            key={i}
            style={{
              padding: '4px 8px',
              borderRadius: 4,
              background: t.bgMuted,
              border: `1px solid ${t.borderLight}`,
              fontSize: 12,
            }}
          >
            {renderFieldValue(item, onNavigate, t, resolver)}
          </div>
        ))}
      </div>
    );
  }

  // Plain string array (e.g. practice_areas: ["corporate_litigation", "bankruptcy"])
  if (Array.isArray(val)) {
    if (val.length === 0) {
      return <span style={{ color: t.textSecondary, fontSize: 13, fontStyle: 'italic' }}>none</span>;
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {val.map((item: unknown, i: number) => (
          <span
            key={i}
            style={{
              display: 'inline-flex',
              padding: '2px 8px',
              borderRadius: 4,
              fontSize: 12,
              background: t.bgMuted,
              border: `1px solid ${t.borderLight}`,
              color: t.textSecondary,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {String(item)}
          </span>
        ))}
      </div>
    );
  }

  // Other objects (non-array, non-linked) — render as key-value pairs recursively
  if (typeof val === 'object' && val !== null) {
    const objEntries = Object.entries(val);
    if (objEntries.length === 0) {
      return <span style={{ color: t.textSecondary, fontSize: 13, fontStyle: 'italic' }}>empty</span>;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {objEntries.map(([k, v]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 0', borderBottom: `1px solid ${t.borderLight}` }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: t.textMuted, minWidth: 80, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
            <span style={{ fontSize: 12, color: t.text, wordBreak: 'break-word' }}>
              {renderFieldValue(v, onNavigate, t, resolver)}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Single entity ID string
  if (typeof val === 'string' && isEntityId(val)) {
    const resolved = resolver.resolve(val);
    if (resolved) {
      return (
        <span
          onClick={() => onNavigate(resolved.target)}
          style={{ color: t.purple, cursor: 'pointer', fontSize: 13 }}
        >
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{val}</span>
          {resolved.name && (
            <span style={{ fontWeight: 400 }}>{' · '}{resolved.name}</span>
          )}
        </span>
      );
    }
  }

  // Default: plain string
  return <>{String(val)}</>;
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    grid: {
      display: 'grid',
      gridTemplateColumns: '1fr',
      rowGap: 0,
      columnGap: 0,
    },
    cell: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 16,
      padding: '10px 0',
      borderBottom: `1px solid ${t.border}`,
      minWidth: 0,
    },
    label: {
      fontSize: 11,
      fontWeight: 500,
      color: t.textMuted,
      width: 160,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
    },
    value: {
      fontSize: 13,
      color: t.textHeading,
      fontWeight: 400,
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
      wordBreak: 'break-word' as const,
    },
    mono: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textSecondary,
      wordBreak: 'break-all' as const,
      overflow: 'hidden',
    },
    fieldKeyHint: {
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      opacity: 0.6,
      marginLeft: 4,
    },
    evaBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      color: t.teal,
      padding: '1px 4px',
      borderRadius: 2,
      background: t.tealBg,
      border: `1px solid ${t.tealBorder}`,
    },
    sigBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.warning,
      padding: '1px 5px',
      borderRadius: 2,
      background: t.warningBg ?? 'rgba(255,152,0,0.1)',
      border: `1px solid ${t.warningBorder ?? 'rgba(255,152,0,0.3)'}`,
      marginLeft: 4,
      animation: 'pulse 1.5s ease-in-out infinite',
    },
  };
}
