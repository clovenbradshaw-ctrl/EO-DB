import { useState, useEffect } from 'react';
import { logout, createMatrixClient, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { createIdb } from '../db/idb';
import { createStore } from '../db/encrypted-store';
import { deriveKey } from '../lib/crypto';
import { SyncManager } from '../matrix/sync-manager';
import { resolveDataRoom } from '../matrix/event-bridge';
import { configureMatrixDomain } from '../lib/matrix-domain';
import { HolonNav } from './HolonNav';
import { TableView } from './TableView';
import { RecordDetailDrawer } from './RecordDetailDrawer';
import { ConnectionStatus, useConnectionState } from './ConnectionStatus';
import { ErrorBoundary } from './ErrorBoundary';
import { SyncProgress } from './SyncProgress';
import { AirtableSettingsSection } from './AirtableSettings';
import { DataSyncDashboard } from './DataSyncDashboard';
import { LogView } from './LogView';
import { ComposeView } from './ComposeView';
import { GraphView } from './GraphView';
import { SettingsView } from './SettingsView';
import { useTheme, type Theme } from '../theme';
import type { EoState } from '../db/types';

type View = 'horizon' | 'log' | 'graph' | 'import' | 'compose' | 'settings';

function formatSpaceName(segment: string): string {
  // Strip common prefixes, replace underscores with spaces, capitalize
  let name = segment.replace(/^space_/, '');
  name = name.replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

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
  const [activeView, setActiveView] = useState<View>('horizon');
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<EoState[]>([]);
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const connectionState = useConnectionState();
  const { theme, toggleTheme } = useTheme();
  const s = makeStyles(theme);

  // Load available spaces
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('space.').then((states) => {
      // Spaces are depth-1 under "space." (e.g. space.demo_space)
      const spaceRoots = states.filter((st) => {
        const parts = st.target.split('.');
        return parts.length === 2 && !st.value?._alias;
      });
      setSpaces(spaceRoots);
      // Auto-select first space if none selected
      if (spaceRoots.length > 0 && selectedSpace === null) {
        setSelectedSpace(spaceRoots[0].target);
      }
    });
  }, [ready, lastSeq, getStateByPrefix]);

  // The prefix to query — scoped to selected space, or everything if none
  const statePrefix = selectedSpace ? `${selectedSpace}.` : '';

  // Load states scoped to selected space for query bar autofill
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(statePrefix).then(setAllStates);
  }, [ready, lastSeq, getStateByPrefix, statePrefix]);

  // Compute target count from recent events — scoped to selected space
  const spaceEvents = statePrefix
    ? recentEvents.filter((e) => e.target.startsWith(statePrefix))
    : recentEvents;
  const targetCount = new Set(spaceEvents.map((e) => e.target)).size;
  // Compute edge count (CON events)
  const edgeCount = spaceEvents.filter((e) => e.op === 'CON').length;

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

      // Configure Matrix domain from the session homeserver so room
      // alias resolution and event types work correctly.
      const domain = session.homeserver.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      configureMatrixDomain({ dataRoomAlias: `#amino-data:${domain}` });

      // Start Matrix sync — skip gracefully when offline
      if (!navigator.onLine) return;
      try {
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
      } catch {
        // Offline or network error — local store is still available
      }
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
    <div style={s.container}>
      {/* Top bar */}
      <header style={s.topBar}>
        <div style={s.topBarLeft}>
          <span style={s.logo}>
            <span style={{ color: theme.success }}>EO</span>
            <span style={{ color: theme.borderLight }}>///</span>
            <span style={{ color: theme.textHeading }}>DB</span>
          </span>

          <div style={s.divider} />

          {/* Space badge */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setSpaceOpen(!spaceOpen)}
              style={s.spaceBadge}
            >
              {selectedSpace
                ? formatSpaceName(selectedSpace.split('.').pop() || '')
                : 'All'}
            </button>

            {spaceOpen && (
              <div style={s.nulspaceDropdown}>
                {/* "All" option — no space filter */}
                <button
                  onClick={() => { setSelectedSpace(null); setSpaceOpen(false); setSelectedScope(null); setSelectedRecord(null); }}
                  style={{ ...s.nulspaceItem, ...(selectedSpace === null ? { background: theme.bgHover } : {}) }}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>All</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>
                    no filter
                  </span>
                </button>
                {spaces.map((sp) => {
                  const name = sp.target.split('.').pop() || sp.target;
                  const displayName = sp.value?.name || formatSpaceName(name);
                  const isActive = selectedSpace === sp.target;
                  return (
                    <button
                      key={sp.target}
                      onClick={() => { setSelectedSpace(sp.target); setSpaceOpen(false); setSelectedScope(null); setSelectedRecord(null); }}
                      style={{ ...s.nulspaceItem, ...(isActive ? { background: theme.bgHover } : {}) }}
                    >
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{displayName}</span>
                      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>
                        {sp.target}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div style={s.topBarRight}>
          <div style={s.stats}>
            <span>seq <b style={{ color: theme.text, fontWeight: 500 }}>{lastSeq}</b></span>
            <span>evt <b style={{ color: theme.text, fontWeight: 500 }}>{recentEvents.length}</b></span>
            <span>tgt <b style={{ color: theme.text, fontWeight: 500 }}>{targetCount}</b></span>
            <span>edg <b style={{ color: theme.text, fontWeight: 500 }}>{edgeCount}</b></span>
          </div>
          <div style={s.statusDot}>
            <ConnectionStatus state={connectionState} />
          </div>
        </div>
      </header>

      {/* Body — sidebar always visible */}
      <div style={s.body}>
        <aside style={s.sidebar}>
          {/* View navigation */}
          <nav style={s.sidebarNav}>
            {(['horizon', 'log', 'graph'] as View[]).map((view) => (
              <button
                key={view}
                onClick={() => setActiveView(view)}
                style={{
                  ...s.navItem,
                  ...(activeView === view ? s.navItemActive : {}),
                }}
              >
                {view.charAt(0).toUpperCase() + view.slice(1)}
              </button>
            ))}
          </nav>

          {/* Objects tree */}
          {ready ? (
            <HolonNav
              selectedScope={selectedScope}
              onSelectScope={(scope) => { setSelectedScope(scope); setSelectedRecord(null); }}
              onSelectSegment={(_scope, _seg) => { setSelectedScope(_scope); }}
              statePrefix={statePrefix}
            />
          ) : (
            <SyncProgress message="Initializing store..." detail="Deriving encryption key" />
          )}
        </aside>

        <main style={s.main}>
          <ErrorBoundary>
            {activeView === 'horizon' ? (
              <>
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
              </>
            ) : activeView === 'log' ? (
              <LogView targetFilter={selectedScope} spacePrefix={statePrefix || undefined} />
            ) : activeView === 'graph' ? (
              <GraphView spacePrefix={statePrefix || undefined} />
            ) : activeView === 'import' ? (
              <div style={s.importPage}>
                <div style={s.importHeader}>
                  <div style={s.importTitle}>Import Data</div>
                  <div style={s.importSubtitle}>Connect external data sources and sync records into EO-DB</div>
                </div>
                <AirtableSettingsSection session={session} />
              </div>
            ) : activeView === 'compose' ? (
              <ComposeView spacePrefix={statePrefix || undefined} />
            ) : activeView === 'settings' ? (
              <SettingsView session={session} />
            ) : null}
          </ErrorBoundary>
        </main>

        {selectedRecord && activeView === 'horizon' && (
          <RecordDetailDrawer
            target={selectedRecord}
            onClose={() => setSelectedRecord(null)}
            onNavigate={(t) => setSelectedRecord(t)}
          />
        )}
      </div>
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

    // Top bar
    topBar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      height: 40,
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    topBarLeft: { display: 'flex', alignItems: 'center', gap: 12 },
    topBarRight: { display: 'flex', alignItems: 'center', gap: 16 },
    logo: {
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 500,
      fontSize: 15,
      letterSpacing: '-0.5px',
    },
    divider: { width: 1, height: 18, background: t.borderDivider },

    // Space badge
    spaceBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      background: t.accentBg,
      color: t.accent,
      border: 'none',
      borderRadius: 4,
      padding: '2px 8px',
      fontSize: 11,
      fontWeight: 500,
      cursor: 'pointer',
    },
    nulspaceDropdown: {
      position: 'absolute',
      top: 'calc(100% + 4px)',
      left: 0,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: 4,
      minWidth: 200,
      boxShadow: `0 8px 24px ${t.shadow}`,
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
      color: t.text,
      textAlign: 'left' as const,
    },

    // Stats
    stats: {
      display: 'flex',
      gap: 12,
      fontSize: 11,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
    },
    statusDot: {
      display: 'flex',
      alignItems: 'center',
    },

    // Sidebar navigation
    sidebarNav: {
      display: 'flex',
      flexDirection: 'column' as const,
      padding: '12px 0',
      borderBottom: `0.5px solid ${t.border}`,
    },
    navItem: {
      display: 'block',
      width: '100%',
      padding: '6px 16px',
      background: 'transparent',
      border: 'none',
      borderLeft: '2px solid transparent',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 400,
      color: t.textSecondary,
      textAlign: 'left' as const,
      transition: 'background 0.1s, color 0.1s',
    },
    navItemActive: {
      color: t.accent,
      background: t.accentBg,
      borderLeft: `2px solid ${t.accent}`,
      fontWeight: 500,
    },

    // Body
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 200,
      borderRight: `0.5px solid ${t.border}`,
      background: t.bgCard,
      display: 'flex',
      flexDirection: 'column' as const,
    },
    main: { flex: 1, overflowY: 'auto' as const, overflow: 'hidden', display: 'flex', flexDirection: 'column' as const, background: t.bg },

    // Import page
    importPage: {
      flex: 1,
      overflowY: 'auto' as const,
      maxWidth: 640,
      margin: '0 auto',
      padding: '0 24px 40px',
    },
    importHeader: {
      padding: '28px 0 8px',
      borderBottom: `1px solid ${t.border}`,
      marginBottom: 4,
    },
    importTitle: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 20,
      fontWeight: 600,
      color: t.textHeading,
    },
    importSubtitle: {
      fontSize: 12,
      color: t.textSecondary,
      marginTop: 4,
    },

    // Empty states
    empty: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      flex: 1,
      gap: 8,
    },
    emptyText: { fontSize: 14, color: t.textSecondary, fontWeight: 300 },
    emptySub: { fontSize: 12, color: t.textMuted },
  };
}
