/**
 * FilenStorageWidget — shows Filen connection status and EODB backup files.
 *
 * Uses the shared filen-store for persistent auth. Only displays .eodb files
 * from the /EO-DB/ folder — no generic file browsing. Shows spaces, their
 * current.eodb and snapshots with sizes and dates.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../theme';
import { useTheme } from '../theme';
import { useFilenStore } from '../filen/filen-store';
import { filenListFolder, type FilenItem } from '../filen/filen-api';

// ==========================================
// Types
// ==========================================
interface SpaceInfo {
  name: string;
  folderUuid: string;
  files: EodbFileInfo[];
}

interface EodbFileInfo {
  name: string;
  uuid: string;
  size: number;
  type: 'current' | 'snapshot';
  key?: string;
}

// ==========================================
// Helpers
// ==========================================
function fmtSize(b: number): string {
  if (!b) return '';
  const k = 1024;
  const s = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}

function parseEodbFilename(name: string): { type: 'current' | 'snapshot'; seq?: number } | null {
  if (name === 'current.eodb') return { type: 'current' };
  const m = name.match(/^snapshot-(\d+)\.eodb$/);
  if (m) return { type: 'snapshot', seq: parseInt(m[1], 10) };
  return null;
}

// ==========================================
// Component
// ==========================================
export function FilenStorageWidget() {
  const { theme } = useTheme();
  const s = widgetStyles(theme);

  const {
    auth, connected, connecting, error,
    masterKeys, eodbFolderUuid, lastSyncAt,
    login, logout, restore,
  } = useFilenStore();

  // Local UI state
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twofa, setTwofa] = useState('');
  const [loginStatus, setLoginStatus] = useState<{ msg: string; type: 'error' | 'info' | 'success' } | null>(null);

  // Space listing
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [loadingSpaces, setLoadingSpaces] = useState(false);
  const [expandedSpace, setExpandedSpace] = useState<string | null>(null);

  // Restore session on mount
  useEffect(() => { restore(); }, [restore]);

  // Load spaces when connected and expanded
  const loadSpaces = useCallback(async () => {
    if (!auth || !eodbFolderUuid) return;
    setLoadingSpaces(true);
    try {
      const items = await filenListFolder(auth.apiKey, eodbFolderUuid, masterKeys);
      const spaceInfos: SpaceInfo[] = [];

      for (const item of items) {
        if (item.type !== 'folder') continue;
        // Each subfolder is a space — load its .eodb files
        const files = await filenListFolder(auth.apiKey, item.uuid, masterKeys);
        const eodbFiles: EodbFileInfo[] = [];
        for (const f of files) {
          if (f.type !== 'file' || !f.name.endsWith('.eodb')) continue;
          const parsed = parseEodbFilename(f.name);
          if (!parsed) continue;
          eodbFiles.push({
            name: f.name,
            uuid: f.uuid,
            size: f.size || 0,
            type: parsed.type,
            key: f.key,
          });
        }
        // Sort: current first, then snapshots by name descending (newest first)
        eodbFiles.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'current' ? -1 : 1;
          return b.name.localeCompare(a.name);
        });
        spaceInfos.push({ name: item.name, folderUuid: item.uuid, files: eodbFiles });
      }

      setSpaces(spaceInfos);
    } catch (e: any) {
      console.warn('[EO-DB] Failed to load spaces from Filen:', e);
    } finally {
      setLoadingSpaces(false);
    }
  }, [auth, eodbFolderUuid, masterKeys]);

  useEffect(() => {
    if (connected && expanded) loadSpaces();
  }, [connected, expanded, loadSpaces]);

  // Connect handler
  async function handleConnect() {
    if (!email || !password) {
      setLoginStatus({ msg: 'Email and password required', type: 'error' });
      return;
    }
    setLoginStatus({ msg: 'Connecting...', type: 'info' });
    try {
      await login(email, password, twofa || undefined);
      setLoginStatus({ msg: 'Connected', type: 'success' });
      setPassword('');
      setTwofa('');
    } catch (e: any) {
      setLoginStatus({ msg: e.message, type: 'error' });
    }
  }

  function handleDisconnect() {
    logout();
    setLoginStatus(null);
    setSpaces([]);
    setExpandedSpace(null);
  }

  // ---- RENDER ----

  // Collapsed: not connected
  if (!connected && !expanded) {
    return (
      <button style={s.setupBtn} onClick={() => setExpanded(true)}>
        <div style={s.setupIcon}><CloudIcon /></div>
        <div style={{ flex: 1, textAlign: 'left' as const }}>
          <div style={s.setupTitle}>Set up cloud backup</div>
          <div style={s.setupSub}>End-to-end encrypted &middot; free &middot; powered by Filen</div>
        </div>
        <span style={s.setupArrow}>&rsaquo;</span>
      </button>
    );
  }

  // Collapsed: connected
  if (connected && !expanded) {
    const totalFiles = spaces.reduce((sum, sp) => sum + sp.files.length, 0);
    return (
      <button style={s.setupBtn} onClick={() => setExpanded(true)}>
        <div style={{ ...s.setupIcon, background: theme.successBg, border: `1px solid ${theme.successBorder}` }}>
          <CloudIcon color={theme.success} />
        </div>
        <div style={{ flex: 1, textAlign: 'left' as const }}>
          <div style={s.setupTitle}>Filen Backup</div>
          <div style={s.setupSub}>
            Connected as {auth?.email}
            {totalFiles > 0 && ` \u00B7 ${totalFiles} files`}
          </div>
        </div>
        <span style={s.setupArrow}>&rsaquo;</span>
      </button>
    );
  }

  return (
    <div style={s.widget}>
      {/* Header */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={{ ...s.dot, background: connected ? theme.success : theme.textMuted }} />
          <CloudIcon size={14} color={theme.textSecondary} />
          <span style={s.headerTitle}>
            {connected ? `Filen \u00B7 ${auth?.email}` : 'Filen Backup'}
          </span>
        </div>
        <button style={s.headerBtn} onClick={() => setExpanded(false)} title="Minimize">&minus;</button>
      </div>

      {/* Login panel */}
      {!connected && (
        <div style={s.loginPanel}>
          <div style={s.explainer}>
            <strong style={{ color: theme.text }}>Filen</strong> provides encrypted cloud backup
            for your EO///DB data. Files are encrypted before they leave your device.
            Everyone in your network can share the same Filen account.
            <div style={s.tagRow}>
              <span style={s.tag}>End-to-end encrypted</span>
              <span style={s.tag}>10 GB free</span>
              <span style={s.tag}>Shared account</span>
              <span style={s.tag}>.eodb format</span>
            </div>
          </div>

          <div style={s.field}>
            <label style={s.label}>Email</label>
            <input style={s.input} type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@email.com" onKeyDown={e => e.key === 'Enter' && handleConnect()} />
          </div>
          <div style={s.field}>
            <label style={s.label}>Password</label>
            <input style={s.input} type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="Password" onKeyDown={e => e.key === 'Enter' && handleConnect()} />
          </div>
          <div style={s.field}>
            <label style={s.label}>2FA code (optional)</label>
            <input style={s.input} type="text" value={twofa} onChange={e => setTwofa(e.target.value)}
              placeholder="123456" onKeyDown={e => e.key === 'Enter' && handleConnect()} />
          </div>

          {(loginStatus || error) && (
            <div style={{
              ...s.statusMsg,
              ...(loginStatus?.type === 'error' || error ? s.statusError
                : loginStatus?.type === 'success' ? s.statusSuccess
                : s.statusInfo),
            }}>
              {loginStatus?.msg || error}
            </div>
          )}

          <button style={s.connectBtn} onClick={handleConnect} disabled={connecting}>
            <CloudIcon size={14} />
            {connecting ? 'Connecting...' : 'Connect to Filen'}
          </button>

          <div style={s.footer}>
            No account?{' '}
            <a href="https://filen.io/register" target="_blank" rel="noreferrer"
              style={{ color: theme.accent, textDecoration: 'none' }}>
              Sign up free at filen.io
            </a>
          </div>
        </div>
      )}

      {/* Connected: EODB files view */}
      {connected && (
        <div style={s.browser}>
          {/* Toolbar */}
          <div style={s.toolbar}>
            <button style={s.refreshBtn} onClick={loadSpaces} disabled={loadingSpaces}>
              {loadingSpaces ? 'Loading...' : 'Refresh'}
            </button>
            <button style={{ ...s.toolBtn, color: theme.danger, borderColor: theme.dangerBorder }}
              onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>

          {/* Path indicator */}
          <div style={s.pathBar}>
            <span style={s.pathLabel}>Filen</span>
            <span style={s.pathSep}>/</span>
            <span style={s.pathLabel}>EO-DB</span>
          </div>

          {/* Space list */}
          <div style={s.fileList}>
            {loadingSpaces && <div style={s.emptyMsg}>Loading spaces...</div>}
            {!loadingSpaces && spaces.length === 0 && (
              <div style={s.emptyMsg}>
                No backups yet. Data will appear here after the first sync cycle (30s).
              </div>
            )}
            {!loadingSpaces && spaces.map(space => (
              <div key={space.folderUuid}>
                {/* Space header */}
                <div
                  style={s.spaceRow}
                  onClick={() => setExpandedSpace(expandedSpace === space.folderUuid ? null : space.folderUuid)}
                  onMouseEnter={e => (e.currentTarget.style.background = theme.bgHover)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={s.spaceIcon}>{expandedSpace === space.folderUuid ? '\u25BE' : '\u25B8'}</span>
                  <span style={s.spaceName}>{space.name}</span>
                  <span style={s.spaceCount}>
                    {space.files.filter(f => f.type === 'snapshot').length} snapshots
                  </span>
                  {lastSyncAt[space.folderUuid] && (
                    <span style={s.syncTime}>
                      {new Date(lastSyncAt[space.folderUuid]).toLocaleTimeString()}
                    </span>
                  )}
                </div>

                {/* Expanded: show .eodb files */}
                {expandedSpace === space.folderUuid && (
                  <div style={s.spaceFiles}>
                    {space.files.length === 0 && (
                      <div style={s.emptyMsg}>No .eodb files yet</div>
                    )}
                    {space.files.map(file => (
                      <div key={file.uuid} style={s.fileRow}>
                        <span style={s.fileIcon}>
                          {file.type === 'current' ? '\u{1F4BE}' : '\u{1F4F8}'}
                        </span>
                        <span style={s.fileName}>{file.name}</span>
                        <span style={s.fileTag}>
                          {file.type === 'current' ? 'LIVE' : 'SNAP'}
                        </span>
                        <span style={s.fileSize}>{fmtSize(file.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CloudIcon({ size = 18, color = '#fff' }: { size?: number; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <path fill={color} d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
    </svg>
  );
}

function widgetStyles(t: Theme): Record<string, React.CSSProperties> {
  const mono = "'JetBrains Mono', monospace";
  return {
    setupBtn: {
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', background: t.bgCard, color: t.text,
      border: `1px solid ${t.border}`, borderRadius: 8,
      cursor: 'pointer', fontSize: 13, fontWeight: 500, width: '100%',
      fontFamily: mono, transition: 'all 0.15s',
    },
    setupIcon: {
      width: 32, height: 32, background: t.bgMuted, borderRadius: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, padding: 5, border: `1px solid ${t.border}`,
    },
    setupTitle: { fontWeight: 600, marginBottom: 2, fontSize: 12 },
    setupSub: { fontSize: 10, color: t.textMuted },
    setupArrow: { color: t.textMuted, fontSize: 18 },

    widget: {
      background: t.bgCard, border: `1px solid ${t.border}`, borderRadius: 8,
      overflow: 'hidden', display: 'flex', flexDirection: 'column' as const,
      maxHeight: 520,
    },
    header: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 14px', background: t.bg, borderBottom: `1px solid ${t.border}`,
    },
    headerLeft: {
      display: 'flex', alignItems: 'center', gap: 8,
      fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.text,
    },
    dot: { width: 6, height: 6, borderRadius: '50%' },
    headerTitle: { fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.text },
    headerBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.textMuted,
      padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: mono, fontSize: 12,
    },

    loginPanel: { padding: '16px 14px', display: 'flex', flexDirection: 'column' as const, gap: 12 },
    explainer: {
      padding: '12px 14px', background: t.accentBg,
      border: `1px solid ${t.accentBorder}`, borderRadius: 6,
      fontFamily: mono, fontSize: 11, lineHeight: 1.6, color: t.textSecondary,
    },
    tagRow: { marginTop: 8, display: 'flex', flexWrap: 'wrap' as const, gap: 5 },
    tag: {
      background: t.accentBg, color: t.accent,
      padding: '2px 7px', borderRadius: 3, fontSize: 10, fontWeight: 500,
      fontFamily: mono, border: `1px solid ${t.accentBorder}`,
    },
    field: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
    label: {
      fontFamily: mono, fontSize: 9, fontWeight: 600, color: t.textMuted,
      textTransform: 'uppercase' as const, letterSpacing: '0.5px',
    },
    input: {
      padding: '8px 10px', background: t.bg, border: `1px solid ${t.border}`,
      borderRadius: 4, color: t.text, fontFamily: mono, fontSize: 12, outline: 'none',
    },
    statusMsg: { padding: '8px 10px', borderRadius: 4, fontFamily: mono, fontSize: 11 },
    statusError: { background: t.dangerBg, color: t.dangerText, border: `1px solid ${t.dangerBorder}` },
    statusInfo: { background: t.accentBg, color: t.accent, border: `1px solid ${t.accentBorder}` },
    statusSuccess: { background: t.successBg, color: t.successText, border: `1px solid ${t.successBorder}` },
    connectBtn: {
      padding: '10px', background: t.accent, color: '#fff', border: 'none',
      borderRadius: 6, fontFamily: mono, fontSize: 12, fontWeight: 600,
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    },
    footer: { textAlign: 'center' as const, fontFamily: mono, fontSize: 10, color: t.textMuted },

    browser: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
    toolbar: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 14px', borderBottom: `1px solid ${t.border}`,
      justifyContent: 'flex-end',
    },
    refreshBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.textSecondary,
      padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
      fontFamily: mono, fontSize: 10, fontWeight: 600,
    },
    toolBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.text,
      padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
      fontFamily: mono, fontSize: 10, fontWeight: 600,
    },

    pathBar: {
      display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px',
      fontFamily: mono, fontSize: 11, color: t.textMuted,
      borderBottom: `1px solid ${t.borderLight}`,
    },
    pathLabel: { color: t.textSecondary, fontWeight: 600 },
    pathSep: { color: t.textMuted },

    fileList: { flex: 1, overflowY: 'auto' as const, padding: 4 },
    emptyMsg: {
      textAlign: 'center' as const, padding: '24px 16px', color: t.textMuted,
      fontFamily: mono, fontSize: 11, lineHeight: 1.6,
    },

    spaceRow: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 12px', borderRadius: 4, cursor: 'pointer',
      transition: 'background 0.1s',
    },
    spaceIcon: { fontSize: 10, color: t.textMuted, flexShrink: 0, width: 12 },
    spaceName: {
      flex: 1, fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.text,
      whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    },
    spaceCount: { fontFamily: mono, fontSize: 10, color: t.textMuted, flexShrink: 0 },
    syncTime: { fontFamily: mono, fontSize: 9, color: t.textMuted, flexShrink: 0 },

    spaceFiles: {
      paddingLeft: 20, paddingBottom: 4,
    },
    fileRow: {
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', fontFamily: mono,
    },
    fileIcon: { fontSize: 12, flexShrink: 0 },
    fileName: {
      flex: 1, fontSize: 11, color: t.textSecondary,
      whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    },
    fileTag: {
      fontSize: 9, fontWeight: 700, color: t.accent,
      padding: '1px 5px', borderRadius: 3,
      background: t.accentBg, border: `1px solid ${t.accentBorder}`,
      flexShrink: 0,
    },
    fileSize: { fontSize: 10, color: t.textMuted, flexShrink: 0, minWidth: 45, textAlign: 'right' as const },
  };
}
