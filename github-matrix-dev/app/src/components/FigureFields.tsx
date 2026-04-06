import { useState } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';

interface FigureFieldsProps {
  figure: EoState;
  onNavigate: (target: string) => void;
  profileFields?: string[];
}

export function FigureFields({ figure, onNavigate, profileFields }: FigureFieldsProps) {
  const dispatch = useEoStore((s) => s.dispatch);
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const value = figure.value;

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; fieldKey: string } | null>(null);
  const [editing, setEditing] = useState<{ fieldKey: string; value: string } | null>(null);
  const [displayNameEdit, setDisplayNameEdit] = useState<{ fieldKey: string; currentLabel: string } | null>(null);

  if (!value || typeof value !== 'object') {
    return <div style={s.mono}>{JSON.stringify(value)}</div>;
  }

  let entries = Object.entries(value).filter(([k]) => !k.startsWith('_') && k !== 'linked' && k !== 'edge_type');
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
    try {
      await dispatch({
        op: 'DEF',
        target: figure.target,
        operand: { [fieldKey]: parsed },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setEditing(null);
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
            {fieldLabels[key] || key}
            {fieldLabels[key] && (
              <span style={s.fieldKeyHint}>{key}</span>
            )}
            {value._computed && key === '_computed' && (
              <span style={s.evaBadge}>EVA</span>
            )}
          </div>
          <div style={s.value}>
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
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onBlur={(e) => handleEditSave(key, e.target.value)}
                />
              </form>
            ) : typeof val === 'object' && val !== null
              ? renderObjectValue(val, onNavigate, theme)
              : String(val)}
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

function renderObjectValue(val: any, onNavigate: (t: string) => void, t: Theme): React.ReactNode {
  // CON linked array
  if (val.linked && Array.isArray(val.linked)) {
    return (
      <div>
        {val.linked.map((target: string) => (
          <div
            key={target}
            onClick={() => onNavigate(target)}
            style={{ color: t.purple, cursor: 'pointer', fontSize: 13 }}
          >
            {target}
          </div>
        ))}
      </div>
    );
  }
  return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{JSON.stringify(val, null, 1)}</span>;
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
    },
    mono: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textSecondary,
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
  };
}
