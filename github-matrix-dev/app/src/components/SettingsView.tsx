import { useState, useEffect } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { MatrixSession } from '../matrix/client';
import { RoomDataViewer } from './RoomDataViewer';
import { FilenStorageWidget } from './FilenStorageWidget';

interface SettingsViewProps {
  session: MatrixSession;
}

export function SettingsView({ session }: SettingsViewProps) {
  const { theme } = useTheme();
  const lastSeq = useEoStore((s) => s.lastSeq);
  const recentEvents = useEoStore((s) => s.recentEvents);
  const store = useEoStore((s) => s.store);
  const syncManager = useEoStore((s) => s.syncManager);
  const manualSnapshot = useEoStore((s) => s.manualSnapshot);
  const [showRoomData, setShowRoomData] = useState(false);
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

        {/* Sync & Snapshots */}
        <Section title="Sync & Snapshots" theme={theme}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: syncManager ? '#22c55e' : theme.textMuted,
              boxShadow: syncManager ? '0 0 6px #22c55e' : 'none',
            }} />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: theme.text }}>
              Matrix sync: {syncManager ? 'connected' : 'offline'}
            </span>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={s.actionBtn} onClick={handleSnapshot} disabled={!syncManager}>
              Take Snapshot
            </button>
            <button
              style={{ ...s.actionBtn, background: 'transparent', color: theme.accent, border: `1px solid ${theme.accent}` }}
              onClick={() => setShowRoomData(true)}
            >
              View Room Data
            </button>
            {snapshotStatus && (
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: snapshotStatus.startsWith('Error') ? theme.danger : theme.success }}>
                {snapshotStatus}
              </span>
            )}
          </div>
        </Section>

        {/* Filen Storage */}
        <Section title="Extra Storage" theme={theme}>
          <FilenStorageWidget />
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
