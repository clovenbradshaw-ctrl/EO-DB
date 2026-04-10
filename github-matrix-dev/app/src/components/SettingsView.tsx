import { useState, useEffect, useCallback } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { MatrixSession } from '../matrix/client';
import { RoomDataViewer } from './RoomDataViewer';
import { MatrixRoomsViewer } from './MatrixRoomsViewer';
import { UserRoomsBySpaces } from './UserRoomsBySpaces';
import { GDriveStorageWidget } from './GDriveStorageWidget';
import { OP_COLORS, TRIAD_LABELS } from './LogView';
import { ArchivedSpacesSection } from './ArchivedSpaces';
import { AirtableSettingsSection } from './AirtableSettings';
import { useGDriveStore } from '../google-drive/gdrive-store';
import { useEoServerStore } from '../store/eo-server-store';
import { clearTokens, startOAuthFlow, getAccessToken } from '../google-drive/gdrive-oauth';

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
  const lastSeq = useEoStore((s) => s.lastSeq);
  const recentEvents = useEoStore((s) => s.recentEvents);
  const store = useEoStore((s) => s.store);
  const syncManager = useEoStore((s) => s.syncManager);
  const gdriveSync = useEoStore((s) => s.gdriveSync);
  const gdriveConnected = useGDriveStore((s) => s.connected);
  const gdriveCurrentSpaceId = useGDriveStore((s) => s.currentSpaceId);
  const gdriveSpaceFileGuids = useGDriveStore((s) => s.spaceFileGuids);
  const currentFileGuids = gdriveCurrentSpaceId ? (gdriveSpaceFileGuids[gdriveCurrentSpaceId] ?? null) : null;
  const manualSnapshot = useEoStore((s) => s.manualSnapshot);
  const [showRoomData, setShowRoomData] = useState(false);
  const [showAllRooms, setShowAllRooms] = useState(false);
  const [showRoomsBySpaces, setShowRoomsBySpaces] = useState(false);
  const s = styles(theme);

  const [eventCount, setEventCount] = useState<number | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [showEraseConfirm, setShowEraseConfirm] = useState(false);

  const serverUrl = useEoServerStore((s) => s.serverUrl);
  const serverConnected = useEoServerStore((s) => s.connected);
  const setServerUrl = useEoServerStore((s) => s.setServerUrl);
  const [serverUrlInput, setServerUrlInput] = useState(serverUrl || '');
  const gdriveToken = useGDriveStore((s) => s.googleAccessToken);
  const gdriveOffline = useGDriveStore((s) => s.gdriveOffline);
  const gdriveSyncMode = useGDriveStore((s) => s.syncMode);
  const setGdriveSyncMode = useGDriveStore((s) => s.setSyncMode);
  const [gdriveTestStatus, setGdriveTestStatus] = useState<string | null>(null);
  const [gdriveTestLoading, setGdriveTestLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);

  function handleSaveServerUrl() {
    const trimmed = serverUrlInput.trim();
    setServerUrl(trimmed || null);
    // Connection will be established on next space load (Layout.tsx effect)
    // Reload to pick up new URL immediately
    if (trimmed !== (serverUrl || '')) {
      window.location.reload();
    }
  }

  const matrixAccessToken = useGDriveStore((s) => s.matrixAccessToken);

  const handleTestGDrive = useCallback(async () => {
    setGdriveTestLoading(true);
    setGdriveTestStatus(null);
    try {
      if (gdriveSyncMode === 'oauth') {
        const token = gdriveToken;
        if (!token) { setGdriveTestStatus('✗ Not connected (no OAuth token)'); return; }
        const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          const email = data?.user?.emailAddress ?? 'unknown';
          setGdriveTestStatus(`✓ Connected as ${email}`);
        } else {
          const text = await res.text().catch(() => String(res.status));
          setGdriveTestStatus(`✗ Failed: ${text.slice(0, 120)}`);
        }
      } else {
        // n8n mode — ping the proxy endpoint with the Matrix token
        const token = matrixAccessToken;
        if (!token) { setGdriveTestStatus('✗ Not connected (no Matrix token)'); return; }
        const res = await fetch('https://n8n.intelechia.com/webhook/eo-store', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matrix_token: token,
            drive_url: 'https://www.googleapis.com/drive/v3/about?fields=user',
            drive_method: 'GET',
          }),
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const email = data?.user?.emailAddress ?? 'proxy';
          setGdriveTestStatus(`✓ n8n proxy connected (${email})`);
        } else {
          setGdriveTestStatus(`✗ n8n proxy error: ${res.status}`);
        }
      }
    } catch (e: any) {
      setGdriveTestStatus(`✗ Failed: ${e.message}`);
    } finally {
      setGdriveTestLoading(false);
    }
  }, [gdriveToken, matrixAccessToken, gdriveSyncMode]);



  const handleSignInWithGoogle = useCallback(async () => {
    setOauthLoading(true);
    try {
      await startOAuthFlow();
      const token = await getAccessToken();
      useGDriveStore.setState({ googleAccessToken: token, connected: true });
    } catch {
      // flow was cancelled or failed — leave user to retry
    } finally {
      setOauthLoading(false);
    }
  }, []);

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
            {/* Google Drive */}
            <StatusRow
              theme={theme}
              label="Google Drive"
              status={gdriveSync ? 'ok' : gdriveConnected ? 'pending' : 'off'}
              detail={gdriveSync ? 'Backup sync active' : gdriveConnected ? 'Initializing...' : 'Not connected'}
            />

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

        {/* Real-Time Sync Server */}
        <Section title="Real-Time Sync Server" theme={theme}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
            <StatusRow
              theme={theme}
              label="EO-DB Server"
              status={serverUrl ? (serverConnected ? 'ok' : 'pending') : 'off'}
              detail={
                serverUrl
                  ? serverConnected
                    ? `Connected — ${serverUrl}`
                    : `Connecting to ${serverUrl}…`
                  : 'Not configured — field changes are local only'
              }
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                style={{ ...s.input, flex: 1 }}
                type="text"
                placeholder="http://localhost:3000"
                value={serverUrlInput}
                onChange={(e) => setServerUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveServerUrl(); }}
              />
              <button style={s.actionBtn} onClick={handleSaveServerUrl}>
                Save
              </button>
              {serverUrl && (
                <button
                  style={{ ...s.actionBtn, background: 'transparent', color: theme.danger, borderColor: theme.danger }}
                  onClick={() => { setServerUrlInput(''); setServerUrl(null); }}
                >
                  Clear
                </button>
              )}
            </div>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: theme.textMuted }}>
              When set, field edits are broadcast to all users connected to the same server in real-time. Uses your Matrix session token for auth.
            </span>
          </div>
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

        {/* Google Drive Cloud Storage */}
        <Section title="Google Drive Storage" theme={theme}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
            {/* Drive Sync Mode selector */}
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: theme.textMuted }}>
                Drive Sync Mode
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['n8n', 'oauth'] as const).map((mode) => (
                  <button
                    key={mode}
                    style={{
                      ...s.actionBtn,
                      background: gdriveSyncMode === mode ? theme.accent : 'transparent',
                      color: gdriveSyncMode === mode ? '#fff' : theme.textMuted,
                      borderColor: gdriveSyncMode === mode ? theme.accent : theme.border,
                    }}
                    onClick={() => {
                      if (mode === 'oauth') clearTokens();
                      setGdriveSyncMode(mode);
                    }}
                  >
                    {mode === 'n8n' ? 'n8n Proxy' : 'Google OAuth'}
                  </button>
                ))}
              </div>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: theme.textMuted }}>
                {gdriveSyncMode === 'n8n'
                  ? 'Drive requests are proxied through n8n using its own Google credentials — no Google account needed.'
                  : 'Each user authenticates with their own Google account via OAuth2 (PKCE). Requires VITE_GOOGLE_CLIENT_ID.'}
              </span>
            </div>
            {gdriveSyncMode === 'oauth' && !gdriveToken && (
              <button
                onClick={handleSignInWithGoogle}
                disabled={oauthLoading}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 14px',
                  background: '#fff',
                  color: '#3c4043',
                  border: '1px solid #dadce0',
                  borderRadius: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: oauthLoading ? 'not-allowed' : 'pointer',
                  opacity: oauthLoading ? 0.6 : 1,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                  letterSpacing: '0.01em',
                  alignSelf: 'flex-start',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                {oauthLoading ? 'Signing in…' : 'Sign in with Google'}
              </button>
            )}
            {gdriveOffline && (
              <div style={{
                padding: '6px 10px',
                background: `${theme.warning || '#f59e0b'}15`,
                border: `1px solid ${theme.warning || '#f59e0b'}40`,
                borderRadius: 4,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                color: theme.warning || '#f59e0b',
              }}>
                GDrive offline — working locally
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                style={{ ...s.actionBtn }}
                onClick={handleTestGDrive}
                disabled={gdriveTestLoading}
              >
                {gdriveTestLoading ? 'Testing…' : 'Test Connection'}
              </button>
              {gdriveTestStatus && (
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  color: gdriveTestStatus.startsWith('✓') ? theme.success : theme.danger,
                }}>
                  {gdriveTestStatus}
                </span>
              )}
            </div>
            {currentFileGuids && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                <div style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.06em',
                  color: theme.textMuted,
                  marginBottom: 4,
                }}>
                  Drive File IDs
                </div>
                <Field label="Log" value={`${currentFileGuids.log}.eodb`} theme={theme} />
                <Field label="Recent" value={`${currentFileGuids.recent}.eodb`} theme={theme} />
                <Field label="Manifest" value={`${currentFileGuids.manifest}.json`} theme={theme} />
              </div>
            )}
            {(gdriveSync || gdriveConnected) && <GDriveStorageWidget />}
          </div>
        </Section>

        {/* Airtable Importer */}
        <Section title="Airtable Importer" theme={theme}>
          <AirtableSettingsSection
            session={session}
            matrixClient={matrixClient}
            roomId={roomId}
          />
        </Section>

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
