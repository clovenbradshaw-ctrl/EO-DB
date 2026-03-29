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
import { LogView } from './LogView';

type View = 'horizon' | 'log' | 'graph' | 'compose' | 'settings';
const TABS: View[] = ['horizon', 'log', 'graph', 'compose', 'settings'];

interface LayoutProps {
  session: MatrixSession;
  onLogout: () => void;
}

export function Layout({ session, onLogout }: LayoutProps) {
  const init = useEoStore((s) => s.init);
  const teardown = useEoStore((s) => s.teardown);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const recentEvents = useEoStore((s) => s.recentEvents);
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [activeView, setActiveView] = useState<View>('horizon');
  const [spaceOpen, setSpaceOpen] = useState(false);
  const connectionState = useConnectionState();

  // Compute target count from recent events
  const targetCount = new Set(recentEvents.map((e) => e.target)).size;
  // Compute edge count (CON events)
  const edgeCount = recentEvents.filter((e) => e.op === 'CON').length;

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

  // Extract display name from Matrix user ID
  const displayName = session.userId.startsWith('@')
    ? session.userId.slice(1).split(':')[0]
    : session.userId;

  return (
    <div style={styles.container}>
      {/* Top bar */}
      <header style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <span style={styles.logo}>
            <span style={{ color: '#22c55e' }}>EO</span>
            <span style={{ color: '#1e293b' }}>///</span>
            <span style={{ color: '#cbd5e1' }}>DB</span>
          </span>

          <div style={styles.divider} />

          {/* NULSpace selector */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setSpaceOpen(!spaceOpen)}
              style={styles.nulspaceBtn}
            >
              <span style={styles.nulTag}>NUL</span>
              <span style={styles.nulspaceName}>default</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ marginLeft: 2 }}>
                <path d="M2.5 4L5 6.5L7.5 4" stroke="#475569" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>

            {spaceOpen && (
              <div style={styles.nulspaceDropdown}>
                <button
                  onClick={() => setSpaceOpen(false)}
                  style={{ ...styles.nulspaceItem, background: '#1e293b' }}
                >
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>default</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#475569' }}>
                    {targetCount} targets
                  </span>
                </button>
                <div style={{ borderTop: '1px solid #1e293b', margin: '4px 0' }} />
                <button style={{
                  ...styles.nulspaceItem,
                  color: '#22c55e',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  gap: 5,
                }}>
                  <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
                  new nulspace
                </button>
              </div>
            )}
          </div>
        </div>

        <div style={styles.topBarRight}>
          <div style={styles.stats}>
            <span>seq <span style={{ color: '#64748b' }}>{lastSeq}</span></span>
            <span>events <span style={{ color: '#64748b' }}>{recentEvents.length}</span></span>
            <span>targets <span style={{ color: '#64748b' }}>{targetCount}</span></span>
            <span>edges <span style={{ color: '#64748b' }}>{edgeCount}</span></span>
          </div>
          <div style={styles.divider} />
          <ConnectionStatus state={connectionState} />
          <div style={styles.divider} />
          <div style={styles.userArea}>
            <div style={styles.userAvatar}>
              {displayName.charAt(0).toUpperCase()}
            </div>
            <span style={{ fontSize: 11, color: '#64748b' }}>{displayName}</span>
          </div>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveView(tab)}
            style={{
              ...styles.tab,
              color: activeView === tab ? '#e2e8f0' : '#334155',
              borderBottom: activeView === tab ? '1.5px solid #22c55e' : '1.5px solid transparent',
            }}
          >
            {tab === 'compose' ? '+ COMPOSE' : tab.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Body */}
      {activeView === 'log' ? (
        <div style={styles.body}>
          <ErrorBoundary>
            <LogView />
          </ErrorBoundary>
        </div>
      ) : activeView === 'horizon' ? (
        <div style={styles.bodyLight}>
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
          <main style={styles.mainLight}>
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
      ) : (
        <div style={styles.body}>
          <div style={styles.emptyDark}>
            <div style={{ fontSize: 13, color: '#334155', fontFamily: 'var(--mono)' }}>
              {activeView.toUpperCase()}
            </div>
            <div style={{ fontSize: 11, color: '#1e293b', fontFamily: 'var(--mono)' }}>
              not yet implemented
            </div>
          </div>
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
    '--mono': "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    '--sans': "'Inter', -apple-system, system-ui, sans-serif",
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#080c12',
    color: '#e2e8f0',
    fontFamily: 'var(--sans)',
  } as React.CSSProperties,

  // Top bar
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 16px',
    height: 42,
    borderBottom: '1px solid #141a24',
    background: '#0a0f16',
    flexShrink: 0,
  },
  topBarLeft: { display: 'flex', alignItems: 'center', gap: 14 },
  topBarRight: { display: 'flex', alignItems: 'center', gap: 16 },
  logo: {
    fontFamily: 'var(--mono)',
    fontWeight: 700,
    fontSize: 13.5,
    letterSpacing: '-0.03em',
  },
  divider: { width: 1, height: 18, background: '#1e293b' },

  // NULSpace selector
  nulspaceBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#111827',
    border: '1px solid #1e293b',
    borderRadius: 4,
    padding: '4px 10px 4px 8px',
    cursor: 'pointer',
    color: '#e2e8f0',
  },
  nulTag: {
    fontSize: 8,
    fontWeight: 700,
    color: '#475569',
    fontFamily: 'var(--mono)',
    letterSpacing: '0.06em',
    background: '#0a0f16',
    borderRadius: 2,
    padding: '1px 4px',
    border: '1px solid #1e293b',
  },
  nulspaceName: {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    fontWeight: 500,
  },
  nulspaceDropdown: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    background: '#111827',
    border: '1px solid #1e293b',
    borderRadius: 6,
    padding: 4,
    minWidth: 200,
    boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
    zIndex: 100,
  } as React.CSSProperties,
  nulspaceItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '7px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    color: '#e2e8f0',
    textAlign: 'left' as const,
  },

  // Stats
  stats: {
    display: 'flex',
    gap: 12,
    fontSize: 10,
    color: '#334155',
    fontFamily: 'var(--mono)',
  },

  // User area
  userArea: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  userAvatar: {
    width: 22,
    height: 22,
    borderRadius: '50%',
    background: '#1e293b',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 10,
    fontWeight: 600,
    color: '#64748b',
  },

  logoutBtn: {
    padding: '4px 10px',
    fontSize: 10,
    border: '1px solid #1e293b',
    borderRadius: 4,
    background: 'transparent',
    color: '#475569',
    cursor: 'pointer',
    fontFamily: 'var(--mono)',
  },

  // Tab bar
  tabBar: {
    display: 'flex',
    padding: '0 16px',
    borderBottom: '1px solid #141a24',
    background: '#0a0f16',
    flexShrink: 0,
  },
  tab: {
    padding: '9px 14px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: '0.06em',
    fontFamily: 'var(--mono)',
    color: '#334155',
    borderBottom: '1.5px solid transparent',
  },

  // Body
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    background: '#080c12',
  },
  bodyLight: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
    background: '#faf9f7',
  },

  // Sidebar (for HORIZON view)
  sidebar: {
    width: 280,
    borderRight: '1px solid #e5e2dd',
    background: '#fff',
  },
  mainLight: {
    flex: 1,
    overflowY: 'auto',
    background: '#faf9f7',
  },

  // Empty states
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
  emptyDark: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: 8,
  },
};
