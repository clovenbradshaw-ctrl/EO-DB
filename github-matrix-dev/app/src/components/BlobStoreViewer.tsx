/**
 * BlobStoreViewer — browses the room-scoped encrypted blobs stored at the
 * n8n `/webhook/eo-blob` endpoint.
 *
 * The webhook exposes three operations (store | get | versions). There is no
 * `list` op, so this viewer speculatively tries `list` first and — regardless
 * of that outcome — always allows the user to probe individual local IDs,
 * enumerating up to 5 most-recent versions per blob.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTheme, type Theme } from '../theme';

interface BlobStoreViewerProps {
  onBack: () => void;
  endpoint: string;
  roomId: string | null;
  roomPrefix: string | null;
  matrixToken: string | null;
}

interface BlobMeta {
  version: number;
  writer?: string;
  auth_user_id?: string;
  room_id?: string;
  target?: string | null;
  label?: string | null;
  content_hash?: string;
  plaintext_size?: number | null;
  key_id?: string | null;
  created_at?: string;
}

interface VersionListing {
  version: number;
  uri?: string;
  meta: BlobMeta;
}

interface BlobEntry {
  dataId: string;
  localId: string;
  versions: VersionListing[];
  latest: number | null;
  error: string | null;
  loading: boolean;
}

const DEFAULT_PROBES = ['_healthcheck'];

export function BlobStoreViewer({ onBack, endpoint, roomId, roomPrefix, matrixToken }: BlobStoreViewerProps) {
  const { theme } = useTheme();
  const s = styles(theme);

  const [entries, setEntries] = useState<Record<string, BlobEntry>>({});
  const [listAttempted, setListAttempted] = useState(false);
  const [listSupported, setListSupported] = useState<boolean | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [probeInput, setProbeInput] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);

  const ready = !!(roomId && roomPrefix && matrixToken);

  const buildDataId = useCallback(
    (localId: string) => (roomPrefix ? `${roomPrefix}:${localId}` : localId),
    [roomPrefix],
  );

  const probe = useCallback(
    async (localId: string): Promise<void> => {
      if (!ready) return;
      const dataId = buildDataId(localId);
      setEntries((prev) => ({
        ...prev,
        [dataId]: {
          dataId,
          localId,
          versions: prev[dataId]?.versions ?? [],
          latest: prev[dataId]?.latest ?? null,
          error: null,
          loading: true,
        },
      }));
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matrix_token: matrixToken,
            op: 'versions',
            room_id: roomId,
            data_id: dataId,
          }),
        });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        if (!res.ok) {
          const detail = parsed?.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
          setEntries((prev) => ({
            ...prev,
            [dataId]: { ...prev[dataId]!, loading: false, error: `HTTP ${res.status}: ${detail}` },
          }));
          return;
        }
        const versions: VersionListing[] = Array.isArray(parsed?.versions) ? parsed.versions : [];
        const latest: number | null = typeof parsed?.latest === 'number' ? parsed.latest : null;
        setEntries((prev) => ({
          ...prev,
          [dataId]: { dataId, localId, versions, latest, error: null, loading: false },
        }));
      } catch (e: any) {
        setEntries((prev) => ({
          ...prev,
          [dataId]: { ...prev[dataId]!, loading: false, error: `Network: ${e?.message ?? 'unknown'}` },
        }));
      }
    },
    [ready, buildDataId, endpoint, matrixToken, roomId],
  );

  // Attempt a speculative `list` request once. If the webhook supports it,
  // populate entries from the response. If it rejects, fall back to probes.
  useEffect(() => {
    if (!ready || listAttempted) return;
    setListAttempted(true);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matrix_token: matrixToken,
            op: 'list',
            room_id: roomId,
          }),
        });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        if (cancelled) return;
        if (res.ok && Array.isArray(parsed?.blobs ?? parsed?.entries ?? parsed?.data_ids)) {
          const rows: any[] = parsed.blobs ?? parsed.entries ?? parsed.data_ids;
          setListSupported(true);
          const next: Record<string, BlobEntry> = {};
          for (const row of rows) {
            const dataId = typeof row === 'string' ? row : (row.data_id ?? row.dataId);
            if (!dataId) continue;
            const localId = roomPrefix && dataId.startsWith(`${roomPrefix}:`)
              ? dataId.slice(roomPrefix.length + 1)
              : dataId;
            next[dataId] = {
              dataId,
              localId,
              versions: Array.isArray(row.versions) ? row.versions : [],
              latest: typeof row.latest === 'number' ? row.latest : null,
              error: null,
              loading: false,
            };
          }
          setEntries((prev) => ({ ...next, ...prev }));
        } else {
          setListSupported(false);
          if (!res.ok) {
            const detail = parsed?.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
            setListError(`list not supported (HTTP ${res.status}: ${detail})`);
          } else {
            setListError('list returned unexpected shape — falling back to probes');
          }
        }
      } catch (e: any) {
        if (cancelled) return;
        setListSupported(false);
        setListError(`list probe failed: ${e?.message ?? 'unknown'}`);
      } finally {
        if (!cancelled) {
          // Always probe default IDs so users see something on first load.
          for (const lid of DEFAULT_PROBES) await probe(lid);
          if (!cancelled) setInitialLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [ready, listAttempted, endpoint, matrixToken, roomId, roomPrefix, probe]);

  const handleSubmitProbe = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const id = probeInput.trim();
      if (!id) return;
      setProbeInput('');
      void probe(id);
    },
    [probeInput, probe],
  );

  const handleRefreshAll = useCallback(() => {
    for (const entry of Object.values(entries)) {
      void probe(entry.localId);
    }
  }, [entries, probe]);

  const entryList = Object.values(entries).sort((a, b) => a.dataId.localeCompare(b.dataId));
  const totalVersions = entryList.reduce((n, e) => n + e.versions.length, 0);

  return (
    <div style={s.container}>
      <div style={s.inner}>
        <button onClick={onBack} style={s.backBtn}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 3L4.5 7L8.5 11" />
          </svg>
          Settings
        </button>

        <div style={s.title}>Blob Store</div>
        <div style={s.subtitle}>Room-scoped encrypted blobs via /webhook/eo-blob</div>

        {!ready && (
          <div style={s.errorBox}>
            {!roomId ? 'No room connected — open a space first.'
              : !matrixToken ? 'No Matrix token available.'
              : 'Computing room prefix…'}
          </div>
        )}

        {ready && (
          <>
            {/* Connection summary */}
            <div style={s.connBox}>
              <Field label="Endpoint" value={endpoint} theme={theme} />
              <Field label="Room ID" value={roomId!} theme={theme} />
              <Field label="Room Prefix" value={roomPrefix!} theme={theme} />
              <Field
                label="List op"
                value={
                  listSupported === true ? 'Supported'
                  : listSupported === false ? 'Unsupported — probe by local ID'
                  : 'Probing…'
                }
                theme={theme}
              />
              {listError && listSupported === false && (
                <div style={s.listNote}>{listError}</div>
              )}
            </div>

            {/* Probe form */}
            <form onSubmit={handleSubmitProbe} style={s.probeRow}>
              <span style={s.prefixChip}>{roomPrefix}:</span>
              <input
                style={s.probeInput}
                value={probeInput}
                onChange={(e) => setProbeInput(e.target.value)}
                placeholder="local-id (e.g. manifest, my-field)"
                aria-label="Blob local ID to probe"
              />
              <button type="submit" style={s.probeBtn} disabled={!probeInput.trim()}>
                Probe
              </button>
              <button type="button" style={s.refreshBtn} onClick={handleRefreshAll} disabled={entryList.length === 0}>
                Refresh All
              </button>
            </form>

            {/* Summary bar */}
            <div style={s.summaryBar}>
              <span style={s.summaryItem}>{entryList.length} data_id{entryList.length === 1 ? '' : 's'}</span>
              <span style={s.summaryDot}>·</span>
              <span style={s.summaryItem}>{totalVersions} version{totalVersions === 1 ? '' : 's'} total</span>
              {initialLoading && <span style={{ ...s.summaryItem, fontStyle: 'italic' as const }}>  loading…</span>}
            </div>

            {/* Entry list */}
            <div style={s.list}>
              {entryList.length === 0 && !initialLoading && (
                <div style={s.emptyNote}>
                  No blobs discovered. Enter a local ID above and click Probe to check for versions.
                </div>
              )}

              {entryList.map((entry) => {
                const isExpanded = expanded === entry.dataId;
                const hasVersions = entry.versions.length > 0;
                const hasError = !!entry.error;
                const statusColor = hasError ? theme.danger : hasVersions ? theme.success : theme.textMuted;

                return (
                  <div key={entry.dataId} style={s.entryCard}>
                    <div
                      style={{ ...s.entryHeader, cursor: hasVersions ? 'pointer' : 'default' }}
                      onClick={() => hasVersions && setExpanded(isExpanded ? null : entry.dataId)}
                    >
                      <span style={{ ...s.entryDot, background: statusColor, boxShadow: hasVersions ? `0 0 6px ${statusColor}` : 'none' }} />
                      <span style={s.entryId}>{entry.dataId}</span>
                      <span style={s.entryCount}>
                        {entry.loading ? 'loading…'
                          : hasError ? 'error'
                          : `${entry.versions.length} version${entry.versions.length === 1 ? '' : 's'}`}
                      </span>
                      {hasVersions && (
                        <span style={s.chevron}>{isExpanded ? '▴' : '▾'}</span>
                      )}
                    </div>
                    {hasError && (
                      <div style={s.entryError}>{entry.error}</div>
                    )}
                    {isExpanded && hasVersions && (
                      <div style={s.versionsPane}>
                        {entry.versions
                          .slice()
                          .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
                          .map((v) => {
                            const m = v.meta ?? ({} as BlobMeta);
                            const isLatest = entry.latest != null && v.version === entry.latest;
                            return (
                              <div key={`${entry.dataId}:${v.version}`} style={s.versionRow}>
                                <div style={s.versionHead}>
                                  <span style={s.versionNum}>v{v.version}</span>
                                  {isLatest && <span style={s.latestTag}>LATEST</span>}
                                  {m.created_at && (
                                    <span style={s.versionTime}>{new Date(m.created_at).toLocaleString()}</span>
                                  )}
                                </div>
                                <div style={s.versionDetails}>
                                  {m.writer && <DetailRow label="Writer" value={m.writer} theme={theme} />}
                                  {m.auth_user_id && <DetailRow label="Author" value={m.auth_user_id} theme={theme} />}
                                  {m.target && <DetailRow label="Target" value={m.target} theme={theme} />}
                                  {m.label && <DetailRow label="Label" value={m.label} theme={theme} />}
                                  {m.content_hash && <DetailRow label="Content Hash" value={m.content_hash} theme={theme} />}
                                  {m.key_id && <DetailRow label="Key ID" value={m.key_id} theme={theme} />}
                                  {m.plaintext_size != null && (
                                    <DetailRow label="Plaintext Size" value={`${m.plaintext_size} bytes`} theme={theme} />
                                  )}
                                  {v.uri && <DetailRow label="URI" value={v.uri} theme={theme} />}
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', gap: 12 }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted, flexShrink: 0 }}>
        {label}
      </span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: theme.text,
        textAlign: 'right' as const,
        wordBreak: 'break-all' as const,
      }}>
        {value}
      </span>
    </div>
  );
}

function DetailRow({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, padding: '2px 0', alignItems: 'baseline' }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>{label}</span>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: theme.text,
        wordBreak: 'break-all' as const,
      }}>{value}</span>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  const mono = "'JetBrains Mono', monospace";
  return {
    container: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '12px 24px 40px',
    },
    inner: {
      width: '100%',
      maxWidth: 840,
    },
    backBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      fontFamily: mono,
      fontSize: 12,
      color: t.accent,
      padding: '8px 0',
    },
    title: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 22,
      fontWeight: 600,
      color: t.textHeading,
      marginTop: 4,
    },
    subtitle: {
      fontFamily: mono,
      fontSize: 11,
      color: t.textMuted,
      marginBottom: 16,
    },
    errorBox: {
      padding: '10px 12px',
      background: t.dangerBg,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 4,
      fontFamily: mono,
      fontSize: 10,
      color: t.dangerText,
    },
    connBox: {
      padding: '10px 12px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      marginBottom: 12,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 2,
    },
    listNote: {
      marginTop: 6,
      fontFamily: mono,
      fontSize: 9,
      color: t.warning,
    },
    probeRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 8,
      flexWrap: 'wrap' as const,
    },
    prefixChip: {
      padding: '6px 8px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      fontFamily: mono,
      fontSize: 11,
      color: t.textMuted,
      whiteSpace: 'nowrap' as const,
    },
    probeInput: {
      flex: 1,
      minWidth: 200,
      padding: '7px 10px',
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: mono,
      fontSize: 11,
      outline: 'none',
    },
    probeBtn: {
      padding: '6px 14px',
      background: t.accent,
      color: '#fff',
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      fontFamily: mono,
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
    refreshBtn: {
      padding: '6px 14px',
      background: 'transparent',
      color: t.accent,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      fontFamily: mono,
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
    summaryBar: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '6px 0',
      marginBottom: 6,
    },
    summaryItem: {
      fontFamily: mono,
      fontSize: 10,
      color: t.textMuted,
    },
    summaryDot: {
      fontFamily: mono,
      fontSize: 10,
      color: t.textMuted,
    },
    list: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    emptyNote: {
      padding: '16px 12px',
      fontFamily: mono,
      fontSize: 11,
      color: t.textMuted,
      fontStyle: 'italic' as const,
      textAlign: 'center' as const,
    },
    entryCard: {
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      overflow: 'hidden',
      background: t.bg,
    },
    entryHeader: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 12px',
    },
    entryDot: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      flexShrink: 0,
    },
    entryId: {
      flex: 1,
      fontFamily: mono,
      fontSize: 11,
      color: t.text,
      wordBreak: 'break-all' as const,
    },
    entryCount: {
      fontFamily: mono,
      fontSize: 10,
      color: t.textMuted,
      flexShrink: 0,
    },
    chevron: {
      fontSize: 10,
      color: t.textMuted,
      width: 12,
      textAlign: 'center' as const,
      flexShrink: 0,
    },
    entryError: {
      padding: '6px 12px',
      fontFamily: mono,
      fontSize: 10,
      color: t.danger,
      background: t.dangerBg,
      borderTop: `1px solid ${t.dangerBorder}`,
    },
    versionsPane: {
      borderTop: `1px solid ${t.border}`,
      padding: '6px 12px',
      background: t.bgMuted,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    versionRow: {
      padding: '6px 8px',
      border: `1px solid ${t.borderLight}`,
      borderRadius: 4,
      background: t.bg,
    },
    versionHead: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    versionNum: {
      fontFamily: mono,
      fontSize: 11,
      fontWeight: 700,
      color: t.text,
    },
    latestTag: {
      fontFamily: mono,
      fontSize: 8,
      fontWeight: 700,
      letterSpacing: '0.06em',
      padding: '1px 5px',
      borderRadius: 3,
      background: `${t.success}20`,
      color: t.success,
      border: `1px solid ${t.success}40`,
    },
    versionTime: {
      fontFamily: mono,
      fontSize: 9,
      color: t.textMuted,
      marginLeft: 'auto',
    },
    versionDetails: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 1,
    },
  };
}
