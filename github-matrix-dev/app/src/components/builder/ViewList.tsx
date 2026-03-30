import { useEffect, useState } from 'react';
import { useEoStore } from '../../store/eo-store';
import { useBuilderStore } from '../../store/builder-store';
import { useTheme, type Theme } from '../../theme';
import type { EoState } from '../../db/types';
import type { ViewDefinition } from '../../blocks/types';

interface ViewListProps {
  onSelectView: () => void;
}

export function ViewList({ onSelectView }: ViewListProps) {
  const ready = useEoStore((s) => s.ready);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const loadView = useBuilderStore((s) => s.loadView);
  const newView = useBuilderStore((s) => s.newView);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [views, setViews] = useState<EoState[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('views.').then(setViews);
  }, [ready, lastSeq, getStateByPrefix]);

  const handleCreate = () => {
    const name = newName.trim() || 'Untitled View';
    newView(name);
    setCreating(false);
    setNewName('');
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
          <div style={s.createRow}>
            <input
              style={s.input}
              placeholder="View name..."
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <button style={s.createBtn} onClick={handleCreate}>Create</button>
            <button style={s.cancelBtn} onClick={() => setCreating(false)}>Cancel</button>
          </div>
        ) : (
          <button style={s.newBtn} onClick={() => setCreating(true)}>
            + New View
          </button>
        )}
      </div>

      {views.length > 0 && (
        <div style={s.list}>
          <div style={s.listHeader}>Existing Views</div>
          {views.map((v) => {
            const def = v.value as ViewDefinition | null;
            const name = def?.name || v.target.replace(/^views\./, '');
            const blockCount = def?.blocks?.length || 0;
            return (
              <div key={v.target} style={s.viewCard} onClick={() => handleOpen(v)}>
                <div style={s.viewName}>{name}</div>
                <div style={s.viewMeta}>
                  {blockCount} block{blockCount !== 1 ? 's' : ''} · Updated {new Date(v.last_ts).toLocaleDateString()}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {views.length === 0 && !creating && (
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
    createRow: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
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
