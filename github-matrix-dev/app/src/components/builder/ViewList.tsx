import { useEffect, useState, useMemo, useRef } from 'react';
import { useEoStore } from '../../store/eo-store';
import { useBuilderStore } from '../../store/builder-store';
import { useTheme, type Theme } from '../../theme';
import type { EoState } from '../../db/types';
import { type ViewDefinition, type PageType, isViewVisibleToPersona } from '../../blocks/types';
import { ScopePicker } from '../ScopePicker';

interface ViewListProps {
  onSelectView: () => void;
}

export function ViewList({ onSelectView }: ViewListProps) {
  const ready = useEoStore((s) => s.ready);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const activeUserType = useEoStore((s) => s.activeUserType);
  const loadView = useBuilderStore((s) => s.loadView);
  const newView = useBuilderStore((s) => s.newView);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [views, setViews] = useState<EoState[]>([]);
  const prevViewsKeyRef = useRef<string>('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPageType, setNewPageType] = useState<PageType>('page');
  const [newScope, setNewScope] = useState('');
  const setRecordSource = useBuilderStore((s) => s.setRecordSource);

  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('views.').then((states) => {
      const key = states.map(s => s.target + ':' + s.last_seq).join('|');
      if (key !== prevViewsKeyRef.current) {
        prevViewsKeyRef.current = key;
        setViews(states);
      }
    });
  }, [ready, lastSeq, getStateByPrefix]);

  // Filter views visible to the active persona. Builder is gated to admins
  // at the nav level, so canManage=true here — admins always see all views
  // so they can edit visibility. If the persona system later lets non-admins
  // access the builder, the canManage flag should flow from permissions.
  const visibleViews = useMemo(() => {
    return views.filter(v => {
      const def = v.value as ViewDefinition | null;
      return isViewVisibleToPersona(def, activeUserType, /* canManage */ true);
    });
  }, [views, activeUserType]);

  // Collect existing record pages for the "link to record page" dropdown
  const recordPages = useMemo(() => {
    return visibleViews.filter(v => {
      const def = v.value as ViewDefinition | null;
      return def?.pageType === 'record';
    });
  }, [visibleViews]);

  const handleCreate = () => {
    const name = newName.trim() || 'Untitled View';
    const viewId = newView(name, newPageType);

    // Set record source if list or record page
    if ((newPageType === 'list' || newPageType === 'record') && newScope) {
      setRecordSource({ scope: newScope });
    }

    setCreating(false);
    setNewName('');
    setNewPageType('page');
    setNewScope('');
    onSelectView();
  };

  const handleOpen = (viewState: EoState) => {
    const viewId = viewState.target.replace(/^views\./, '');
    const def = viewState.value as ViewDefinition;
    loadView(viewId, def);
    onSelectView();
  };

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>Interface Builder</span>
      </div>
      <div style={s.subtitle}>
        Create custom views by composing block primitives.
      </div>

      <div style={s.actions}>
        {creating ? (
          <div style={s.createForm}>
            <input
              style={s.input}
              placeholder="View name..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />

            {/* Page type selector */}
            <div style={s.pageTypeRow}>
              <span style={s.fieldLabel}>Page Type</span>
              <div style={s.pageTypeBtns}>
                {([
                  { key: 'page' as PageType, label: 'Page', desc: 'Static page' },
                  { key: 'list' as PageType, label: 'List Page', desc: 'Shows a collection' },
                  { key: 'record' as PageType, label: 'Record Page', desc: 'Profile / detail' },
                ] as const).map(pt => (
                  <button
                    key={pt.key}
                    type="button"
                    style={{
                      ...s.pageTypeBtn,
                      ...(newPageType === pt.key ? s.pageTypeBtnActive : {}),
                    }}
                    onClick={() => setNewPageType(pt.key)}
                  >
                    <div style={{ fontWeight: 500 }}>{pt.label}</div>
                    <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>{pt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Collection picker for list/record pages */}
            {(newPageType === 'list' || newPageType === 'record') && (
              <div style={s.pageTypeRow}>
                <span style={s.fieldLabel}>Collection</span>
                <ScopePicker
                  value={newScope ? { mode: 'hierarchy', target: newScope } : undefined}
                  onChange={(binding) => {
                    if (binding.target) setNewScope(binding.target);
                  }}
                />
              </div>
            )}

            <div style={s.createRow}>
              <button style={s.createBtn} onClick={handleCreate}>Create</button>
              <button style={s.cancelBtn} onClick={() => { setCreating(false); setNewPageType('page'); setNewScope(''); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <button style={s.newBtn} onClick={() => setCreating(true)}>
            + New View
          </button>
        )}
      </div>

      {visibleViews.length > 0 && (
        <div style={s.list}>
          <div style={s.listHeader}>Existing Views</div>
          {visibleViews.map((v) => {
            const def = v.value as ViewDefinition | null;
            const name = def?.name || v.target.replace(/^views\./, '');
            const blockCount = def?.blocks?.length || 0;
            const pt = def?.pageType || 'page';
            const scope = def?.recordSource?.scope;
            const restricted = def?.visibleToTypes && def.visibleToTypes.length > 0;
            return (
              <div key={v.target} style={s.viewCard} onClick={() => handleOpen(v)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={s.viewName}>{name}</div>
                  <span style={{
                    fontSize: 9,
                    fontWeight: 600,
                    textTransform: 'uppercase' as const,
                    padding: '2px 6px',
                    borderRadius: 4,
                    background: pt === 'record' ? '#E6F1FB' : pt === 'list' ? '#FFF3E0' : `${theme.border}80`,
                    color: pt === 'record' ? '#185FA5' : pt === 'list' ? '#E65100' : theme.textMuted,
                  }}>{pt}</span>
                  {restricted && (
                    <span
                      title={`Visible to: ${def!.visibleToTypes!.join(', ')}`}
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: `${theme.accent}14`,
                        color: theme.accent,
                      }}
                    >
                      {def!.visibleToTypes!.length} persona{def!.visibleToTypes!.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                <div style={s.viewMeta}>
                  {blockCount} block{blockCount !== 1 ? 's' : ''}
                  {scope && <> · {scope}</>}
                  {' · '}Updated {new Date(v.last_ts).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {visibleViews.length === 0 && !creating && (
        <div style={s.emptyState}>
          No views yet. Create your first view to get started.
        </div>
      )}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      maxWidth: 600,
      margin: '0 auto',
      padding: 24,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    title: {
      fontFamily: "'Source Serif 4', serif",
      fontSize: 24,
      fontWeight: 600,
      color: t.textHeading,
    },
    subtitle: {
      fontSize: 14,
      color: t.textSecondary,
      marginBottom: 20,
    },
    actions: {
      marginBottom: 20,
    },
    createForm: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 12,
      padding: 16,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      background: t.bgCard,
    },
    createRow: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    },
    fieldLabel: {
      display: 'block',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
      color: t.textMuted,
      marginBottom: 6,
    },
    pageTypeRow: {
      marginBottom: 0,
    },
    pageTypeBtns: {
      display: 'flex',
      gap: 8,
    },
    pageTypeBtn: {
      flex: 1,
      padding: '8px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.text,
      cursor: 'pointer',
      textAlign: 'left' as const,
      fontFamily: "'Outfit', sans-serif",
    },
    pageTypeBtnActive: {
      borderColor: t.accent,
      background: t.accentBg,
      color: t.accent,
    },
    input: {
      flex: 1,
      padding: '8px 12px',
      fontSize: 14,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      fontFamily: "'Outfit', sans-serif",
    },
    createBtn: {
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 500,
      border: 'none',
      borderRadius: 6,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    },
    cancelBtn: {
      padding: '8px 16px',
      fontSize: 13,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
    },
    newBtn: {
      padding: '10px 20px',
      fontSize: 14,
      fontWeight: 500,
      border: `1px dashed ${t.border}`,
      borderRadius: 8,
      background: 'transparent',
      color: t.accent,
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
      width: '100%',
    },
    list: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    listHeader: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      color: t.textMuted,
      marginBottom: 4,
    },
    viewCard: {
      padding: '12px 16px',
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      background: t.bgCard,
      cursor: 'pointer',
      transition: 'border-color 0.15s ease',
    },
    viewName: {
      fontSize: 15,
      fontWeight: 500,
      color: t.text,
      marginBottom: 2,
    },
    viewMeta: {
      fontSize: 12,
      color: t.textMuted,
    },
    emptyState: {
      padding: '32px 16px',
      textAlign: 'center',
      color: t.textMuted,
      fontSize: 14,
    },
  };
}
