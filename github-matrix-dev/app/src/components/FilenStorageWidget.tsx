/**
 * FilenStorageWidget — displays EODB backup files from the shared Filen account.
 *
 * This is a display-only component. Authentication is handled by the space admin
 * via FilenAdminConfig (stored in Matrix room state). This widget simply shows
 * the .eodb files in the /EO-DB/ folder when connected.
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
  type: 'current' | 'snapshot' | 'backup';
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

function parseEodbFilename(name: string): { type: 'current' | 'snapshot' | 'backup'; seq?: number } | null {
  if (name === 'current.eodb') return { type: 'current' };
  const sm = name.match(/^snapshot-(\d+)\.eodb$/);
  if (sm) return { type: 'snapshot', seq: parseInt(sm[1], 10) };
  const bm = name.match(/^backup-(\d+)-\d+\.eodb$/);
  if (bm) return { type: 'backup', seq: parseInt(bm[1], 10) };
  return null;
}

// ==========================================
// Component
// ==========================================
export function FilenStorageWidget() {
  const { theme } = useTheme();
  const s = widgetStyles(theme);

  const {
    auth, connected,
    masterKeys, eodbFolderUuid, lastSyncAt,
    spaceDisplayNames,
  } = useFilenStore();

  // Space listing
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [loadingSpaces, setLoadingSpaces] = useState(false);
  const [expandedSpace, setExpandedSpace] = useState<string | null>(null);

  // Load spaces when connected
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
        // Sort: current first, then backups (newest first), then snapshots
        const typePriority = { current: 0, backup: 1, snapshot: 2 };
        eodbFiles.sort((a, b) => {
          const pa = typePriority[a.type], pb = typePriority[b.type];
          if (pa !== pb) return pa - pb;
          return b.name.localeCompare(a.name);
        });
        // Use display name from store if available, else raw folder name
        const displayName = spaceDisplayNames[item.uuid] || item.name;
        spaceInfos.push({ name: displayName, folderUuid: item.uuid, files: eodbFiles });
      }

      setSpaces(spaceInfos);
    } catch (e: any) {
      console.warn('[EO-DB] Failed to load spaces from Filen:', e);
    } finally {
      setLoadingSpaces(false);
    }
  }, [auth, eodbFolderUuid, masterKeys, spaceDisplayNames]);

  useEffect(() => {
    if (connected) loadSpaces();
  }, [connected, loadSpaces]);

  // Not connected — nothing to show (admin configures via FilenAdminConfig above)
  if (!connected) return null;

  return (
    <div style={s.browser}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <span style={s.pathLabel}>Filen / EO-DB</span>
        <button style={s.refreshBtn} onClick={loadSpaces} disabled={loadingSpaces}>
          {loadingSpaces ? 'Loading...' : 'Refresh'}
        </button>
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
                {space.files.length} {space.files.length === 1 ? 'file' : 'files'}
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
                      {file.type === 'current' ? '\u{1F4BE}' : file.type === 'backup' ? '\u{1F4E6}' : '\u{1F4F8}'}
                    </span>
                    <span style={s.fileName}>{file.name}</span>
                    <span style={s.fileTag}>
                      {file.type === 'current' ? 'LIVE' : file.type === 'backup' ? 'BACK' : 'SNAP'}
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
  );
}


function widgetStyles(t: Theme): Record<string, React.CSSProperties> {
  const mono = "'JetBrains Mono', monospace";
  return {
    browser: {
      display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0,
      marginTop: 8, border: `1px solid ${t.border}`, borderRadius: 6, overflow: 'hidden',
    },
    toolbar: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', background: t.bg, borderBottom: `1px solid ${t.border}`,
      justifyContent: 'space-between',
    },
    refreshBtn: {
      background: 'transparent', border: `1px solid ${t.border}`, color: t.textSecondary,
      padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
      fontFamily: mono, fontSize: 10, fontWeight: 600,
    },
    pathLabel: {
      fontFamily: mono, fontSize: 11, color: t.textSecondary, fontWeight: 600,
    },

    fileList: { flex: 1, overflowY: 'auto' as const, padding: 4, maxHeight: 300 },
    emptyMsg: {
      textAlign: 'center' as const, padding: '16px 12px', color: t.textMuted,
      fontFamily: mono, fontSize: 11, lineHeight: 1.6,
    },

    spaceRow: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px', borderRadius: 4, cursor: 'pointer',
      transition: 'background 0.1s',
    },
    spaceIcon: { fontSize: 10, color: t.textMuted, flexShrink: 0, width: 12 },
    spaceName: {
      flex: 1, fontFamily: mono, fontSize: 12, fontWeight: 600, color: t.text,
      whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    },
    spaceCount: { fontFamily: mono, fontSize: 10, color: t.textMuted, flexShrink: 0 },
    syncTime: { fontFamily: mono, fontSize: 9, color: t.textMuted, flexShrink: 0 },

    spaceFiles: { paddingLeft: 20, paddingBottom: 4 },
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
