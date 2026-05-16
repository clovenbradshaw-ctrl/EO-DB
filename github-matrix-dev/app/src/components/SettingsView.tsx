import { useState, useEffect, useCallback, useMemo } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { MatrixSession } from '../matrix/client';
import { RoomDataViewer } from './RoomDataViewer';
import { MatrixRoomsViewer } from './MatrixRoomsViewer';
import { UserRoomsBySpaces } from './UserRoomsBySpaces';
import { BlobStoreViewer } from './BlobStoreViewer';
import { OP_COLORS, TRIAD_LABELS } from './LogView';
import { ArchivedSpacesSection } from './ArchivedSpaces';
import { AirtableSettingsSection } from './AirtableSettings';
import { GCalendarSettingsSection } from './GCalendarSettings';
import { SeedSpaceSection } from './SeedSpaceSection';
import { BlockListSection } from './BlockListSection';
import { isAminoHomeserver } from '../lib/matrix-domain';
import { EO_STORE_WEBHOOK, pingDriveProxy } from '../storage/eodb-blob-endpoint';
import type { BlobWriterStatus } from '../storage/eodb-blob-writer';
import { buildSettingChangeEvent } from '../lib/settings-events';
import { SettingsActivity } from './SettingsActivity';

function classifyNetworkError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    if (e.name === 'TimeoutError') return 'Timed out';
    if (e.name === 'AbortError') return 'Aborted';
    if (e.name === 'TypeError') return `Network/CORS error: ${e.message ?? 'Failed to fetch'}`;
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
  }
  return String(err);
}

