import { useState, useEffect } from 'react';
import { logout, createMatrixClient, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { createIdb } from '../db/idb';
import { createStore } from '../db/encrypted-store';
import { deriveKey } from '../lib/crypto';
import { SyncManager } from '../matrix/sync-manager';
import { resolveDataRoom } from '../matrix/event-bridge';
import { HolonNav } from './HolonNav';
import { TableView } from './TableView';
import { RecordDetailDrawer } from './RecordDetailDrawer';
import { ConnectionStatus, useConnectionState } from './ConnectionStatus';
import { ErrorBoundary } from './ErrorBoundary';
import { SyncProgress } from './SyncProgress';
import { AirtableSettings } from './AirtableSettings';
import { DataSyncDashboard } from './DataSyncDashboard';

interface LayoutProps {
  session: MatrixSession;
  onLogout: () => void;
}

export function Layout({ session, onLogout }: LayoutProps) {
  const init = useEoStore((s) => s.init);
  const teardown = useEoStore((s) => s.teardown);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [activeView, setActiveView] = useState<'records' | 'sync'>('records');
  const connectionState = useConnectionState();

  // Initialize encrypted store and sync from Matrix on mount
  useEffect(() => {
    let mounted = true;
    let matrixClient: ReturnType<typeof createMatrixClient> | null = null;

    async function setup() {
      const idb = await createIdb();
      const key = await deriveKey(session.userId, session.deviceId, session.accessToken);
      const store = createStore(idb, key);
      if (!mounted) return;

      await init(store);

      // Start Matrix client and sync data from the room
      matrixClient = createMatrixClient(session);
      await matrixClient.startClient({ initialSyncLimit: 0 });

      // Wait for initial sync to complete so rooms are available
      await new Promise<void>((resolve) => {
        if (matrixClient!.isInitialSyncComplete()) {
          resolve();
        } else {
          matrixClient!.once('sync' as any, (state: string) => {
            if (state === 'PREPARED') resolve();
          });
        }
      });

      if (!mounted) { matrixClient.stopClient(); return; }

      const roomId = await resolveDataRoom(matrixClient);
      const syncManager = new SyncManager(matrixClient, roomId, store, (event) => {
        // Update the Zustand store as events are replayed
        useEoStore.setState((s) => ({
          recentEvents: [...s.recentEvents.slice(-99), event],
          lastSeq: event.seq,
        }));
      });
      await syncManager.initialize();

      // Make sync manager available for dispatching events to Matrix
      useEoStore.getState().setSyncManager(syncManager);

      // Save a snapshot to Matrix media before the page unloads
      const handleBeforeUnload = () => {
        syncManager.saveSnapshot().catch(() => {});
      };
      window.addEventListener('beforeunload', handleBeforeUnload);
      cleanupBeforeUnload = () => window.removeEventListener('beforeunload', handleBeforeUnload);
    }

    let cleanupBeforeUnload: (() => void) | undefined;
    setup();

    return () => {
      mounted = false;
      cleanupBeforeUnload?.();
      if (matrixClient) matrixClient.stopClient();
    };
  }, [session, init]);

  async function handleLogout() {
    // Save snapshot to Matrix media before clearing local state
    const { syncManager } = useEoStore.getState();
    if (syncManager) {
      try { await syncManager.saveSnapshot(); } catch { /* best effort */ }
    }
    teardown();
    logout();
    onLogout();
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>Amino Immigration</span>
          <div style={styles.divider} />
          <span style={styles.section}>Case Management</span>
        </div>
        <div style={styles.headerRight}>
          <ConnectionStatus state={connectionState} />
          <div style={styles.seqBadge}>seq: {lastSeq}</div>
          <div style={styles.viewTabs}>
            <button
              onClick={() => setActiveView('records')}
              style={{
                ...styles.viewTab,
                ...(activeView === 'records' ? styles.viewTabActive : {}),
              }}
            >
              Records
            </button>
            <button
              onClick={() => setActiveView('sync')}
              style={{
                ...styles.viewTab,
                ...(activeView === 'sync' ? styles.viewTabActive : {}),
              }}
            >
              Sync
            </button>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            style={styles.settingsBtn}
            title="Airtable Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M8 1.5v1.2M8 13.3v1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M1.5 8h1.2M13.3 8h1.2M3.4 12.6l.85-.85M11.75 4.25l.85-.85" />
            </svg>
          </button>
          <span style={styles.user}>{session.userId}</span>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      {activeView === 'sync' ? (
        <div style={styles.body}>
          <main style={{ ...styles.main, flex: 1 }}>
            <ErrorBoundary>
              <DataSyncDashboard session={session} />
            </ErrorBoundary>
          </main>
        </div>
      ) : (
        <div style={styles.body}>
          <aside style={styles.sidebar}>
            {ready ? (
              <HolonNav
                selectedScope={selectedScope}
                onSelectScope={(scope) => { setSelectedScope(scope); setSelectedRecord(null); }}
                onSelectSegment={(_scope, _seg) => { setSelectedScope(_scope); }}
              />
            ) : (
              <SyncProgress message="Initializing store..." detail="Deriving encryption key" />
            )}
          </aside>
          <main style={styles.main}>
            <ErrorBoundary>
              {selectedScope ? (
                <TableView
                  scope={selectedScope}
                  onSelectRecord={setSelectedRecord}
                  activeRecord={selectedRecord}
                  session={{ userId: session.userId }}
                />
              ) : (
                <div style={styles.empty}>
                  <div style={styles.emptyText}>Select an object type to view its records</div>
                  <div style={styles.emptySub}>
                    Choose from the hierarchy on the left to see records as a table
                  </div>
                </div>
              )}
            </ErrorBoundary>
          </main>
          {selectedRecord && (
            <RecordDetailDrawer
              target={selectedRecord}
              onClose={() => setSelectedRecord(null)}
              onNavigate={(t) => setSelectedRecord(t)}
            />
          )}
        </div>
      )}
      {showSettings && (
        <AirtableSettings session={session} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#faf9f7',
    color: '#2c2a26',
    fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0 24px',
    height: 52,
    background: '#fff',
    borderBottom: '1px solid #e5e2dd',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  logo: {
    fontFamily: "'Source Serif 4', Georgia, serif",
    fontSize: 17,
    fontWeight: 600,
    color: '#1a1816',
  },
  divider: { width: 1, height: 20, background: '#d4d0ca' },
  section: { fontSize: 13, color: '#7a756d', fontWeight: 400 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 16 },
  seqBadge: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: '#aba69e',
    padding: '2px 8px',
    borderRadius: 4,
    background: '#f4f3f0',
    border: '1px solid #e5e2dd',
  },
  viewTabs: {
    display: 'flex',
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    overflow: 'hidden',
  },
  viewTab: {
    padding: '5px 12px',
    fontSize: 11,
    fontWeight: 500,
    border: 'none',
    background: 'transparent',
    color: '#7a756d',
    cursor: 'pointer',
    fontFamily: "'JetBrains Mono', monospace",
    borderRight: '1px solid #e5e2dd',
  } as React.CSSProperties,
  viewTabActive: {
    background: '#1a6dd4',
    color: '#fff',
  } as React.CSSProperties,
  settingsBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: 'transparent',
    color: '#7a756d',
    cursor: 'pointer',
  },
  user: { fontSize: 12, color: '#7a756d' },
  logoutBtn: {
    padding: '6px 14px',
    fontSize: 12,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: 'transparent',
    color: '#7a756d',
    cursor: 'pointer',
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: {
    width: 280,
    borderRight: '1px solid #e5e2dd',
    background: '#fff',
  },
  main: { flex: 1, overflowY: 'auto', background: '#faf9f7' },
  loading: { padding: 18, fontSize: 13, color: '#aba69e' },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 8,
  },
  emptyText: { fontSize: 14, color: '#7a756d', fontWeight: 300 },
  emptySub: { fontSize: 12, color: '#aba69e' },
};
