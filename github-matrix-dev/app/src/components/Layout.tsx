import { useState, useEffect, useRef, useMemo } from 'react';
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
import { SpaceMembers } from './SpaceMembers';
import { BuilderView } from './builder/BuilderView';
import { RecordPageView } from './builder/RecordPageView';
import { useBuilderStore } from '../store/builder-store';
import { useTheme, spaceBackgroundTint, type Theme } from '../theme';
import type { EoState } from '../db/types';
import type { ViewDefinition } from '../blocks/types';
import { TimeScrubber } from './TimeScrubber';
import { type TimeScrubberFilter, type DateColumnOption, DEFAULT_FILTER, detectDateColumns } from './time-scrubber-utils';
import { hasFieldsSubObject, buildFieldNameMap } from './filter-types';

type View = 'horizon' | 'log' | 'graph' | 'import' | 'compose' | 'settings' | 'builder';

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

interface CachedSpace {
  store: ReturnType<typeof createStore>;
  syncManager: SyncManager | null;
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
  const [showMembers, setShowMembers] = useState(false);
  const [spaces, setSpaces] = useState<EoState[]>([]);
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const [timeScrubberFilter, setTimeScrubberFilter] = useState<TimeScrubberFilter>(DEFAULT_FILTER);
  const [scopedRecords, setScopedRecords] = useState<EoState[]>([]);
  const [scopeFieldNameMap, setScopeFieldNameMap] = useState<Map<string, string>>(new Map());
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const connectionState = useConnectionState();
  const { theme, toggleTheme } = useTheme();
  const spaceTint = spaceBackgroundTint(selectedSpace, theme.mode);
  const themedBg = spaceTint ? { ...theme, bg: spaceTint.bg, bgCard: spaceTint.bgCard, bgMuted: spaceTint.bgMuted } : theme;
  const s = makeStyles(themedBg);

  // The prefix to query — scoped to selected space
  const statePrefix = selectedSpace ? `${selectedSpace}.` : '';

