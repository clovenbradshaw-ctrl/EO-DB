/**
 * SpaceBrowser — file-browser-style workspace selector.
 *
 * Displays spaces as "project files" in a sortable table with metadata
 * columns: Name, Owner, Created, Last Modified, Members. Supports
 * inline creation of new spaces.
 */

import { useState, useMemo } from 'react';
import { useTheme, type Theme } from '../theme';
import type { SpaceEntry } from '../matrix/space-discovery';

type SortColumn = 'name' | 'owner' | 'created' | 'modified' | 'members';
type SortDir = 'asc' | 'desc';

export interface CreateSpaceUIOptions {
  discoverability: 'public' | 'private';
  inviteUserIds?: string[];
}

interface SpaceBrowserProps {
  entries: SpaceEntry[];
  loading: boolean;
  /** Whether the Matrix connection is ready (required for space creation) */
  matrixReady?: boolean;
  activeSpace: string | null;
  onSelect: (spaceTarget: string) => void;
  onClose: () => void;
  onCreate: (name: string, opts: CreateSpaceUIOptions) => void | Promise<void>;
  onDelete?: (spaceTarget: string) => void;
  onArchive?: (spaceTarget: string) => void;
  onOpenRecycleBin?: () => void;
  deletedCount?: number;
  archivedCount?: number;
  /** Public spaces (not yet joined) to show as discoverable */
  publicEntries?: SpaceEntry[];
  /** Send a knock request to join a public space */
  onRequestAccess?: (mainRoomId: string) => void;
  /** Error message to display as an inline banner (e.g. archive permission failure) */
  actionError?: string | null;
  /** Callback to dismiss the actionError banner */
  onDismissActionError?: () => void;
}

