/**
 * GDriveStorageWidget — displays encrypted .eodb backup files on Google Drive.
 *
 * Files are accessed via the n8n eo-store webhook, which proxies to Google Drive.
 * Mirrors the layout of FilenStorageWidget.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Theme } from '../theme';
import { useTheme } from '../theme';
import { useGDriveStore } from '../google-drive/gdrive-store';
import { gdriveList, type GDriveListEntry } from '../google-drive/gdrive-api';

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

function fmtTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
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

// ==========================================
// Component
// ==========================================

export function GDriveStorageWidget() {
  const { theme } = useTheme();
  const s = widgetStyles(theme);

  const {
    connected, matrixAccessToken, currentSpaceId,
    spaceDisplayNames, lastSyncAt,
  } = useGDriveStore();

  const [entries, setEntries] = useState<GDriveListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const spaceName = currentSpaceId ? (spaceDisplayNames[currentSpaceId] || currentSpaceId) : null;
  const lastSync = currentSpaceId ? lastSyncAt[currentSpaceId] : null;
  const dataType = currentSpaceId ? `eodb-${currentSpaceId}` : null;

  const loadFiles = useCallback(async () => {
    if (!matrixAccessToken || !dataType) return;
    setLoading(true);
    try {
      const result = await gdriveList(matrixAccessToken, dataType);
      setEntries(result.entries || []);
    } catch (e: any) {
      console.warn('[EO-DB] Failed to load files from Google Drive:', e);
    } finally {
      setLoading(false);
    }
  }, [matrixAccessToken, dataType]);

  useEffect(() => {
    if (connected && dataType) loadFiles();
  }, [connected, dataType, loadFiles]);

  if (!connected) return null;

  const pathLabel = spaceName ? `Google Drive / EO-DB / ${spaceName}` : 'Google Drive / EO-DB';

  return (
    <div style={s.browser}>
      {/* Connection info */}
      <div style={s.connInfo}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={s.connDot} />
          <span style={s.connLabel}>Connected via n8n</span>
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
      {entries.length > 0 && (
        <div style={s.summaryBar}>
          <span style={s.summaryItem}>{entries.length} files</span>
          <span style={s.summaryDot}>{'\u00B7'}</span>
          <span style={s.summaryItem}>{entries.length} backups</span>
        </div>
      )}

      {/* File list */}
      <div style={s.fileList}>
        {loading && <div style={s.emptyMsg}>Loading files...</div>}
        {!loading && entries.length === 0 && (
          <div style={s.emptyMsg}>
            No backups yet. Data will appear here after the first sync cycle (30s).
          </div>
        )}

        {!loading && entries.map(entry => {
          const isExpanded = expanded === entry.data_id;
          const tagColor = { bg: '#4285f415', text: '#4285f4', border: '#4285f430' };

          return (
            <div key={entry.data_id}>
              <div
                style={{ ...s.fileRow, cursor: 'pointer', borderRadius: 4, background: isExpanded ? '#4285f408' : 'transparent' }}
                onClick={() => setExpanded(isExpanded ? null : entry.data_id)}
              >
                <span style={s.fileIcon}>{'\u{1F4E6}'}</span>
                <span style={s.fileName}>{entry.content_hash.slice(0, 12)}...eodb</span>
                <span style={{ ...s.fileTag, background: tagColor.bg, color: tagColor.text, border: `1px solid ${tagColor.border}` }}>
                  BACK
                </span>
                <span style={s.fileTime}>{fmtTime(entry.stored_at)}</span>
                <span style={s.chevron}>{isExpanded ? '\u25B4' : '\u25BE'}</span>
              </div>
              {isExpanded && (
                <div style={s.detailPane}>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Drive File ID</span>
                    <span style={s.detailValue}>{entry.data_id}</span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Content Hash</span>
                    <span style={s.detailValue}>{entry.content_hash}</span>
                  </div>
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Data Type</span>
                    <span style={s.detailValue}>{entry.data_type}</span>
                  </div>
                  {entry.stored_at && (
                    <div style={s.detailRow}>
                      <span style={s.detailLabel}>Stored At</span>
                      <span style={s.detailValue}>
                        {new Date(entry.stored_at).toLocaleString()} ({fmtTime(entry.stored_at)})
                      </span>
                    </div>
                  )}
                  <div style={s.detailRow}>
                    <span style={s.detailLabel}>Encrypted</span>
                    <span style={s.detailValue}>AES-256-GCM (room keyring)</span>
                  </div>
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
      background: '#4285f4', boxShadow: '0 0 6px #4285f4',
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
    fileTime: { fontSize: 10, color: t.textMuted, flexShrink: 0, minWidth: 45, textAlign: 'right' as const },
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