  // Load states scoped to selected space for query bar autofill
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix(statePrefix).then(setAllStates);
  }, [ready, lastSeq, getStateByPrefix, statePrefix]);

  // Load records scoped to selected scope for the time scrubber
  useEffect(() => {
    if (!ready || !selectedScope) {
      setScopedRecords([]);
      setScopeFieldNameMap(new Map());
      return;
    }
    const scopeDepth = selectedScope.split('.').length;
    getStateByPrefix(selectedScope + '.').then((states) => {
      const direct = states.filter((st) => {
        const parts = st.target.split('.');
        return parts.length === scopeDepth + 1 && !st.value?._alias;
      });
      setScopedRecords(direct);
    });
    getState(selectedScope).then((scopeState) => {
      const fields = scopeState?.value?.fields;
      if (Array.isArray(fields)) {
        setScopeFieldNameMap(buildFieldNameMap(fields));
      } else {
        setScopeFieldNameMap(new Map());
      }
    });
  }, [ready, lastSeq, getStateByPrefix, getState, selectedScope]);

  // Reset scrubber when scope changes
  useEffect(() => {
    setTimeScrubberFilter(DEFAULT_FILTER);
  }, [selectedScope, selectedSpace]);

  // Detect date columns for the scrubber
  const useFieldsSub = useMemo(() => hasFieldsSubObject(scopedRecords), [scopedRecords]);
  const dateColumns = useMemo<DateColumnOption[]>(
    () => detectDateColumns(scopedRecords, useFieldsSub, scopeFieldNameMap),
    [scopedRecords, useFieldsSub, scopeFieldNameMap],
  );

  // Compute target count from recent events — all events belong to this space now
  const targetCount = new Set(recentEvents.map((e) => e.target)).size;
  const edgeCount = recentEvents.filter((e) => e.op === 'CON').length;

  // --- Matrix client (lives for the entire session, not per-space) ---
  const matrixClientRef = useRef<ReturnType<typeof createMatrixClient> | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const matrixReadyRef = useRef(false);

  useEffect(() => {
    let mounted = true;

    // Configure Matrix domain from the session homeserver
    const domain = session.homeserver.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    configureMatrixDomain({ dataRoomAlias: `#amino-data:${domain}` });

    async function startMatrix() {
      if (!navigator.onLine) return;
      try {
        const client = createMatrixClient(session);
        matrixClientRef.current = client;
        await client.startClient({ initialSyncLimit: 0 });

        await new Promise<void>((resolve) => {
          if (client.isInitialSyncComplete()) {
            resolve();
          } else {
            client.once('sync' as any, (state: string) => {
              if (state === 'PREPARED') resolve();
            });
          }
        });

        if (!mounted) { client.stopClient(); return; }

        roomIdRef.current = await resolveDataRoom(client);
        matrixReadyRef.current = true;
      } catch {
        // Offline — local store is still available
      }
    }

    startMatrix();

    return () => {
      mounted = false;
      if (matrixClientRef.current) matrixClientRef.current.stopClient();
      matrixClientRef.current = null;
      roomIdRef.current = null;
      matrixReadyRef.current = false;
    };
  }, [session]);

  // --- Space discovery (one-time, uses root IDB) ---
  useEffect(() => {
    let mounted = true;

    async function discoverSpaces() {
      // Check localStorage cache first — show UI immediately from cache
      const cached = localStorage.getItem('eo-spaces');
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as EoState[];
          if (parsed.length > 0) {
            setSpaces(parsed);
            if (selectedSpace === null) setSelectedSpace(parsed[0].target);
          }
        } catch { /* ignore bad cache */ }
      }

      // Open root IDB to discover spaces from store data
      const idb = await createIdb();
      const key = await deriveKey(session.userId, session.deviceId);
      const rootStore = createStore(idb, key);

      // If root store is empty, try hydrating from Matrix snapshot
      const rootSeq = await rootStore.getCurrentSeq();
      if (rootSeq === 0 && matrixReadyRef.current && matrixClientRef.current && roomIdRef.current) {
        try {
          const { findLatestSnapshot, restoreFromDeltaChain } = await import('../matrix/snapshot');
          const snap = await findLatestSnapshot(matrixClientRef.current, roomIdRef.current);
          if (snap) {
            await restoreFromDeltaChain(matrixClientRef.current, rootStore, snap.mxc);
          }
        } catch { /* best effort */ }
      }

      // Query for space roots
      const { getStateByPrefix: getPrefix } = await import('../db/state');
      const states = await getPrefix(rootStore, 'space.');
      const spaceRoots = states.filter((st) => {
        const parts = st.target.split('.');
        return parts.length === 2 && !st.value?._alias;
      });

      if (!mounted) { rootStore.close(); return; }

      if (spaceRoots.length > 0) {
        setSpaces(spaceRoots);
        localStorage.setItem('eo-spaces', JSON.stringify(spaceRoots));
        if (selectedSpace === null) setSelectedSpace(spaceRoots[0].target);
      }

      rootStore.close();
    }

    // Small delay to let Matrix client connect first
    const timer = setTimeout(discoverSpaces, 100);
    return () => { mounted = false; clearTimeout(timer); };
  }, [session]);

  // --- Cached space stores (survive space switches, avoid re-init) ---
  const spaceCacheRef = useRef<Map<string, CachedSpace>>(new Map());

  // --- Per-space store init (re-runs when selectedSpace changes) ---
  useEffect(() => {
    if (!selectedSpace) return;

    let mounted = true;

    async function setupSpaceStore() {
      const cache = spaceCacheRef.current;
      const existing = cache.get(selectedSpace!);

      if (existing) {
        // Reuse cached store — no IDB open, no key derivation, no Matrix hydration
        if (!mounted) return;
        await init(existing.store);
        if (existing.syncManager) {
          useEoStore.getState().setSyncManager(existing.syncManager);
        }
        return;
      }

      // Open space-scoped IDB with stable key (userId + deviceId, no accessToken)
      const idb = await createIdb(selectedSpace!);
      const key = await deriveKey(session.userId, session.deviceId);
      const store = createStore(idb, key);
      if (!mounted) { store.close(); return; }

      await init(store);

      let syncManager: SyncManager | null = null;

      // Set up sync manager scoped to this space
      if (matrixReadyRef.current && matrixClientRef.current && roomIdRef.current) {
        try {
          const spacePrefix = `${selectedSpace}.`;
          syncManager = new SyncManager(
            matrixClientRef.current, roomIdRef.current, store,
            (event) => {
              useEoStore.setState((st) => ({
                recentEvents: [...st.recentEvents.slice(-99), event],
                lastSeq: event.seq,
              }));
            },
            spacePrefix,
          );
          await syncManager.initialize();
          if (!mounted) return;

          useEoStore.getState().setSyncManager(syncManager);
        } catch {
          // Offline — local store is still available
        }
      }

      // Cache this space's store + sync manager for fast re-access
      cache.set(selectedSpace!, { store, syncManager });
    }

    setupSpaceStore();

    return () => {
      mounted = false;
    };
  }, [selectedSpace, session, init]);

  async function handleLogout() {
    // Save snapshots for ALL cached spaces before clearing state
    const cache = spaceCacheRef.current;
    const savePromises: Promise<void>[] = [];
    for (const [, cached] of cache) {
      if (cached.syncManager) {
        savePromises.push(cached.syncManager.saveSnapshot().catch(() => {}));
      }
    }
    await Promise.all(savePromises);

    // Close all cached stores
    for (const [, cached] of cache) {
      cached.store.close();
    }
    cache.clear();

    teardown();
    logout();
    onLogout();
  }

  // Save all cached space snapshots on page unload
  useEffect(() => {
    const handleBeforeUnload = () => {
      for (const [, cached] of spaceCacheRef.current) {
        if (cached.syncManager) {
          cached.syncManager.saveSnapshot().catch(() => {});
        }
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

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
                {spaces.map((sp) => {
                  const name = sp.target.split('.').pop() || sp.target;
                  const displayName = sp.value?.name || formatSpaceName(name);
                  const isActive = selectedSpace === sp.target;
                  const memberCount = (sp.value?._sharing || []).length;
                  return (
                    <button
                      key={sp.target}
                      onClick={() => { setSelectedSpace(sp.target); setSpaceOpen(false); setSelectedScope(null); setSelectedRecord(null); setShowMembers(false); setActiveView('horizon'); }}
                      style={{ ...s.nulspaceItem, ...(isActive ? { background: theme.bgHover } : {}) }}
                    >
                      <div>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, display: 'block' }}>{displayName}</span>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>
                          {sp.target}{memberCount > 0 ? ` · ${memberCount + 1} users` : ''}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Members button — visible when a space is selected */}
          {selectedSpace && (
            <button
              onClick={() => setShowMembers(!showMembers)}
              style={{
                ...s.spaceBadge,
                background: showMembers ? theme.accent : theme.bgMuted,
                color: showMembers ? '#fff' : theme.textSecondary,
              }}
            >
              Members
            </button>
          )}
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
          {/* View navigation — grouped: views | actions | config */}
          <nav style={s.sidebarNav}>
            {/* Data views */}
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
            <div style={s.navDivider} />
            {/* Data entry */}
            {(['compose', 'import'] as View[]).map((view) => (
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
            <div style={s.navDivider} />
            {/* Builder */}
            <button
              onClick={() => setActiveView('builder')}
              style={{
                ...s.navItem,
                ...(activeView === 'builder' ? s.navItemActive : {}),
              }}
            >
              Builder
            </button>
            <div style={s.navDivider} />
            {/* System config */}
            <button
              onClick={() => setActiveView('settings')}
              style={{
                ...s.navItem,
                ...(activeView === 'settings' ? s.navItemActive : {}),
              }}
            >
              Settings
            </button>
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

        <main style={s.main} key={selectedSpace ?? '__all__'}>
          {/* Space members panel */}
          {showMembers && selectedSpace && (
            <div style={{ padding: '16px 24px', maxWidth: 480 }}>
              <SpaceMembers
                spaceTarget={selectedSpace}
                currentUserId={session.userId}
                onClose={() => setShowMembers(false)}
              />
            </div>
          )}

          {activeView === 'horizon' && (
            <TimeScrubber
              records={scopedRecords}
              dateColumns={dateColumns}
              filter={timeScrubberFilter}
              onFilterChange={setTimeScrubberFilter}
            />
          )}

          <ErrorBoundary>
            {activeView === 'horizon' ? (
              <>
                {selectedScope ? (
                  <TableView
                    scope={selectedScope}
                    onSelectRecord={setSelectedRecord}
                    activeRecord={selectedRecord}
                    session={{ userId: session.userId }}
                    timeScrubberFilter={timeScrubberFilter}
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
              <GraphView spacePrefix={statePrefix || undefined} allStates={allStates} />
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
            ) : activeView === 'builder' ? (
              <BuilderView />
            ) : activeView === 'settings' ? (
              <SettingsView session={session} />
            ) : null}
          </ErrorBoundary>
        </main>

        {selectedRecord && activeView === 'horizon' && (
          <RecordPageOrDrawer
            recordTarget={selectedRecord}
            allStates={allStates}
            onClose={() => setSelectedRecord(null)}
            onNavigate={(t) => setSelectedRecord(t)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * RecordPageOrDrawer — When a record is selected, check if there's a custom
 * record page view for the record's collection. If yes, render RecordPageView
 * in a drawer. If no, fall back to the default RecordDetailDrawer.
 */
function RecordPageOrDrawer({ recordTarget, allStates, onClose, onNavigate }: {
  recordTarget: string;
  allStates: EoState[];
  onClose: () => void;
  onNavigate: (target: string) => void;
}) {
  const loadView = useBuilderStore((s) => s.loadView);

  // Find a record page view whose recordSource.scope matches this record's parent
  const recordPageView = useMemo(() => {
    const parts = recordTarget.split('.');
    const possibleScopes: string[] = [];
    for (let i = parts.length - 1; i >= 1; i--) {
      possibleScopes.push(parts.slice(0, i).join('.'));
    }

    const viewStates = allStates.filter(s => s.target.startsWith('views.'));
    for (const vs of viewStates) {
      const def = vs.value as ViewDefinition | null;
      if (def?.pageType === 'record' && def.recordSource?.scope) {
        if (possibleScopes.includes(def.recordSource.scope)) {
          const viewId = vs.target.replace(/^views\./, '');
          return { viewId, definition: def };
        }
      }
    }
    return null;
  }, [recordTarget, allStates]);

  // Load the record page view into the builder store when found
  useEffect(() => {
    if (recordPageView) {
      loadView(recordPageView.viewId, recordPageView.definition);
    }
  }, [recordPageView, loadView]);

  // If we have a matching record page, render RecordPageView in a panel
  if (recordPageView) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex',
        justifyContent: 'flex-end', zIndex: 1000,
        background: 'rgba(0,0,0,0.3)',
      }} onClick={onClose}>
        <div style={{
          width: 720, maxWidth: '100vw', height: '100vh',
          background: 'var(--bg, #fff)',
        }} onClick={e => e.stopPropagation()}>
          <RecordPageView
            recordTarget={recordTarget}
            onNavigate={onNavigate}
            onBack={onClose}
          />
        </div>
      </div>
    );
  }

  // Fallback to default drawer
  return (
    <RecordDetailDrawer
      target={recordTarget}
      onClose={onClose}
      onNavigate={onNavigate}
    />
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
      transition: 'background 0.3s ease',
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
      transition: 'background 0.3s ease',
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
    navDivider: {
      height: 1,
      margin: '4px 16px',
      background: t.border,
      opacity: 0.5,
    },

    // Body
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 200,
      borderRight: `0.5px solid ${t.border}`,
      background: t.bgCard,
      display: 'flex',
      flexDirection: 'column' as const,
      transition: 'background 0.3s ease',
    },
    main: { flex: 1, overflowY: 'auto' as const, overflow: 'hidden', display: 'flex', flexDirection: 'column' as const, background: t.bg, transition: 'background 0.3s ease' },

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