function relativeTime(ts: number): string {
  if (!ts) return '\u2014';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDate(ts: number): string {
  if (!ts) return '\u2014';
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function SpaceBrowser({ entries, loading, matrixReady = true, activeSpace, onSelect, onClose, onCreate, onDelete, onArchive, onOpenRecycleBin, deletedCount = 0, archivedCount = 0, publicEntries = [], onRequestAccess, actionError = null, onDismissActionError }: SpaceBrowserProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [sort, setSort] = useState<{ col: SortColumn; dir: SortDir }>({ col: 'modified', dir: 'desc' });
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDiscoverability, setNewDiscoverability] = useState<'public' | 'private'>('public');
  const [newInviteInput, setNewInviteInput] = useState('');
  const [newInviteList, setNewInviteList] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const list = [...entries];
    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      switch (sort.col) {
        case 'name': return dir * a.displayName.localeCompare(b.displayName);
        case 'owner': return dir * a.ownerDisplayName.localeCompare(b.ownerDisplayName);
        case 'created': return dir * (a.createdAt - b.createdAt);
        case 'modified': return dir * (a.lastActivity - b.lastActivity);
        case 'members': return dir * (a.memberCount - b.memberCount);
        default: return 0;
      }
    });
    return list;
  }, [entries, sort]);

  function toggleSort(col: SortColumn) {
    setSort((prev) =>
      prev.col === col
        ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: col === 'name' || col === 'owner' ? 'asc' : 'desc' },
    );
  }

  async function handleCreate() {
    const trimmed = newName.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(trimmed, {
        discoverability: newDiscoverability,
        inviteUserIds: newInviteList.length > 0 ? newInviteList : undefined,
      });
      setNewName('');
      setNewDiscoverability('public');
      setNewInviteList([]);
      setNewInviteInput('');
      setShowCreate(false);
    } catch (e: any) {
      setCreateError(e?.message || 'Space creation failed');
    } finally {
      setCreating(false);
    }
  }

  function addInvite() {
    const val = newInviteInput.trim();
    if (!/^@[^:]+:.+$/.test(val)) return;
    if (newInviteList.includes(val)) return;
    setNewInviteList([...newInviteList, val]);
    setNewInviteInput('');
  }

  const sortArrow = (col: SortColumn) =>
    sort.col === col ? (sort.dir === 'asc' ? ' \u25B4' : ' \u25BE') : '';

  return (
    <>
      {/* Backdrop */}
      <div style={s.backdrop} onClick={onClose} />

      {/* Panel */}
      <div style={s.panel}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.headerTitle}>
            <span style={s.headerIcon}>{'\u2302'}</span>
            SPACES
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              style={{ ...s.newButton, ...(!matrixReady ? { opacity: 0.4, cursor: 'not-allowed' } : {}) }}
              onClick={() => matrixReady && setShowCreate(!showCreate)}
              title={matrixReady ? 'Create a new space' : 'Matrix must be connected to create spaces'}
              disabled={!matrixReady}
            >
              + New
            </button>
            <button style={s.closeButton} onClick={onClose}>{'\u2715'}</button>
          </div>
        </div>

        {/* Action error banner */}
        {actionError && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 12px',
            background: theme.dangerBg,
            borderBottom: `1px solid ${theme.dangerBorder}`,
            fontSize: 11,
            color: theme.danger,
          }}>
            <span>{actionError}</span>
            {onDismissActionError && (
              <button
                onClick={onDismissActionError}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: '0 2px', fontSize: 12 }}
              >
                {'\u2715'}
              </button>
            )}
          </div>
        )}

        {/* Column headers */}
        <div style={s.colHeaders}>
          <button style={{ ...s.colHeader, flex: 2 }} onClick={() => toggleSort('name')}>
            Name{sortArrow('name')}
          </button>
          <button style={{ ...s.colHeader, flex: 1 }} onClick={() => toggleSort('owner')}>
            Owner{sortArrow('owner')}
          </button>
          <button style={{ ...s.colHeader, flex: 1 }} onClick={() => toggleSort('created')}>
            Created{sortArrow('created')}
          </button>
          <button style={{ ...s.colHeader, flex: 1 }} onClick={() => toggleSort('modified')}>
            Modified{sortArrow('modified')}
          </button>
          <button style={{ ...s.colHeader, width: 70, flexShrink: 0, textAlign: 'right' }} onClick={() => toggleSort('members')}>
            Members{sortArrow('members')}
          </button>
          {onArchive && <div style={{ width: 36, flexShrink: 0 }} />}
          {onDelete && <div style={{ width: 36, flexShrink: 0 }} />}
        </div>

        {/* Rows */}
        <div style={s.body}>
          {loading && entries.length === 0 ? (
            <div style={s.emptyState}>
              <div style={s.spinner} />
              <div>Scanning Matrix rooms...</div>
            </div>
          ) : sorted.length === 0 ? (
            <div style={s.emptyState}>
              <div style={{ fontSize: 24, opacity: 0.3 }}>{'\u2302'}</div>
              <div>No spaces found</div>
              <div style={{ fontSize: 11, color: theme.textMuted }}>
                Create a new space to get started
              </div>
            </div>
          ) : (
            sorted.map((entry) => {
              const isActive = activeSpace === entry.spaceTarget;
              return (
                <button
                  key={entry.spaceTarget}
                  style={{
                    ...s.row,
                    ...(isActive ? s.rowActive : {}),
                  }}
                  onClick={() => onSelect(entry.spaceTarget)}
                >
                  <div style={{ ...s.cell, flex: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 14,
                      color: isActive ? theme.accent : theme.textMuted,
                      flexShrink: 0,
                    }}>
                      {'\u25A3'}
                    </span>
                    <span style={{
                      fontWeight: isActive ? 600 : 400,
                      color: isActive ? theme.text : theme.textSecondary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {entry.displayName}
                    </span>
                    {isActive && (
                      <span style={{
                        fontSize: 8,
                        color: theme.accent,
                        background: theme.accentBg,
                        padding: '1px 6px',
                        borderRadius: 8,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}>
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <div style={{ ...s.cell, flex: 1, color: theme.textMuted }}>
                    {entry.ownerDisplayName}
                  </div>
                  <div style={{ ...s.cell, flex: 1, color: theme.textMuted }}>
                    {formatDate(entry.createdAt)}
                  </div>
                  <div style={{ ...s.cell, flex: 1, color: theme.textMuted }}>
                    {relativeTime(entry.lastActivity)}
                  </div>
                  <div style={{ ...s.cell, width: 70, flexShrink: 0, textAlign: 'right', color: theme.textMuted }}>
                    {entry.memberCount}
                  </div>
                  {onArchive && (
                    <div
                      style={{
                        width: 36,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <span
                        onClick={(e) => { e.stopPropagation(); onArchive(entry.spaceTarget); }}
                        style={{
                          fontSize: 11,
                          color: theme.textMuted,
                          cursor: 'pointer',
                          padding: '4px 6px',
                          borderRadius: 4,
                          opacity: 0.4,
                          transition: 'opacity 0.15s, color 0.15s',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget).style.opacity = '1'; (e.currentTarget).style.color = theme.accent; }}
                        onMouseLeave={(e) => { (e.currentTarget).style.opacity = '0.4'; (e.currentTarget).style.color = theme.textMuted; }}
                        title="Archive space"
                      >
                        {'\u2261'}
                      </span>
                    </div>
                  )}
                  {onDelete && (
                    <div
                      style={{
                        width: 36,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <span
                        onClick={(e) => { e.stopPropagation(); onDelete(entry.spaceTarget); }}
                        style={{
                          fontSize: 11,
                          color: theme.textMuted,
                          cursor: 'pointer',
                          padding: '4px 6px',
                          borderRadius: 4,
                          opacity: 0.4,
                          transition: 'opacity 0.15s, color 0.15s',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget).style.opacity = '1'; (e.currentTarget).style.color = theme.danger; }}
                        onMouseLeave={(e) => { (e.currentTarget).style.opacity = '0.4'; (e.currentTarget).style.color = theme.textMuted; }}
                        title="Delete space"
                      >
                        {'\u2715'}
                      </span>
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Create form */}
        {showCreate && (
          <div style={s.createForm}>
            <div style={s.createLabel}>New Space</div>
            <div style={s.createRow}>
              <input
                style={s.createInput}
                placeholder="Space name..."
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newDiscoverability === 'public') handleCreate();
                  if (e.key === 'Escape') setShowCreate(false);
                }}
                autoFocus
              />
            </div>

            {/* Visibility radio */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', padding: '6px 4px' }}>
                <input
                  type="radio"
                  name="space-visibility"
                  checked={newDiscoverability === 'public'}
                  onChange={() => setNewDiscoverability('public')}
                  style={{ marginTop: 2 }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: theme.text }}>Public</span>
                  <span style={{ fontSize: 10, color: theme.textMuted }}>
                    Anyone on your homeserver can discover this space and request access.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', padding: '6px 4px' }}>
                <input
                  type="radio"
                  name="space-visibility"
                  checked={newDiscoverability === 'private'}
                  onChange={() => setNewDiscoverability('private')}
                  style={{ marginTop: 2 }}
                />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 500, color: theme.text }}>Private</span>
                  <span style={{ fontSize: 10, color: theme.textMuted }}>
                    Only the people you invite can see or join this space.
                  </span>
                </span>
              </label>
            </div>

            {/* Invite picker for private spaces */}
            {newDiscoverability === 'private' && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 10, color: theme.textMuted }}>Invite (Matrix IDs):</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    style={s.createInput}
                    placeholder="@user:server"
                    value={newInviteInput}
                    onChange={(e) => setNewInviteInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addInvite(); } }}
                  />
                  <button
                    style={{ ...s.newButton, opacity: /^@[^:]+:.+$/.test(newInviteInput.trim()) ? 1 : 0.5 }}
                    onClick={addInvite}
                    disabled={!/^@[^:]+:.+$/.test(newInviteInput.trim())}
                  >
                    Add
                  </button>
                </div>
                {newInviteList.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {newInviteList.map((uid) => (
                      <span
                        key={uid}
                        style={{
                          fontSize: 10,
                          padding: '3px 8px',
                          background: theme.bgMuted,
                          border: `1px solid ${theme.border}`,
                          borderRadius: 12,
                          color: theme.text,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        {uid}
                        <button
                          onClick={() => setNewInviteList(newInviteList.filter((u) => u !== uid))}
                          style={{
                            background: 'none', border: 'none', color: theme.textMuted,
                            cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1,
                          }}
                        >
                          {'\u00D7'}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {createError && (
              <div style={{
                marginTop: 8,
                padding: '6px 10px',
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                color: theme.danger,
                background: `${theme.danger}12`,
                border: `1px solid ${theme.danger}30`,
                borderRadius: 4,
              }}>
                {createError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
              <button style={s.cancelButton} onClick={() => { setShowCreate(false); setCreateError(null); setNewName(''); setNewInviteList([]); setNewInviteInput(''); setNewDiscoverability('public'); }}>
                Cancel
              </button>
              <button
                style={{ ...s.newButton, opacity: newName.trim() && !creating ? 1 : 0.5 }}
                onClick={handleCreate}
                disabled={!newName.trim() || creating}
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {/* Public spaces (discoverable, not yet joined) */}
        {publicEntries.length > 0 && (
          <div style={{ borderTop: `1px solid ${theme.borderDivider}`, marginTop: 8, paddingTop: 10 }}>
            <div style={{ fontSize: 10, color: theme.textMuted, padding: '4px 14px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Public Spaces
            </div>
            {publicEntries.map((entry) => (
              <div
                key={entry.mainRoomId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 14px',
                  gap: 10,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.displayName}
                  </div>
                  <div style={{ fontSize: 10, color: theme.textMuted }}>
                    {entry.memberCount} member{entry.memberCount === 1 ? '' : 's'}
                  </div>
                </div>
                {onRequestAccess && (
                  <button
                    onClick={() => onRequestAccess(entry.mainRoomId)}
                    style={{
                      padding: '4px 10px',
                      fontSize: 10,
                      background: theme.accent,
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                    }}
                  >
                    Request access
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Footer links */}
        {(onOpenRecycleBin || archivedCount > 0) && (
          <div style={s.recycleBinFooter}>
            {archivedCount > 0 && (
              <div style={{
                ...s.recycleBinButton,
                cursor: 'default',
                opacity: 0.7,
              }}>
                <span style={{ fontSize: 12, opacity: 0.5 }}>{'\u2261'}</span>
                {archivedCount} archived
                <span style={{
                  fontSize: 9,
                  color: theme.textMuted,
                  marginLeft: 'auto',
                  fontStyle: 'italic',
                }}>
                  Settings to manage
                </span>
              </div>
            )}
            {onOpenRecycleBin && (
              <button onClick={onOpenRecycleBin} style={s.recycleBinButton}>
                <span style={{ fontSize: 13, opacity: 0.5 }}>{'\u2672'}</span>
                Recycle Bin
                {deletedCount > 0 && (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 600,
                    background: theme.warningBg,
                    color: theme.warning,
                    padding: '1px 6px',
                    borderRadius: 8,
                    marginLeft: 'auto',
                  }}>
                    {deletedCount}
                  </span>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    backdrop: {
      position: 'fixed',
      inset: 0,
      zIndex: 99,
      background: 'rgba(0,0,0,0.15)',
    },
    panel: {
      position: 'fixed',
      top: 56,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 720,
      maxWidth: 'calc(100vw - 24px)',
      maxHeight: 'calc(85vh - 56px)',
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 12,
      boxShadow: `0 16px 48px ${t.shadow}, 0 4px 12px ${t.shadow}`,
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    } as React.CSSProperties,
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px 8px',
      borderBottom: `1px solid ${t.border}`,
    },
    headerTitle: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      letterSpacing: '0.5px',
    },
    headerIcon: {
      fontSize: 14,
      opacity: 0.6,
    },
    colHeaders: {
      display: 'flex',
      alignItems: 'center',
      padding: '0 16px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgMuted,
    },
    colHeader: {
      background: 'none',
      border: 'none',
      padding: '6px 8px',
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      letterSpacing: '0.3px',
      cursor: 'pointer',
      textAlign: 'left' as const,
      fontFamily: "'JetBrains Mono', monospace",
      textTransform: 'uppercase' as const,
    },
    body: {
      flex: 1,
      overflowY: 'auto' as const,
      padding: '4px 8px',
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      padding: '8px',
      background: 'transparent',
      border: 'none',
      borderRadius: 6,
      cursor: 'pointer',
      color: t.text,
      textAlign: 'left' as const,
      transition: 'background 0.1s',
      fontSize: 12,
    },
    rowActive: {
      background: t.accentBg,
    },
    cell: {
      padding: '0 8px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      fontSize: 12,
    },
    emptyState: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: '40px 20px',
      color: t.textSecondary,
      fontSize: 13,
    },
    spinner: {
      width: 20,
      height: 20,
      border: `2px solid ${t.border}`,
      borderTop: `2px solid ${t.accent}`,
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    },
    newButton: {
      background: t.accent,
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '4px 12px',
      fontSize: 11,
      fontWeight: 500,
      cursor: 'pointer',
    },
    closeButton: {
      background: 'transparent',
      border: 'none',
      color: t.textMuted,
      fontSize: 14,
      cursor: 'pointer',
      padding: '2px 6px',
      borderRadius: 4,
    },
    cancelButton: {
      background: 'transparent',
      border: `1px solid ${t.border}`,
      color: t.textSecondary,
      borderRadius: 6,
      padding: '4px 12px',
      fontSize: 11,
      fontWeight: 500,
      cursor: 'pointer',
    },
    createForm: {
      borderTop: `1px solid ${t.border}`,
      padding: '12px 16px',
      background: t.bgMuted,
    },
    createLabel: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      letterSpacing: '0.3px',
      marginBottom: 8,
    },
    createRow: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    },
    createInput: {
      flex: 1,
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: '6px 10px',
      fontSize: 13,
      color: t.text,
      outline: 'none',
      fontFamily: "'Outfit', system-ui, sans-serif",
    },
    recycleBinFooter: {
      borderTop: `1px solid ${t.border}`,
      padding: '6px 12px',
    },
    recycleBinButton: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      background: 'transparent',
      border: 'none',
      padding: '6px 4px',
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 500,
      color: t.textMuted,
      cursor: 'pointer',
      transition: 'background 0.1s',
    },
  };
}
