import { useState } from 'react';
import { useTheme, type Theme } from '../theme';

// ---------------------------------------------------------------------------
// Archive storage — localStorage-backed list of archived spaces
// ---------------------------------------------------------------------------

export interface ArchivedSpace {
  target: string;           // e.g. "space_clients"
  name: string;             // display name
  archivedAt: number;       // epoch ms
  archivedBy: string;       // userId
  memberCount: number;      // for context
}

const STORAGE_KEY = 'eo-archived-spaces';

export function getArchivedSpaces(): ArchivedSpace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addArchivedSpace(space: ArchivedSpace): void {
  const list = getArchivedSpaces().filter((s) => s.target !== space.target);
  list.push(space);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function removeArchivedSpace(target: string): void {
  const list = getArchivedSpaces().filter((s) => s.target !== target);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function isSpaceArchived(target: string): boolean {
  return getArchivedSpaces().some((s) => s.target === target);
}

// ---------------------------------------------------------------------------
// ArchivedSpacesSection — inline component for SettingsView
// ---------------------------------------------------------------------------

function formatUserId(userId: string): string {
  if (!userId) return 'Unknown';
  const local = userId.startsWith('@') ? userId.slice(1).split(':')[0] : userId;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function formatArchivedDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface ArchivedSpacesSectionProps {
  onUnarchive: (target: string) => void;
}

export function ArchivedSpacesSection({ onUnarchive }: ArchivedSpacesSectionProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [spaces, setSpaces] = useState<ArchivedSpace[]>(getArchivedSpaces);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

  function handleUnarchive(target: string) {
    removeArchivedSpace(target);
    setSpaces(getArchivedSpaces());
    setConfirmTarget(null);
    onUnarchive(target);
  }

  if (spaces.length === 0) {
    return (
      <div style={s.empty}>
        <span style={{ fontSize: 11, color: theme.textMuted }}>No archived spaces</span>
      </div>
    );
  }

  return (
    <div style={s.list}>
      {spaces
        .sort((a, b) => b.archivedAt - a.archivedAt)
        .map((sp) => {
          const isConfirming = confirmTarget === sp.target;
          return (
            <div key={sp.target} style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardInfo}>
                  <div style={s.spaceName}>{sp.name}</div>
                  <div style={s.spaceMeta}>
                    <span style={s.metaTag}>{sp.target}</span>
                    {sp.memberCount > 0 && (
                      <span style={s.metaTag}>{sp.memberCount} members</span>
                    )}
                    <span style={s.metaTag}>Archived {formatArchivedDate(sp.archivedAt)}</span>
                    {sp.archivedBy && (
                      <span style={s.metaTag}>by {formatUserId(sp.archivedBy)}</span>
                    )}
                  </div>
                </div>
                <div style={s.actions}>
                  {isConfirming ? (
                    <div style={s.confirmRow}>
                      <span style={{ fontSize: 11, color: theme.textSecondary }}>Unarchive?</span>
                      <button style={s.confirmYes} onClick={() => handleUnarchive(sp.target)}>Yes</button>
                      <button style={s.confirmNo} onClick={() => setConfirmTarget(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      style={s.unarchiveBtn}
                      onClick={() => setConfirmTarget(sp.target)}
                    >
                      {'\u21A9'} Unarchive
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    empty: {
      padding: '12px 0',
    },
    list: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    card: {
      background: t.bgMuted,
      border: `1px solid ${t.borderLight}`,
      borderRadius: 6,
      padding: 10,
    },
    cardHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
    },
    cardInfo: {
      flex: 1,
      minWidth: 0,
    },
    spaceName: {
      fontSize: 12,
      fontWeight: 500,
      color: t.text,
    },
    spaceMeta: {
      display: 'flex',
      gap: 6,
      marginTop: 3,
      flexWrap: 'wrap' as const,
    },
    metaTag: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bgCard,
      padding: '1px 6px',
      borderRadius: 3,
    },
    actions: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexShrink: 0,
    },
    confirmRow: {
      display: 'flex',
      gap: 6,
      alignItems: 'center',
    },
    unarchiveBtn: {
      padding: '4px 10px',
      fontSize: 10,
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.successBg,
      color: t.success,
      border: `1px solid ${t.successBorder}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
    confirmYes: {
      padding: '3px 8px',
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.success,
      color: '#fff',
      border: `1px solid ${t.success}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
    confirmNo: {
      padding: '3px 8px',
      fontSize: 10,
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
      background: 'transparent',
      color: t.textSecondary,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
  };
}
