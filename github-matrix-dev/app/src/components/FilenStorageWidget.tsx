/**
 * FilenStorageWidget — displays EODB backup files for the current space.
 *
 * Scoped to the active space's Filen folder only. Authentication is handled
 * by the space admin via FilenAdminConfig (stored in Matrix room state).
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../theme';
import { useTheme } from '../theme';
import { useFilenStore } from '../filen/filen-store';
import { filenListFolder, type FilenItem } from '../filen/filen-api';

// ==========================================
// Types
// ==========================================
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
    auth, connected, masterKeys,
    currentSpaceId, spaceFolders, spaceDisplayNames, lastSyncAt,
  } = useFilenStore();

  const [files, setFiles] = useState<EodbFileInfo[]>([]);
  const [loading, setLoading] = useState(false);

  // Resolve the current space's folder UUID
  const folderUuid = currentSpaceId ? spaceFolders[currentSpaceId] : null;
  const spaceName = folderUuid ? (spaceDisplayNames[folderUuid] || currentSpaceId) : null;

  // Load files for the current space
  const loadFiles = useCallback(async () => {
    if (!auth || !folderUuid) return;
    setLoading(true);
    try {
      const items = await filenListFolder(auth.apiKey, folderUuid, masterKeys);
      const eodbFiles: EodbFileInfo[] = [];
      for (const f of items) {
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
      setFiles(eodbFiles);
    } catch (e: any) {
      console.warn('[EO-DB] Failed to load files from Filen:', e);
    } finally {
      setLoading(false);
    }
  }, [auth, folderUuid, masterKeys]);

  useEffect(() => {
    if (connected && folderUuid) loadFiles();
  }, [connected, folderUuid, loadFiles]);

  if (!connected) return null;

  const pathLabel = spaceName ? `Filen / EO-DB / ${spaceName}` : 'Filen / EO-DB';

  return (
    <div style={s.browser}>
      {/* Toolbar */}
      <div style={s.toolbar}>
        <span style={s.pathLabel}>{pathLabel}</span>
        <button style={s.refreshBtn} onClick={loadFiles} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* File list */}
      <div style={s.fileList}>
        {loading && <div style={s.emptyMsg}>Loading files...</div>}
        {!loading && !folderUuid && (
          <div style={s.emptyMsg}>
            No Filen folder for this space yet. Data will appear after the first sync cycle (30s).
          </div>
        )}
        {!loading && folderUuid && files.length === 0 && (
          <div style={s.emptyMsg}>
            No backups yet. Data will appear here after the first sync cycle (30s).
          </div>
        )}
        {!loading && files.map(file => (
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
