import { useState } from 'react';
import { useTheme, type Theme } from '../theme';

// ---------------------------------------------------------------------------
// Soft-delete storage — localStorage-backed list of deleted spaces
// ---------------------------------------------------------------------------

export interface DeletedSpace {
  target: string;           // e.g. "space.clients"
  name: string;             // display name
  deletedAt: number;        // epoch ms
  deletedBy: string;        // userId
  memberCount: number;      // for context
}

const STORAGE_KEY = 'eo-deleted-spaces';

export function getDeletedSpaces(): DeletedSpace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function addDeletedSpace(space: DeletedSpace): void {
  const list = getDeletedSpaces().filter((s) => s.target !== space.target);
  list.push(space);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function removeDeletedSpace(target: string): void {
  const list = getDeletedSpaces().filter((s) => s.target !== target);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function isSpaceDeleted(target: string): boolean {
  return getDeletedSpaces().some((s) => s.target === target);
}

// ---------------------------------------------------------------------------
// Retention policy — 30-day window before permanent purge eligibility
// ---------------------------------------------------------------------------

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function daysRemaining(deletedAt: number): number {
  const elapsed = Date.now() - deletedAt;
  const remaining = RETENTION_MS - elapsed;
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

function formatDeletedDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// RecycleBin component
// ---------------------------------------------------------------------------

interface RecycleBinProps {
  onRestore: (target: string) => void;
  onPermanentDelete: (target: string) => void;
  onBack: () => void;
}

export function RecycleBin({ onRestore, onPermanentDelete, onBack }: RecycleBinProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [spaces, setSpaces] = useState<DeletedSpace[]>(getDeletedSpaces);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [confirmType, setConfirmType] = useState<'restore' | 'purge' | null>(null);

  function handleRestore(target: string) {
    removeDeletedSpace(target);
    setSpaces(getDeletedSpaces());
    setConfirmTarget(null);
    setConfirmType(null);
    onRestore(target);
  }

  function handlePurge(target: string) {
    removeDeletedSpace(target);
    setSpaces(getDeletedSpaces());
    setConfirmTarget(null);
    setConfirmType(null);
    onPermanentDelete(target);
  }

  const isEmpty = spaces.length === 0;

  return (
    <div style={s.container}>
      <div style={s.content}>
        {/* Header */}
        <div style={s.header}>
          <button onClick={onBack} style={s.backButton}>
            {'\u2190'} Back
          </button>
          <div>
            <div style={s.title}>
              <span style={{ fontSize: 18, opacity: 0.6 }}>{'\u2672'}</span>
              {' '}Recycle Bin
            </div>
            <div style={s.subtitle}>
              Deleted spaces are retained for 30 days before becoming eligible for permanent removal.
              Matrix retention policies govern server-side cleanup.
            </div>
          </div>
        </div>

        {/* Empty state */}
        {isEmpty && (
          <div style={s.empty}>
            <div style={{ fontSize: 32, opacity: 0.2 }}>{'\u2672'}</div>
            <div style={{ fontSize: 13, color: theme.textSecondary }}>No deleted spaces</div>
            <div style={{ fontSize: 11, color: theme.textMuted, maxWidth: 260, textAlign: 'center', lineHeight: 1.5 }}>
              When you delete a space, it will appear here for 30 days before it can be permanently removed.
            </div>
          </div>
        )}

        {/* Deleted spaces list */}
        {!isEmpty && (
          <div style={s.list}>
            {spaces
              .sort((a, b) => b.deletedAt - a.deletedAt)
              .map((sp) => {
                const days = daysRemaining(sp.deletedAt);
                const isExpired = days === 0;
                const isConfirming = confirmTarget === sp.target;

                return (
                  <div key={sp.target} style={s.card}>
                    <div style={s.cardHeader}>
                      <div style={s.cardInfo}>
                        <div style={s.spaceName}>{sp.name}</div>
                        <div style={s.spaceMeta}>
                          <span style={s.metaTag}>{sp.target}</span>
                          {sp.memberCount > 0 && (
                            <span style={s.metaTag}>{sp.memberCount + 1} members</span>
                          )}
                        </div>
                      </div>
                      <div style={s.retention}>
                        {isExpired ? (
                          <span style={{ ...s.retentionBadge, background: theme.dangerBg, color: theme.danger, borderColor: theme.dangerBorder }}>
                            Retention expired
                          </span>
                        ) : (
                          <span style={s.retentionBadge}>
                            {days} day{days !== 1 ? 's' : ''} remaining
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={s.cardFooter}>
                      <div style={s.deletedInfo}>
                        Deleted {formatDeletedDate(sp.deletedAt)}
                      </div>
                      <div style={s.actions}>
                        {isConfirming && confirmType === 'restore' ? (
                          <div style={s.confirmRow}>
                            <span style={{ fontSize: 11, color: theme.textSecondary }}>Restore this space?</span>
                            <button style={s.confirmYes} onClick={() => handleRestore(sp.target)}>Yes, restore</button>
                            <button style={s.confirmNo} onClick={() => { setConfirmTarget(null); setConfirmType(null); }}>Cancel</button>
                          </div>
                        ) : isConfirming && confirmType === 'purge' ? (
                          <div style={s.confirmRow}>
                            <span style={{ fontSize: 11, color: theme.danger }}>Permanently delete? This cannot be undone.</span>
                            <button style={{ ...s.confirmYes, background: theme.danger, borderColor: theme.danger }} onClick={() => handlePurge(sp.target)}>Delete forever</button>
                            <button style={s.confirmNo} onClick={() => { setConfirmTarget(null); setConfirmType(null); }}>Cancel</button>
                          </div>
                        ) : (
                          <>
                            <button
                              style={s.restoreBtn}
                              onClick={() => { setConfirmTarget(sp.target); setConfirmType('restore'); }}
                            >
                              {'\u21A9'} Restore
                            </button>
                            <button
                              style={s.purgeBtn}
                              onClick={() => { setConfirmTarget(sp.target); setConfirmType('purge'); }}
                            >
                              {'\u2716'} Delete permanently
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* Retention info footer */}
        <div style={s.infoFooter}>
          <div style={s.infoIcon}>{'\u24D8'}</div>
          <div style={s.infoText}>
            <strong>Soft delete</strong> removes spaces from your workspace but preserves data
            in Matrix rooms according to server retention policies. Restoring a space re-adds it
            to your local browser. Permanent deletion removes local IndexedDB data only &mdash;
            Matrix room history is governed by your homeserver's retention settings.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '8px 16px 40px',
    },
    content: {
      width: '100%',
      maxWidth: 640,
    },
    header: {
      padding: '24px 0 16px',
      borderBottom: `1px solid ${t.border}`,
      marginBottom: 16,
    },
    backButton: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      background: 'transparent',
      border: 'none',
      color: t.accent,
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      padding: '4px 0',
      marginBottom: 12,
      fontFamily: "'JetBrains Mono', monospace",
    },
    title: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 20,
      fontWeight: 600,
      color: t.textHeading,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    subtitle: {
      fontSize: 12,
      color: t.textSecondary,
      marginTop: 6,
      lineHeight: 1.5,
      maxWidth: 520,
    },
    empty: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '60px 20px',
      gap: 10,
    },
    list: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    },
    card: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 14,
    },
    cardHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
    },
    cardInfo: {
      flex: 1,
      minWidth: 0,
    },
    spaceName: {
      fontSize: 14,
      fontWeight: 500,
      color: t.text,
    },
    spaceMeta: {
      display: 'flex',
      gap: 6,
      marginTop: 4,
      flexWrap: 'wrap' as const,
    },
    metaTag: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 3,
    },
    retention: {},
    retentionBadge: {
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '3px 8px',
      borderRadius: 10,
      background: t.warningBg,
      color: t.warning,
      border: `1px solid ${t.warningBorder}`,
      whiteSpace: 'nowrap' as const,
    },
    cardFooter: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 12,
      paddingTop: 10,
      borderTop: `1px solid ${t.borderLight}`,
      flexWrap: 'wrap' as const,
      gap: 8,
    },
    deletedInfo: {
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    actions: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    },
    confirmRow: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexWrap: 'wrap' as const,
    },
    restoreBtn: {
      padding: '5px 12px',
      fontSize: 11,
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
      background: t.successBg,
      color: t.success,
      border: `1px solid ${t.successBorder}`,
      borderRadius: 5,
      cursor: 'pointer',
    },
    purgeBtn: {
      padding: '5px 12px',
      fontSize: 11,
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
      background: 'transparent',
      color: t.danger,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 5,
      cursor: 'pointer',
    },
    confirmYes: {
      padding: '4px 10px',
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
      padding: '4px 10px',
      fontSize: 10,
      fontWeight: 500,
      fontFamily: "'JetBrains Mono', monospace",
      background: 'transparent',
      color: t.textSecondary,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
    infoFooter: {
      display: 'flex',
      gap: 10,
      marginTop: 24,
      padding: 14,
      background: t.bgMuted,
      border: `1px solid ${t.borderLight}`,
      borderRadius: 8,
    },
    infoIcon: {
      fontSize: 14,
      color: t.accent,
      flexShrink: 0,
      marginTop: 1,
    },
    infoText: {
      fontSize: 11,
      color: t.textSecondary,
      lineHeight: 1.6,
    },
  };
}
