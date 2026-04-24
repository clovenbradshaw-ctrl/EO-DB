/**
 * BlobStoreViewer — fetches individual encrypted blobs by `data_id` from the
 * n8n `/webhook/eo-blob` endpoint. The workflow exposes two operations
 * (`store` | `get`) with one file per `data_id` and no versioning. Users
 * enter a `data_id` and the viewer fetches the current blob or reports 404.
 */

import { useState, useCallback } from 'react';
import { useTheme, type Theme } from '../theme';

interface BlobStoreViewerProps {
  onBack: () => void;
  endpoint: string;
  roomId: string | null;
  matrixToken: string | null;
}

interface BlobResult {
  dataId: string;
  status: 'found' | 'not-found' | 'error';
  uri?: string;
  envelopeSize?: number;
  error?: string;
  fetchedAt: number;
}

export function BlobStoreViewer({ onBack, endpoint, roomId, matrixToken }: BlobStoreViewerProps) {
  const { theme } = useTheme();
  const s = styles(theme);

  const [results, setResults] = useState<Record<string, BlobResult>>({});
  const [probeInput, setProbeInput] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const ready = !!(roomId && matrixToken);

  const fetchBlob = useCallback(
    async (dataId: string): Promise<void> => {
      if (!ready) return;
      setLoading(dataId);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matrix_token: matrixToken,
            op: 'get',
            room_id: roomId,
            data_id: dataId,
          }),
        });
        const text = await res.text();
        let parsed: any = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        if (res.ok) {
          const envelope = parsed?.envelope;
          const envelopeSize = envelope ? JSON.stringify(envelope).length : undefined;
          setResults((prev) => ({
            ...prev,
            [dataId]: {
              dataId,
              status: 'found',
              uri: typeof parsed?.uri === 'string' ? parsed.uri : undefined,
              envelopeSize,
              fetchedAt: Date.now(),
            },
          }));
        } else if (res.status === 404) {
          setResults((prev) => ({
            ...prev,
            [dataId]: { dataId, status: 'not-found', fetchedAt: Date.now() },
          }));
        } else {
          const detail = parsed?.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
          setResults((prev) => ({
            ...prev,
            [dataId]: {
              dataId,
              status: 'error',
              error: `HTTP ${res.status}: ${detail}`,
              fetchedAt: Date.now(),
            },
          }));
        }
      } catch (e: any) {
        setResults((prev) => ({
          ...prev,
          [dataId]: {
            dataId,
            status: 'error',
            error: `Network: ${e?.message ?? 'unknown'}`,
            fetchedAt: Date.now(),
          },
        }));
      } finally {
        setLoading(null);
      }
    },
    [ready, endpoint, matrixToken, roomId],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const id = probeInput.trim();
      if (!id) return;
      setProbeInput('');
      void fetchBlob(id);
    },
    [probeInput, fetchBlob],
  );

  const resultList = Object.values(results).sort((a, b) => b.fetchedAt - a.fetchedAt);

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
        <div style={s.subtitle}>Fetch encrypted blobs by data_id via /webhook/eo-blob</div>

        {!ready && (
          <div style={s.errorBox}>
            {!roomId ? 'No room connected — open a space first.' : 'No Matrix token available.'}
          </div>
        )}

        {ready && (
          <>
            <div style={s.connBox}>
              <Field label="Endpoint" value={endpoint} theme={theme} />
              <Field label="Room ID" value={roomId!} theme={theme} />
            </div>

            <form onSubmit={handleSubmit} style={s.probeRow}>
              <input
                style={s.probeInput}
                value={probeInput}
                onChange={(e) => setProbeInput(e.target.value)}
                placeholder="data_id (e.g. manifest, my-field)"
                aria-label="Blob data_id to fetch"
              />
              <button type="submit" style={s.probeBtn} disabled={!probeInput.trim() || loading !== null}>
                {loading ? 'Fetching…' : 'Fetch'}
              </button>
            </form>

            {resultList.length === 0 && (
              <div style={s.emptyNote}>
                Enter a data_id above and click Fetch to retrieve a blob.
              </div>
            )}

            <div style={s.list}>
              {resultList.map((r) => {
                const statusColor =
                  r.status === 'found' ? theme.success
                  : r.status === 'not-found' ? theme.textMuted
                  : theme.danger;
                return (
                  <div key={`${r.dataId}:${r.fetchedAt}`} style={s.entryCard}>
                    <div style={s.entryHeader}>
                      <span style={{ ...s.entryDot, background: statusColor, boxShadow: r.status === 'found' ? `0 0 6px ${statusColor}` : 'none' }} />
                      <span style={s.entryId}>{r.dataId}</span>
                      <span style={s.entryCount}>
                        {r.status === 'found' ? 'found'
                          : r.status === 'not-found' ? '404 not found'
                          : 'error'}
                      </span>
                    </div>
                    {r.status === 'found' && (
                      <div style={s.detailsPane}>
                        {r.uri && <DetailRow label="URI" value={r.uri} theme={theme} />}
                        {r.envelopeSize != null && (
                          <DetailRow label="Envelope Size" value={`${r.envelopeSize} bytes`} theme={theme} />
                        )}
                        <DetailRow label="Fetched" value={new Date(r.fetchedAt).toLocaleString()} theme={theme} />
                      </div>
                    )}
                    {r.status === 'error' && r.error && (
                      <div style={s.entryError}>{r.error}</div>
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
    probeRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 12,
      flexWrap: 'wrap' as const,
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
    entryError: {
      padding: '6px 12px',
      fontFamily: mono,
      fontSize: 10,
      color: t.danger,
      background: t.dangerBg,
      borderTop: `1px solid ${t.dangerBorder}`,
    },
    detailsPane: {
      borderTop: `1px solid ${t.border}`,
      padding: '8px 12px',
      background: t.bgMuted,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 1,
    },
  };
}
