import { useState, useEffect } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { MatrixSession } from '../matrix/client';
import { RoomDataViewer } from './RoomDataViewer';
import { MatrixRoomsViewer } from './MatrixRoomsViewer';
import { UserRoomsBySpaces } from './UserRoomsBySpaces';
import { FilenStorageWidget } from './FilenStorageWidget';
import { GDriveStorageWidget } from './GDriveStorageWidget';
import { OP_COLORS, TRIAD_LABELS } from './LogView';
import { ArchivedSpacesSection } from './ArchivedSpaces';
import { AirtableSettingsSection } from './AirtableSettings';
import { useGDriveStore } from '../google-drive/gdrive-store';

interface SettingsViewProps {
  session: MatrixSession;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
  /** Full room topology for the current space (main, governance, restricted) */
  spaceRooms?: { main: string; restricted?: string; governance?: string } | null;
  onUnarchive?: (target: string) => void;
  /** Current connection status for the header badge */
  connectionState?: 'online' | 'offline' | 'syncing' | 'local' | 'error';
  /** Structured error from Matrix/Filen init */
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
  const filenSync = useEoStore((s) => s.filenSync);
  const gdriveSync = useEoStore((s) => s.gdriveSync);
  const gdriveConnected = useGDriveStore((s) => s.connected);
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
    return <RoomDataViewer onBack={() => setShowRoomData(false)} />;
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
        <Section title="Local Storage (IndexedDB)" theme={theme}>
          <Field label="Events" value={String(eventCount ?? '—')} theme={theme} />
          <Field label="Current Seq" value={String(lastSeq)} theme={theme} />
          <Field label="Architecture" value="Browser-native (no server)" theme={theme} />
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
            {/* Sync Manager (Matrix timeline sync) */}
            <StatusRow
              theme={theme}
              label="Matrix Sync"
              status={syncManager ? 'ok' : filenSync ? 'off' : matrixReady && roomId ? 'pending' : 'off'}
              detail={
                syncManager ? 'Timeline sync active'
                : filenSync ? 'Skipped (Filen is primary data store)'
                : matrixReady && roomId ? 'Initializing...'
                : 'Not started'
              }
            />
            {/* Filen */}
            <StatusRow
              theme={theme}
              label="Filen Storage"
              status={filenSync ? 'ok' : 'off'}
              detail={filenSync ? 'Backup sync active' : 'Not connected'}
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

        {/* Cloud Storage (shared Filen credentials fetched from n8n webhook) */}
        {(filenSync || (matrixClient && roomId)) && (
          <Section title="Filen Cloud Storage" theme={theme}>
            <FilenStorageWidget />
          </Section>
        )}

        {/* Google Drive Cloud Storage */}
        {(gdriveSync || gdriveConnected) && (
          <Section title="Google Drive Storage" theme={theme}>
            <GDriveStorageWidget />
          </Section>
        )}

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
