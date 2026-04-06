/**
 * FilenStorageWidget — displays EODB backup files for the current space.
 *
 * Scoped to the active space's Filen folder only. Authentication is handled
 * automatically by fetching shared Filen credentials from the n8n webhook.
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
  timestamp?: number;
  seq?: number;
  toSeq?: number;
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

function fmtTimestamp(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function parseEodbFilename(name: string): { type: 'current' | 'snapshot' | 'backup'; seq?: number; timestamp?: number } | null {
  if (name === 'current.eodb') return { type: 'current' };
  const sm = name.match(/^snapshot-(\d+)\.eodb$/);
  if (sm) return { type: 'snapshot', seq: parseInt(sm[1], 10) };
  const bm = name.match(/^backup-(\d+)-(\d+)\.eodb$/);
  if (bm) return { type: 'backup', seq: parseInt(bm[1], 10), timestamp: parseInt(bm[2], 10) };
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
    isOrgMode, orgEmail,
  } = useFilenStore();

  const [files, setFiles] = useState<EodbFileInfo[]>([]);
  const [subfolders, setSubfolders] = useState<{ name: string; uuid: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Resolve the current space's folder UUID
  const folderUuid = currentSpaceId ? spaceFolders[currentSpaceId] : null;
  const spaceName = folderUuid ? (spaceDisplayNames[folderUuid] || currentSpaceId) : null;
  const lastSync = currentSpaceId ? lastSyncAt[currentSpaceId] : null;

  // Load files for the current space
  const loadFiles = useCallback(async () => {
    if (!auth || !folderUuid) return;
    setLoading(true);
    try {
      const items = await filenListFolder(auth.apiKey, folderUuid, masterKeys);
      const eodbFiles: EodbFileInfo[] = [];
      const folders: { name: string; uuid: string }[] = [];
      for (const f of items) {
        if (f.type === 'folder') {
          folders.push({ name: f.name, uuid: f.uuid });
          continue;
        }
        if (f.type !== 'file' || !f.name.endsWith('.eodb')) continue;
        const parsed = parseEodbFilename(f.name);
        if (!parsed) continue;
        eodbFiles.push({
          name: f.name,
          uuid: f.uuid,
          size: f.size || 0,
          type: parsed.type,
          key: f.key,
          timestamp: f.timestamp || parsed.timestamp,
          seq: parsed.seq,
        });
      }
      // Sort: current first, then snapshots (newest first), then backups (newest first)
      const typePriority = { current: 0, snapshot: 1, backup: 2 };
      eodbFiles.sort((a, b) => {
        const pa = typePriority[a.type], pb = typePriority[b.type];
        if (pa !== pb) return pa - pb;
        return b.name.localeCompare(a.name);
      });
      setFiles(eodbFiles);
      setSubfolders(folders);
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
  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  const snapshotCount = files.filter(f => f.type === 'snapshot').length;
  const backupCount = files.filter(f => f.type === 'backup').length;

  return (
    <div style={s.browser}>
      {/* Connection info */}
      <div style={s.connInfo}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={s.connDot} />
          <span style={s.connLabel}>
            {isOrgMode ? `Org mode — ${orgEmail}` : 'Connected'}
          </span>
        </div>
        {lastSync && (
          <span style={s.syncTime}>
            Last sync: {new Date(lastSync).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Toolbar */}
      <div style={s.toolbar}>
        <span style={s.pathLabel}>{pathLabel}</span>
        <button style={s.refreshBtn} onClick={loadFiles} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Summary bar */}
      {files.length > 0 && (
        <div style={s.summaryBar}>
          <span style={s.summaryItem}>{files.length} files</span>
          <span style={s.summaryDot}>·</span>
          <span style={s.summaryItem}>{fmtSize(totalSize)} total</span>
          {snapshotCount > 0 && (
            <>
              <span style={s.summaryDot}>·</span>
              <span style={s.summaryItem}>{snapshotCount} snapshot{snapshotCount > 1 ? 's' : ''}</span>
            </>
          )}
          {backupCount > 0 && (
            <>
              <span style={s.summaryDot}>·</span>
              <span style={s.summaryItem}>{backupCount} backup{backupCount > 1 ? 's' : ''}</span>
            </>
          )}
          {subfolders.length > 0 && (
            <>
              <span style={s.summaryDot}>·</span>
              <span style={s.summaryItem}>{subfolders.length} folder{subfolders.length > 1 ? 's' : ''}</span>
            </>
          )}
        </div>
      )}

      {/* File list */}
      <div style={s.fileList}>
        {loading && <div style={s.emptyMsg}>Loading files...</div>}
        {!loading && !folderUuid && (
          <div style={s.emptyMsg}>
            No Filen folder for this space yet. Data will appear after the first sync cycle (30s).
          </div>
        )}
        {!loading && folderUuid && files.length === 0 && subfolders.length === 0 && (
          <div style={s.emptyMsg}>
            No backups yet. Data will appear here after the first sync cycle (30s).
          </div>
        )}

        {/* Subfolders */}
        {!loading && subfolders.map(folder => (
          <div key={folder.uuid} style={s.fileRow}>
            <span style={s.fileIcon}>{'\u{1F4C1}'}</span>
            <span style={s.fileName}>{folder.name}/</span>
            <span style={{ ...s.fileTag, background: `${theme.textMuted}15`, color: theme.textMuted, border: `1px solid ${theme.textMuted}30` }}>
              DIR
            </span>
          </div>
        ))}

        {/* Files */}
        {!loading && files.map(file => {
          const isExpanded = expanded === file.uuid;
          const tagColor = file.type === 'current'
            ? { bg: '#22c55e15', text: '#22c55e', border: '#22c55e30' }
            : file.type === 'snapshot'
            ? { bg: `${theme.accent}15`, text: theme.accent, border: `${theme.accent}30` }
            : { bg: '#f59e0b15', text: '#f59e0b', border: '#f59e0b30' };

          return (
            <div key={file.uuid}>
              <div
                style={{ ...s.fileRow, cursor: 'pointer', borderRadius: 4, background: isExpanded ? `${theme.accent}08` : 'transparent' }}
                onClick={() => setExpanded(isExpanded ? null : file.uuid)}
              >
                <span style={s.fileIcon}>
                  {file.type === 'current' ? '\u{1F4BE}' : file.type === 'snapshot' ? '\u{1F4F8}' : '\u{1F4E6}'}
                </span>
                <span style={s.fileName}>{file.name}</span>
                <span style={{ ...s.fileTag, background: tagColor.bg, color: tagColor.text, border: `1px solid ${tagColor.border}` }}>
                  {file.type === 'current' ? 'LIVE' : file.type === 'snapshot' ? 'SNAP' : 'BACK'}
                </span>
                <span style={s.fileSize}>{fmtSize(file.size)}</span>
                <span style={s.chevron}>{isExpanded ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isExpanded && (
                <div style={s.detailPane}>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>UUID</span>
                    <span style={s.detailValue}>{file.uuid}</span>
                  </div>
                  {file.seq !== undefined && (
                    <div style={s.detailRow}>
                      <span style={s.detailLabel}>Seq</span>
                      <span style={s.detailValue}>{file.seq}</span>
                    </div>
                  )}
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Size</span>
                    <span style={s.detailValue}>{fmtSize(file.size)} ({file.size.toLocaleString()} bytes)</span>
                  </div>
                  {file.timestamp && (
                    <div style={s.detailRow}>
                      <span style={s.detailLabel}>Created</span>
                      <span style={s.detailValue}>
                        {new Date(file.timestamp * 1000).toLocaleString()} ({fmtTimestamp(file.timestamp)})
                      </span>
                    </div>
                  )}
                  {file.key && (
                    <div style={s.detailRow}>
                      <span style={s.detailLabel}>Encrypted</span>
                      <span style={s.detailValue}>AES-256-GCM (Filen v002)</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
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
    connInfo: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 12px', background: t.bgMuted,
      borderBottom: `1px solid ${t.border}`,
    },
    connDot: {
      width: 6, height: 6, borderRadius: '50%',
      background: '#22c55e', boxShadow: '0 0 6px #22c55e',
    },
    connLabel: {
      fontFamily: mono, fontSize: 10, color: t.text, fontWeight: 600,
    },
    syncTime: {
      fontFamily: mono, fontSize: 9, color: t.textMuted,
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
    summaryBar: {
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 12px', borderBottom: `1px solid ${t.border}`,
      background: t.bg,
    },
    summaryItem: {
      fontFamily: mono, fontSize: 9, color: t.textMuted, fontWeight: 500,
    },
    summaryDot: {
      fontFamily: mono, fontSize: 9, color: t.textMuted,
    },

    fileList: { flex: 1, overflowY: 'auto' as const, padding: 4, maxHeight: 400 },
    emptyMsg: {
      textAlign: 'center' as const, padding: '16px 12px', color: t.textMuted,
      fontFamily: mono, fontSize: 11, lineHeight: 1.6,
    },

    fileRow: {
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 10px', fontFamily: mono,
    },
    fileIcon: { fontSize: 12, flexShrink: 0 },
    fileName: {
      flex: 1, fontSize: 11, color: t.textSecondary,
      whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis',
    },
    fileTag: {
      fontSize: 9, fontWeight: 700,
      padding: '1px 5px', borderRadius: 3,
      flexShrink: 0,
    },
    fileSize: { fontSize: 10, color: t.textMuted, flexShrink: 0, minWidth: 45, textAlign: 'right' as const },
    chevron: { fontSize: 8, color: t.textMuted, flexShrink: 0, width: 12, textAlign: 'center' as const },

    detailPane: {
      margin: '0 10px 4px 30px', padding: '6px 10px',
      background: t.bgMuted, borderRadius: 4, border: `1px solid ${t.border}`,
    },
    detailRow: {
      display: 'flex', justifyContent: 'space-between', padding: '2px 0',
    },
    detailLabel: {
      fontFamily: mono, fontSize: 9, color: t.textMuted, fontWeight: 600,
    },
    detailValue: {
      fontFamily: mono, fontSize: 9, color: t.text, textAlign: 'right' as const,
      maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    },
  };
}