function formatRelativeTime(epochMs: number | null | undefined): string {
  if (!epochMs) return 'never';
  const deltaSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.round(deltaSec / 60)}m ago`;
  return `${Math.round(deltaSec / 3600)}h ago`;
}

interface SettingsViewProps {
  session: MatrixSession;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
  /** Full room topology for the current space (main, governance, restricted) */
  spaceRooms?: { main: string; restricted?: string; governance?: string } | null;
  onUnarchive?: (target: string) => void;
  /** Current connection status for the header badge */
  connectionState?: 'online' | 'offline' | 'syncing' | 'local' | 'error';
  /** Structured error from Matrix init */
  connectionError?: { phase: string; message: string } | null;
  /** Whether the Matrix SDK initial sync completed */
  matrixReady?: boolean;
  /** Retry callback (re-init Matrix) */
  onRetry?: () => void;
  /** Logout callback (for auth errors) */
  onLogout?: () => void;
}

export function SettingsView({ session, matrixClient, roomId, spaceRooms, onUnarchive, connectionState, connectionError, matrixReady, onRetry, onLogout }: SettingsViewProps) {
  const { theme } = useTheme();
  // Calendar / Airtable are tied to shared n8n proxy credentials on the
  // hosted Amino deployment. Only surface those sections for users logged
  // into app.aminoimmigration.com.
  const isAmino = isAminoHomeserver(session.homeserver);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const recentEvents = useEoStore((s) => s.recentEvents);
  const store = useEoStore((s) => s.store);
  const syncManager = useEoStore((s) => s.syncManager);
  const manualSnapshot = useEoStore((s) => s.manualSnapshot);
  const dispatch = useEoStore((s) => s.dispatch);

  const recordSettingChange = useCallback(
    (setting: string, label: string, oldValue: unknown, newValue: unknown) => {
      if (oldValue === newValue) return;
      const event = buildSettingChangeEvent({
        setting,
        label,
        oldValue,
        newValue,
        agent: session.userId,
      });
      dispatch(event).catch((err) => {
        console.warn('[SettingsView] failed to record setting change', err);
      });
    },
    [dispatch, session.userId],
  );
  const [showRoomData, setShowRoomData] = useState(false);
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [showRoomsBySpaces, setShowRoomsBySpaces] = useState(false);
  const [showBlobStore, setShowBlobStore] = useState(false);
  const s = styles(theme);

  const [eventCount, setEventCount] = useState<number | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [showEraseConfirm, setShowEraseConfirm] = useState(false);

  const [blobTestStatus, setBlobTestStatus] = useState<string | null>(null);
  const [blobTestLoading, setBlobTestLoading] = useState(false);

  const handleTestBlob = useCallback(async () => {
    setBlobTestLoading(true);
    setBlobTestStatus(null);
    try {
      const token = session.accessToken;
      if (!token) { setBlobTestStatus('✗ No Matrix token'); return; }
      if (!roomId) { setBlobTestStatus('✗ No room connected'); return; }

      // Preflight probe: surface CORS / proxy problems before the POST would
      // hang at preflight. OPTIONS should succeed regardless of n8n workflow
      // state because n8n core handles it when allowedOrigins is set.
      try {
        const pre = await fetch(EO_STORE_WEBHOOK, {
          method: 'OPTIONS',
          headers: {
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'content-type',
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (!pre.ok && pre.status !== 204) {
          setBlobTestStatus(`✗ Preflight failed — OPTIONS returned ${pre.status}. Check reverse proxy / CORS on n8n.`);
          return;
        }
      } catch (preErr: unknown) {
        const reason = classifyNetworkError(preErr);
        setBlobTestStatus(`✗ Preflight unreachable — ${reason}. DNS, TLS, or blocklist?`);
        return;
      }

      const ping = await pingDriveProxy(token, roomId);
      if (ping.ok) {
        setBlobTestStatus('✓ Reachable — Drive proxy authenticated');
      } else if (ping.status === 401) {
        setBlobTestStatus('✗ Unauthorized — Matrix token invalid');
      } else if (ping.status === 403) {
        setBlobTestStatus('✗ Forbidden — not a member of this space');
      } else if (ping.status === 0) {
        setBlobTestStatus(`✗ ${ping.detail ?? 'Network error'}`);
      } else {
        setBlobTestStatus(`✗ HTTP ${ping.status}: ${ping.detail ?? ''}`);
      }
    } catch (e: unknown) {
      setBlobTestStatus(`✗ ${classifyNetworkError(e)}`);
    } finally {
      setBlobTestLoading(false);
    }
  }, [session.accessToken, roomId]);

  const eodbBlobWriter = useEoStore((s) => s.eodbBlobWriter);
  const [blobWriterStatus, setBlobWriterStatus] = useState<BlobWriterStatus | null>(null);
  useEffect(() => {
    if (!eodbBlobWriter) { setBlobWriterStatus(null); return; }
    return eodbBlobWriter.subscribe(setBlobWriterStatus);
  }, [eodbBlobWriter]);

  useEffect(() => {
    setEventCount(recentEvents.length);
  }, [recentEvents]);

  async function handleSnapshot() {
    setSnapshotStatus('Taking snapshot...');
    try {
      const result = await manualSnapshot();
      setSnapshotStatus(`Snapshot saved — seq ${result.seq}`);
    } catch (e: any) {
      setSnapshotStatus(`Error: ${e.message}`);
    }
  }

  function handleDeleteAll() {
    if (deleteConfirm.toUpperCase() !== 'DELETE') {
      setDeleteError('Type DELETE to confirm');
      return;
    }
    setDeleteError('');
    setShowEraseConfirm(true);
  }

  async function handleEraseConfirmed() {
    try {
      const { teardown } = useEoStore.getState();
      teardown();
      setDeleteError('');
      setDeleteConfirm('');
      setShowEraseConfirm(false);
      window.location.reload();
    } catch (e: any) {
      setDeleteError(e.message);
    }
  }


  const displayName = session.userId.startsWith('@')
    ? session.userId.slice(1).split(':')[0]
    : session.userId;
  const homeserver = session.userId.includes(':')
    ? session.userId.split(':')[1]
    : 'unknown';

  if (showRoomsBySpaces && matrixClient) {
    return <UserRoomsBySpaces client={matrixClient} onBack={() => setShowRoomsBySpaces(false)} />;
  }

  if (showAllRooms && matrixClient) {
    return <MatrixRoomsViewer client={matrixClient} onBack={() => setShowAllRooms(false)} />;
  }

  if (showRoomData) {
    return <RoomDataViewer onBack={() => setShowRoomData(false)} matrixClient={matrixClient} roomId={roomId} />;
  }

  if (showBlobStore) {
    return (
      <BlobStoreViewer
        onBack={() => setShowBlobStore(false)}
        endpoint={EO_STORE_WEBHOOK}
        roomId={roomId ?? null}
        matrixToken={session.accessToken ?? null}
      />
    );
  }

  return (
    <div style={s.container}>
      <div style={s.form}>
        {/* Current Session */}
        <Section title="Current Session" theme={theme}>
          <Field label="User" value={displayName} theme={theme} />
          <Field label="User ID" value={session.userId} theme={theme} />
          <Field label="Homeserver" value={homeserver} theme={theme} />
          <Field label="Device ID" value={session.deviceId} theme={theme} />
        </Section>

        {/* Local Storage */}
        <Section title="Local Storage (OPFS)" theme={theme}>
          <Field label="Events" value={String(eventCount ?? '—')} theme={theme} />
          <Field label="Current Seq" value={String(lastSeq)} theme={theme} />
          <Field label="Architecture" value="OPFS + in-memory (browser-native)" theme={theme} />
        </Section>

        {/* Connection & Sync Status */}
        <Section title="Connection & Sync Status" theme={theme}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
            {/* Matrix SDK */}
            <StatusRow
              theme={theme}
              label="Matrix SDK"
              status={
                connectionError?.phase === 'auth' ? 'error'
                : connectionError?.phase === 'sync' ? 'error'
                : matrixReady ? 'ok'
                : connectionState === 'syncing' ? 'pending'
                : connectionState === 'local' ? 'off'
                : 'off'
              }
              detail={
                connectionError?.phase === 'auth' ? connectionError.message
                : connectionError?.phase === 'sync' ? connectionError.message
                : matrixReady ? `Connected to ${session.homeserver.replace(/^https?:\/\//, '')}`
                : connectionState === 'syncing' ? 'Performing initial sync...'
                : connectionState === 'local' ? 'Disabled (local mode)'
                : 'Not connected'
              }
            />
            {/* Main Room */}
            <StatusRow
              theme={theme}
              label="Main Room"
              status={
                connectionError?.phase === 'room' ? 'error'
                : roomId ? 'ok'
                : matrixReady ? 'pending'
                : 'off'
              }
              detail={
                connectionError?.phase === 'room' ? connectionError.message
                : roomId ? `${roomId}`
                : matrixReady ? 'Resolving room...'
                : 'Waiting for Matrix'
              }
            />
            {/* Governance Room */}
            <StatusRow
              theme={theme}
              label="Governance Room"
              status={spaceRooms?.governance ? 'ok' : roomId ? 'off' : 'off'}
              detail={
                spaceRooms?.governance ? `${spaceRooms.governance}`
                : roomId ? 'Not created'
                : '—'
              }
            />
            {/* Restricted Room */}
            <StatusRow
              theme={theme}
              label="Restricted Room"
              status={spaceRooms?.restricted ? 'ok' : roomId ? 'off' : 'off'}
              detail={
                spaceRooms?.restricted ? `${spaceRooms.restricted}`
                : roomId ? 'Not created (created on first restricted field)'
                : '—'
              }
            />
            {/* Peer Sync (PeerSync + WebRTC) */}
            <StatusRow
              theme={theme}
              label="Peer Sync"
              status={syncManager ? 'ok' : matrixReady && roomId ? 'pending' : 'off'}
              detail={
                syncManager ? 'Peer sync active (Matrix to-device + WebRTC)'
                : matrixReady && roomId ? 'Initializing...'
                : 'Not started'
              }
            />
            {/* Encrypted Drive Store — amino-hosted n8n webhook */}
            {isAmino && (
              <StatusRow
                theme={theme}
                label="Drive"
                status={roomId && session.accessToken ? 'ok' : 'off'}
                detail={!roomId ? 'Waiting for room' : EO_STORE_WEBHOOK}
              />
            )}

            {/* Error banner with action */}
            {connectionError && (
              <div style={{
                marginTop: 4,
                padding: '8px 12px',
                background: `${theme.danger}15`,
                border: `1px solid ${theme.danger}40`,
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column' as const,
                gap: 8,
              }}>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.danger }}>
                  {connectionError.message}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  {connectionError.phase === 'auth' && onLogout && (
                    <button style={{ ...s.actionBtn, background: theme.danger, borderColor: theme.danger, color: '#fff' }} onClick={onLogout}>
                      Re-login
                    </button>
                  )}
                  {onRetry && (
                    <button style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, borderColor: theme.accent }} onClick={onRetry}>
                      Retry Connection
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </Section>

        {/* Matrix Device Sync */}
        <Section title="Matrix Device Sync" theme={theme}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
            <StatusRow
              theme={theme}
              label="Peer Sync"
              status={syncManager ? 'ok' : 'off'}
              detail={
                syncManager
                  ? 'Active — field edits are broadcast to all devices via Matrix'
                  : 'Inactive — connect to a Matrix space to enable real-time sync'
              }
            />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: theme.textMuted }}>
              Field edits are signaled to all devices in this space via Matrix to-device messages. No separate server required.
            </span>
          </div>
        </Section>

        {/* Settings Activity — audit timeline of toggles in this panel */}
        <Section title="Settings Activity" theme={theme}>
          <SettingsActivity events={recentEvents} theme={theme} />
        </Section>

        {/* Snapshots & Tools */}
        <Section title="Snapshots & Tools" theme={theme}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
            <button style={s.actionBtn} onClick={handleSnapshot}>
              Take Snapshot
            </button>
            <button
              style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}` }}
              onClick={() => setShowRoomData(true)}
            >
              View Room Data
            </button>
            <button
              style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}` }}
              onClick={() => setShowRoomsBySpaces(true)}
              disabled={!matrixClient}
            >
              Rooms by Space
            </button>
            <button
              style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}` }}
              onClick={() => setShowAllRooms(true)}
              disabled={!matrixClient}
            >
              All Rooms
            </button>
            {snapshotStatus && (
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: snapshotStatus.startsWith('Error') ? theme.danger : theme.success }}>
                {snapshotStatus}
              </span>
            )}
          </div>
        </Section>

        {/* Archived Spaces */}
        {onUnarchive && (
          <Section title="Archived Spaces" theme={theme}>
            <ArchivedSpacesSection onUnarchive={onUnarchive} />
          </Section>
        )}

        {/* Encrypted Drive Store — amino deployment only */}
        {isAmino && (
          <Section title="Encrypted Drive Store" theme={theme}>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
              <Field label="Endpoint" value={EO_STORE_WEBHOOK} theme={theme} />
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: theme.textMuted }}>
                Encrypted data is stored as Google Drive files via the
                <code>/webhook/eo-store</code> proxy. Each room maps to a single file
                <code>{'{dataId}'}.json</code> whose body is the AES-GCM envelope; writes
                find-or-create the file and PATCH the media. Auto-save runs whenever the
                local log advances (10s debounce + 5min heartbeat); devices raise hands via
                the Matrix snapshot-claim state event so only one writes at a time. Click
                Test Connection to round-trip the proxy with a no-op Drive list query and
                verify Matrix auth + Drive credentials are live.
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <button
                  style={s.actionBtn}
                  onClick={handleTestBlob}
                  disabled={blobTestLoading || !roomId || !session.accessToken}
                  title={!roomId ? 'Connect to a space first' : 'Probe the proxy with OPTIONS + a Drive list query'}
                >
                  {blobTestLoading ? 'Testing…' : 'Test Connection'}
                </button>
                <button
                  style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}` }}
                  onClick={() => setShowBlobStore(true)}
                  disabled={!roomId || !session.accessToken}
                  title={!roomId ? 'Connect to a space first' : 'Fetch files by data_id from the Drive proxy'}
                >
                  Open Drive Store
                </button>
                <button
                  style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}` }}
                  onClick={() => { eodbBlobWriter?.flushNow().catch(() => {}); }}
                  disabled={!eodbBlobWriter}
                  title={!eodbBlobWriter ? 'Auto-save not initialized yet' : 'Force an immediate save attempt'}
                >
                  Flush Now
                </button>
                {blobTestStatus && (
                  <span style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: blobTestStatus.startsWith('✓') ? theme.success : theme.danger,
                  }}>
                    {blobTestStatus}
                  </span>
                )}
              </div>
              <div style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: theme.textMuted,
                display: 'flex',
                flexDirection: 'column' as const,
                gap: 2,
              }}>
                <span>
                  Auto-save:{' '}
                  {blobWriterStatus
                    ? (blobWriterStatus.enabled
                        ? (blobWriterStatus.inFlight
                            ? 'writing…'
                            : (blobWriterStatus.backoffUntil && blobWriterStatus.backoffUntil > Date.now()
                                ? `backing off ${Math.ceil((blobWriterStatus.backoffUntil - Date.now())/1000)}s`
                                : 'idle'))
                        : 'stopped')
                    : 'not started (connect to a space)'}
                  {blobWriterStatus && (
                    <> · pending {blobWriterStatus.pendingCount} · last save {formatRelativeTime(blobWriterStatus.lastSaveAt)}
                    {blobWriterStatus.lastSavedSeq !== null && <> (seq {blobWriterStatus.lastSavedSeq})</>}</>
                  )}
                </span>
                {blobWriterStatus?.lastError && (
                  <span style={{ color: theme.danger }}>✗ {blobWriterStatus.lastError}</span>
                )}
                {blobWriterStatus?.lastDiagnostic && !blobWriterStatus.lastError && (
                  <span style={{ color: theme.textMuted }}>{blobWriterStatus.lastDiagnostic}</span>
                )}
              </div>
            </div>
          </Section>
        )}

        {/* Google Calendar — amino deployment only */}
        {isAmino && (
          <Section title="Google Calendar" theme={theme}>
            <GCalendarSettingsSection />
          </Section>
        )}

        {/* Seed this space — upload a .eodb to bootstrap this room. */}
        <Section title="Seed this Space" theme={theme}>
          <SeedSpaceSection
            matrixClient={matrixClient}
            roomId={roomId}
            collectionId={roomId}
          />
        </Section>

        {/* Uploaded blocks — list + per-block enable/disable. */}
        <Section title="Uploaded Blocks" theme={theme}>
          <BlockListSection
            matrixClient={matrixClient}
            roomId={roomId}
          />
        </Section>

        {/* Airtable Importer — amino deployment only */}
        {isAmino && (
          <Section title="Airtable Importer" theme={theme}>
            <AirtableSettingsSection
              session={session}
              matrixClient={matrixClient}
              roomId={roomId}
            />
          </Section>
        )}

        {/* EO Operator Reference */}
        <Section title="EO Operator Reference" theme={theme}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
            {TRIAD_LABELS.map((triad) => (
              <div key={triad.label}>
                <div style={{
                  fontSize: 9, fontWeight: 700, color: theme.textMuted,
                  letterSpacing: '0.06em', textTransform: 'uppercase' as const,
                  marginBottom: 8, fontFamily: "'JetBrains Mono', monospace",
                }}>
                  {triad.label}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                  {triad.ops.map((op) => {
                    const c = OP_COLORS[op];
                    return (
                      <div key={op} style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 10px', borderRadius: 4,
                        background: c.bg, border: `1px solid ${c.border}30`,
                      }}>
                        <span style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 10, fontWeight: 700, color: c.text,
                        }}>
                          {op}
                        </span>
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%',
                          background: c.fill, flexShrink: 0,
                        }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Danger Zone */}
        <Section title="Danger Zone" theme={theme} danger>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
            <div style={{ fontSize: 11, color: theme.textSecondary }}>
              Permanently erase all events, state, and graph data from this browser's IndexedDB. Matrix room data is not affected.
            </div>
            {showEraseConfirm ? (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '8px 0' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: theme.danger }}>
                  This will permanently erase ALL local data. Are you sure?
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    style={{ ...s.actionBtn, background: theme.danger, borderColor: theme.danger, color: '#fff' }}
                    onClick={handleEraseConfirmed}
                  >
                    Yes, erase everything
                  </button>
                  <button
                    style={{ ...s.actionBtn, background: 'transparent', color: theme.textSecondary, borderColor: theme.border }}
                    onClick={() => { setShowEraseConfirm(false); setDeleteConfirm(''); }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <input
                  style={s.input}
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder='Type "DELETE" to confirm'
                  aria-label="Type DELETE to confirm database erasure"
                />
                <button
                  style={{ ...s.actionBtn, background: theme.danger, borderColor: theme.danger, color: '#fff' }}
                  onClick={handleDeleteAll}
                >
                  Erase Database
                </button>
              </>
            )}
            {deleteError && <div style={{ color: theme.danger, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }} role="alert">{deleteError}</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children, theme, danger }: { title: string; children: React.ReactNode; theme: Theme; danger?: boolean }) {
  return (
    <div style={{
      padding: '16px 0',
      borderBottom: `1px solid ${theme.border}`,
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.08em',
        color: danger ? theme.danger : theme.textMuted,
        marginBottom: 12,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.text }}>{value}</span>
    </div>
  );
}

function ToggleRow({ theme, label, detail, checked, onChange }: {
  theme: Theme;
  label: string;
  detail: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const trackBg = checked ? theme.accent : theme.bgMuted;
  const knobColor = checked ? '#fff' : theme.textMuted;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          width: 30,
          height: 16,
          borderRadius: 999,
          background: trackBg,
          border: `1px solid ${checked ? theme.accent : theme.border}`,
          position: 'relative' as const,
          cursor: 'pointer',
          flexShrink: 0,
          marginTop: 3,
          padding: 0,
          transition: 'background 0.15s, border-color 0.15s',
        }}
      >
        <span
          style={{
            position: 'absolute' as const,
            top: 1,
            left: checked ? 15 : 1,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: knobColor,
            transition: 'left 0.15s',
          }}
        />
      </button>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600, color: theme.text }}>
          {label}
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted, wordBreak: 'break-word' as const }}>
          {detail}
        </span>
      </div>
    </div>
  );
}

function StatusRow({ theme, label, status, detail }: {
  theme: Theme;
  label: string;
  status: 'ok' | 'error' | 'pending' | 'off';
  detail: string;
}) {
  const colors = {
    ok: '#22c55e',
    error: theme.danger,
    pending: theme.warning,
    off: theme.textMuted,
  };
  const color = colors[status];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <div style={{
        width: 6, height: 6, borderRadius: '50%',
        background: color,
        boxShadow: status === 'ok' ? `0 0 6px ${color}` : status === 'error' ? `0 0 6px ${color}` : 'none',
        marginTop: 4,
        flexShrink: 0,
      }} />
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600, color: theme.text }}>
          {label}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: status === 'error' ? theme.danger : theme.textMuted,
          wordBreak: 'break-word' as const,
        }}>
          {detail}
        </span>
      </div>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '8px 16px 40px',
    },
    form: {
      width: '100%',
      maxWidth: 560,
    },
    input: {
      width: '100%',
      padding: '8px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      outline: 'none',
    },
    actionBtn: {
      padding: '6px 14px',
      background: t.accent,
      color: '#fff',
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
  };
}
