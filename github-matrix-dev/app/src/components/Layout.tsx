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
import { useTheme, type Theme } from '../theme';

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
  const { theme, toggleTheme } = useTheme();
  const s = makeStyles(theme);

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
        useEoStore.setState((st) => ({
          recentEvents: [...st.recentEvents.slice(-99), event],
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
    <div style={s.container}>
      <header style={s.header}>
        <div style={s.headerLeft}>
          <span style={s.logo}>Amino Immigration</span>
          <div style={s.divider} />
          <span style={s.section}>Case Management</span>
        </div>
        <div style={s.headerRight}>
          <ConnectionStatus state={connectionState} />
          <div style={s.seqBadge}>seq: {lastSeq}</div>
          <div style={s.viewTabs}>
            <button
              onClick={() => setActiveView('records')}
              style={{
                ...s.viewTab,
                ...(activeView === 'records' ? s.viewTabActive : {}),
              }}
            >
              Records
            </button>
            <button
              onClick={() => setActiveView('sync')}
              style={{
                ...s.viewTab,
                ...(activeView === 'sync' ? s.viewTabActive : {}),
              }}
            >
              Sync
            </button>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            style={s.settingsBtn}
            title="Airtable Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M8 1.5v1.2M8 13.3v1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M1.5 8h1.2M13.3 8h1.2M3.4 12.6l.85-.85M11.75 4.25l.85-.85" />
            </svg>
          </button>
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            style={s.settingsBtn}
            title={theme.mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme.mode === 'light' ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.5 8.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="3" />
                <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
              </svg>
            )}
          </button>
          <span style={s.user}>{session.userId}</span>
          <button onClick={handleLogout} style={s.logoutBtn}>Sign out</button>
        </div>
      </header>
      {activeView === 'sync' ? (
        <div style={s.body}>
          <main style={{ ...s.main, flex: 1 }}>
            <ErrorBoundary>
              <DataSyncDashboard session={session} />
            </ErrorBoundary>
          </main>
        </div>
      ) : (
        <div style={s.body}>
          <aside style={s.sidebar}>
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
          <main style={s.main}>
            <ErrorBoundary>
              {selectedScope ? (
                <TableView
                  scope={selectedScope}
                  onSelectRecord={setSelectedRecord}
                  activeRecord={selectedRecord}
                  session={{ userId: session.userId }}
                />
              ) : (
                <div style={s.empty}>
                  <div style={s.emptyText}>Select an object type to view its records</div>
                  <div style={s.emptySub}>
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

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: t.bg,
      color: t.text,
      fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '0 24px',
      height: 52,
      background: t.bgCard,
      borderBottom: `1px solid ${t.border}`,
    },
    headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
    logo: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 17,
      fontWeight: 600,
      color: t.textHeading,
    },
    divider: { width: 1, height: 20, background: t.borderDivider },
    section: { fontSize: 13, color: t.textSecondary, fontWeight: 400 },
    headerRight: { display: 'flex', alignItems: 'center', gap: 16 },
    seqBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      padding: '2px 8px',
      borderRadius: 4,
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
    },
    viewTabs: {
      display: 'flex',
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      overflow: 'hidden',
    },
    viewTab: {
      padding: '5px 12px',
      fontSize: 11,
      fontWeight: 500,
      border: 'none',
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
      borderRight: `1px solid ${t.border}`,
    } as React.CSSProperties,
    viewTabActive: {
      background: t.accent,
      color: '#fff',
    } as React.CSSProperties,
    settingsBtn: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 32,
      height: 32,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
    },
    user: { fontSize: 12, color: t.textSecondary },
    logoutBtn: {
      padding: '6px 14px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
    },
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 280,
      borderRight: `1px solid ${t.border}`,
      background: t.bgCard,
    },
    main: { flex: 1, overflowY: 'auto', background: t.bg },
    loading: { padding: 18, fontSize: 13, color: t.textMuted },
    empty: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 8,
    },
    emptyText: { fontSize: 14, color: t.textSecondary, fontWeight: 300 },
    emptySub: { fontSize: 12, color: t.textMuted },
  };
}
