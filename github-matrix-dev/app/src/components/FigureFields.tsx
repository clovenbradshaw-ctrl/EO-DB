import { useState, useEffect, useMemo } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { buildFieldNameMapFromSchema, buildFieldNameMap } from './filter-types';
import { formatName } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { useIdResolver, isEntityId, isEntityIdArray, type IdResolver } from '../hooks/useIdResolver';
import { syncEditToAirtable } from '../ingestion/airtable-writeback';

interface FigureFieldsProps {
  figure: EoState;
  onNavigate: (target: string) => void;
  profileFields?: string[];
}

export function FigureFields({ figure, onNavigate, profileFields }: FigureFieldsProps) {
  const dispatch = useEoStore((s) => s.dispatch);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const value = figure.value;
  const scopeRoot = figure.target.split('.')[0];
  const resolver = useIdResolver(scopeRoot);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; fieldKey: string } | null>(null);
  const [editing, setEditing] = useState<{ fieldKey: string; value: string } | null>(null);
  const [displayNameEdit, setDisplayNameEdit] = useState<{ fieldKey: string; currentLabel: string } | null>(null);

  // Fetch schema-level field name map for the parent table scope
  const [schemaFieldNames, setSchemaFieldNames] = useState<Map<string, string>>(new Map());
  const tableScope = useMemo(() => {
    const parts = figure.target.split('.');
    // Table scope is everything except the last segment (the record ID)
    return parts.length > 1 ? parts.slice(0, -1).join('.') : figure.target;
  }, [figure.target]);

  useEffect(() => {
    getStateByPrefix(tableScope + '._schema.').then((allSchemaStates) => {
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
    });
  }, [tableScope, getStateByPrefix, getState]);

  if (!value || typeof value !== 'object') {
    return <div style={s.mono}>{JSON.stringify(value)}</div>;
  }

  let entries = Object.entries(value).filter(([k]) => !k.startsWith('_') && k !== 'linked' && k !== 'edge_type');

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

  return (
    <div style={s.grid}>
      {entries.map(([key, val]) => (
        <div
          key={key}
          style={s.cell}
          onContextMenu={(e) => handleContextMenu(e, key)}
        >
          <div style={s.label}>
            {fieldLabels[key] || schemaFieldNames.get(key) || (key.startsWith('fld') ? formatName(key) : key)}
            {(fieldLabels[key] || schemaFieldNames.has(key) || key.startsWith('fld')) && (
              <span style={s.fieldKeyHint}>{key}</span>
            )}
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
            style={{ ...s.value, cursor: editing?.fieldKey === key ? 'auto' : 'text' }}
            onDoubleClick={() => {
              if (editing?.fieldKey === key) return;
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
            ) : renderFieldValue(val, onNavigate, theme, resolver)}
          </div>
        </div>
      ))}

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

function renderFieldValue(
  val: any,
  onNavigate: (t: string) => void,
  t: Theme,
  resolver: IdResolver,
): React.ReactNode {
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
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 0,
    },
    cell: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 16,
      padding: '10px 0',
      borderBottom: `1px solid ${t.border}`,
    },
    label: {
      fontSize: 11,
      fontWeight: 500,
      color: t.textMuted,
      minWidth: 120,
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
