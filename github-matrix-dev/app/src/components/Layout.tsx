import { useState, useEffect, useRef, useMemo } from 'react';
import { logout, createMatrixClient, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { createIdb, deleteAllEoDatabases } from '../db/idb';
import { createStore } from '../db/encrypted-store';
import { deriveKey } from '../lib/crypto';
import { SyncManager } from '../matrix/sync-manager';
import { FilenSyncService } from '../filen/filen-sync';
import { useFilenStore } from '../filen/filen-store';
import { resolveDataRoom } from '../matrix/event-bridge';
import { configureMatrixDomain } from '../lib/matrix-domain';
import { HolonNav } from './HolonNav';
import { TableView } from './TableView';
import { ViewTabs } from './ViewTabs';
import { RecordDetailDrawer } from './RecordDetailDrawer';
import { RecordView } from './RecordView';
import { ConnectionStatus, useConnectionState, type ConnectionState } from './ConnectionStatus';
import { SyncToast, useSyncToast } from './SyncToast';
import { ErrorBoundary } from './ErrorBoundary';
import { SyncProgress } from './SyncProgress';
import { LogView } from './LogView';
import { ComposeView } from './ComposeView';
import { GraphView } from './GraphView';
import { SettingsView } from './SettingsView';
import { SpaceMembers } from './SpaceMembers';
import { ImportView } from './ImportView';
import { BuilderView } from './builder/BuilderView';
import { MessagesView } from './MessagesView';
import { RecordPageView } from './builder/RecordPageView';
import { PermissionBadge } from './PermissionBadge';
import { ViewOnlyBanner } from './ViewOnlyBanner';
import { useViewStore } from '../store/view-store';
import { useBuilderStore } from '../store/builder-store';
import { useSyncStore } from '../store/sync-store';
import { useTheme, spaceBackgroundTint, type Theme } from '../theme';
import type { EoState } from '../db/types';
import type { ViewDefinition } from '../blocks/types';
import type { ViewType } from './view-types';
import { discoverSpacesFromMatrix, type SpaceEntry } from '../matrix/space-discovery';
import { SpaceBrowser } from './SpaceBrowser';
import { Horizon } from './Horizon';
import { type TimeScrubberFilter, type DateColumnOption, DEFAULT_FILTER, detectDateColumns } from './time-scrubber-utils';
import { hasFieldsSubObject, buildFieldNameMap } from './filter-types';
import { useHashRoute, type View } from '../lib/router';
import { type AccessRole, powerLevelToRole, legacyAccessToRole } from '../permissions/types';
import { resolvePermissionsFromSharing } from '../permissions/resolve';
import { RecycleBin, addDeletedSpace, isSpaceDeleted, removeDeletedSpace, getDeletedSpaces } from './RecycleBin';
import { addArchivedSpace, isSpaceArchived, removeArchivedSpace, getArchivedSpaces } from './ArchivedSpaces';
import { setSpaceConfig, applyEoPowerLevels } from '../permissions/room-topology';
import { EO_POWER_LEVEL_CONTENT } from '../permissions/types';

/** Set to false to disable all Matrix activity (sync, room creation, discovery).
 *  When false, the app uses Filen as the sole sync layer. */
const MATRIX_ENABLED = true;

/**
 * Create a Matrix room for a space and publish the space config state event.
 * Returns the new room ID, or null if creation fails.
 */
async function createSpaceRoom(
  client: ReturnType<typeof createMatrixClient>,
  spaceName: string,
  ownerUserId: string,
): Promise<string | null> {
  try {
    const result = await client.createRoom({
      name: spaceName,
      visibility: 'private' as any,
      preset: 'private_chat' as any,
      initial_state: [
        {
          type: 'm.room.history_visibility',
          state_key: '',
          content: { history_visibility: 'shared' },
        },
        {
          type: 'm.room.power_levels',
          state_key: '',
          content: {
            ...EO_POWER_LEVEL_CONTENT,
            users: { [ownerUserId]: 100 },
          },
        },
      ],
    });

    const roomId = result.room_id;

    // Publish space config so discoverSpacesFromMatrix() can find this room
    await setSpaceConfig(client, roomId, {
      name: spaceName,
      rooms: { main: roomId },
      field_assignments: [],
      space_settings: {},
    });

    console.info('[EO-DB] Created Matrix room for space', spaceName, '→', roomId);
    return roomId;
  } catch (e) {
    console.warn('[EO-DB] Failed to create Matrix room for space', spaceName, e);
    return null;
  }
}

/** Normalize any space target to canonical "space_foo" format (strips IDB "space." prefix) */
function normalizeSpaceTarget(target: string): string {
  if (target.startsWith('space.')) return `space_${target.slice(6)}`;
  return target;
}

function formatSpaceName(segment: string): string {
  // Strip common prefixes, replace underscores with spaces, capitalize
  let name = segment.replace(/^space_/, '');
  name = name.replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

interface LayoutProps {
  session: MatrixSession;
  onLogout: () => void;
  localMode?: boolean;
}

interface CachedSpace {
  store: ReturnType<typeof createStore>;
  syncManager: SyncManager | null;
  filenSync: FilenSyncService | null;
  mainRoomId: string | null;
}

export function Layout({ session, onLogout, localMode }: LayoutProps) {
  const init = useEoStore((s) => s.init);
  const teardown = useEoStore((s) => s.teardown);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const recentEvents = useEoStore((s) => s.recentEvents);
  const { route, navigate } = useHashRoute();
  const activeView = route.view;
  const selectedScope = route.scope;
  const selectedRecord = route.record;
  const [selectedSpace, setSelectedSpace] = useState<string | null>(() => {
    // Restore last selected space from localStorage
    const saved = localStorage.getItem('eo-selected-space');
    if (!saved) return null;
    // Normalize legacy "space.foo" format to canonical "space_foo"
    return normalizeSpaceTarget(saved);
  });
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [spaces, setSpaces] = useState<EoState[]>([]);
  const [spaceEntries, setSpaceEntries] = useState<SpaceEntry[]>([]);
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const [timeScrubberFilter, setTimeScrubberFilter] = useState<TimeScrubberFilter>(DEFAULT_FILTER);
  const [scopedRecords, setScopedRecords] = useState<EoState[]>([]);
  const [scopeFieldNameMap, setScopeFieldNameMap] = useState<Map<string, string>>(new Map());
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const _browserOnline = useConnectionState(); // triggers re-render on network change
  const syncManager = useEoStore((s) => s.syncManager);
  const [syncToastStatus, syncToastSeq, onSyncStatus] = useSyncToast();
  const [matrixReady, setMatrixReady] = useState(false);
  // Show actual sync status: "online" only when Matrix sync is connected.
  // When Matrix is disabled, show "local" (data works, just no remote sync).
  const connectionState: ConnectionState = !navigator.onLine
    ? 'offline'
    : (!MATRIX_ENABLED || localMode)
      ? 'local'
      : syncManager
        ? 'online'
        : matrixReady
          ? 'syncing'
          : 'offline';

  // Helper to select a space and persist the choice
  function selectSpace(target: string) {
    const canonical = normalizeSpaceTarget(target);
    setSelectedSpace(canonical);
    localStorage.setItem('eo-selected-space', canonical);
    // Clear route state when switching spaces
    navigate({ scope: null, record: null, view: 'records', builderViewId: null, customPageId: null });
  }
  // Soft-delete a space: hide from list, track in recycle bin
  function handleDeleteSpace(spaceTarget: string) {
    const entry = mergedEntries.find((e) => e.spaceTarget === spaceTarget);
    addDeletedSpace({
      target: spaceTarget,
      name: entry?.displayName || formatSpaceName(spaceTarget.split('.').pop() || ''),
      deletedAt: Date.now(),
      deletedBy: session.userId,
      memberCount: entry?.memberCount || 0,
    });
    if (selectedSpace === spaceTarget) {
      const remaining = mergedEntries.filter((e) => e.spaceTarget !== spaceTarget && !isSpaceDeleted(e.spaceTarget));
      if (remaining.length > 0) {
        selectSpace(remaining[0].spaceTarget);
      } else {
        setSelectedSpace(null);
        localStorage.removeItem('eo-selected-space');
      }
    }
    // Force re-render
    setSpaces([...spaces]);
    setSpaceEntries([...spaceEntries]);
  }

  // Restore a space from the recycle bin
  function handleRestoreSpace(target: string) {
    removeDeletedSpace(target);
    setSpaces([...spaces]);
    setSpaceEntries([...spaceEntries]);
    selectSpace(target);
    setShowRecycleBin(false);
  }

  // Archive a space: hide from browser, viewable in Settings
  function handleArchiveSpace(spaceTarget: string) {
    const entry = mergedEntries.find((e) => e.spaceTarget === spaceTarget);
    addArchivedSpace({
      target: spaceTarget,
      name: entry?.displayName || formatSpaceName(spaceTarget.split('.').pop() || ''),
      archivedAt: Date.now(),
      archivedBy: session.userId,
      memberCount: entry?.memberCount || 0,
    });
    if (selectedSpace === spaceTarget) {
      const remaining = mergedEntries.filter((e) => e.spaceTarget !== spaceTarget && !isSpaceDeleted(e.spaceTarget) && !isSpaceArchived(e.spaceTarget));
      if (remaining.length > 0) {
        selectSpace(remaining[0].spaceTarget);
      } else {
        setSelectedSpace(null);
        localStorage.removeItem('eo-selected-space');
      }
    }
    setSpaces([...spaces]);
    setSpaceEntries([...spaceEntries]);
  }

  // Unarchive a space from settings
  function handleUnarchiveSpace(target: string) {
    removeArchivedSpace(target);
    setSpaces([...spaces]);
    setSpaceEntries([...spaceEntries]);
    selectSpace(target);
  }

  // Permanently delete a space's local IndexedDB data
  async function handlePermanentDelete(target: string) {
    const cached = spaceCacheRef.current.get(target);
    if (cached) {
      cached.store.close();
      spaceCacheRef.current.delete(target);
    }
    const dbName = `eo-db::${target}`;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }

  const { theme, toggleTheme } = useTheme();
  const spaceTint = spaceBackgroundTint(selectedSpace, theme.mode);
  const themedBg = spaceTint ? { ...theme, bg: spaceTint.bg, bgCard: spaceTint.bgCard, bgMuted: spaceTint.bgMuted } : theme;
  const s = makeStyles(themedBg);

  // Load all states — each space has its own isolated IDB, no prefix needed
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('').then(setAllStates);
  }, [ready, lastSeq, getStateByPrefix]);

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

  // Detect leaf scope: scope has its own state but no child records.
  // In this case we show the scope itself as a record instead of an empty table.
  const isLeafScope = useMemo(() => {
    if (!selectedScope) return false;
    // A leaf scope has no direct children in allStates
    const prefix = selectedScope + '.';
    const scopeDepth = selectedScope.split('.').length;
    const hasChildren = allStates.some((st) => {
      if (!st.target.startsWith(prefix)) return false;
      if (st.value?._alias) return false;
      const seg = st.target.split('.').pop();
      if (seg?.startsWith('_')) return false;
      return st.target.split('.').length === scopeDepth + 1;
    });
    if (hasChildren) return false;
    // Check that the scope itself has state data
    return allStates.some((st) => st.target === selectedScope && st.value && !st.value._alias);
  }, [selectedScope, allStates]);

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

  useEffect(() => {
    if (!MATRIX_ENABLED || localMode) return; // Matrix disabled or local-only — no client, no sync loop

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

        // MatrixRTC (VoIP/calls) is not used by EO-DB. Stop it *after* initial
        // sync — stopping before startClient() is ineffective because the sync
        // loop re-registers its listeners during processSyncResponse.
        try {
          client.matrixRTC?.stop();
        } catch { /* older SDK — safe to ignore */ }

        // Room resolution is best-effort — app works without it
        try {
          roomIdRef.current = await resolveDataRoom(client);
        } catch (e) {
          // Expected when no root data room exists — per-space rooms are used instead.
          // Debug-level only to avoid console noise on every startup.
        }

        setMatrixReady(true);
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
      setMatrixReady(false);
    };
  }, [session]);

  // --- Space discovery (re-runs when Matrix becomes ready) ---
  useEffect(() => {
    // In local mode, the store is already initialized — just set a default space
    if (localMode) {
      const now = new Date().toISOString();
      const localSpace: EoState = {
        target: 'space_local',
        value: { name: 'Local' },
        level: 1,
        hash: '',
        last_seq: 0,
        last_op: 'INS',
        last_agent: '@local:localhost',
        last_ts: now,
        last_acquired_ts: now,
      };
      setSpaces([localSpace]);
      if (selectedSpace === null) selectSpace('space_local');
      return;
    }

    let mounted = true;

    async function discoverSpaces() {
      // Check localStorage cache first — show UI immediately from cache
      const cached = localStorage.getItem('eo-spaces');
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as EoState[];
          if (parsed.length > 0) {
            setSpaces(parsed);
            if (selectedSpace === null) selectSpace(parsed[0].target);
          }
        } catch { /* ignore bad cache */ }
      }

      // Open root IDB to discover spaces from store data
      const idb = await createIdb();
      const key = await deriveKey(session.userId, session.deviceId);
      const rootStore = createStore(idb, key);

      // If root store is empty, try hydrating from Matrix snapshot
      const rootSeq = await rootStore.getCurrentSeq();
      if (rootSeq === 0 && matrixReady && matrixClientRef.current && roomIdRef.current) {
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
        if (selectedSpace === null) selectSpace(spaceRoots[0].target);
      }

      rootStore.close();
    }

    discoverSpaces();
    return () => { mounted = false; };
  }, [session, matrixReady]);

  // --- Matrix room-based space discovery (supplements IDB) ---
  useEffect(() => {
    if (!matrixReady || !matrixClientRef.current) return;
    try {
      const entries = discoverSpacesFromMatrix(matrixClientRef.current);
      if (entries.length > 0) {
        setSpaceEntries(entries);
      }
    } catch { /* best effort */ }
  }, [matrixReady]);

  // Build merged entries: Matrix-sourced entries + IDB fallback for spaces not found in Matrix
  const mergedEntries = useMemo<SpaceEntry[]>(() => {
    if (spaceEntries.length > 0) return spaceEntries;
    // Offline fallback: adapt IDB-sourced spaces to SpaceEntry shape
    return spaces.map((sp) => {
      const name = sp.value?.name || formatSpaceName(sp.target.split('.').pop() || '');
      return {
        spaceTarget: normalizeSpaceTarget(sp.target),
        displayName: name,
        mainRoomId: '',
        createdAt: sp.last_ts ? new Date(sp.last_ts).getTime() : 0,
        lastActivity: sp.last_ts ? new Date(sp.last_ts).getTime() : 0,
        ownerUserId: sp.last_agent || '',
        ownerDisplayName: sp.last_agent
          ? (sp.last_agent.startsWith('@') ? sp.last_agent.slice(1).split(':')[0] : sp.last_agent)
          : 'Unknown',
        memberCount: (sp.value?._sharing || []).length + 1,
      };
    });
  }, [spaceEntries, spaces]);

  // Filter out soft-deleted spaces from the browser entries
  const activeEntries = useMemo(() => mergedEntries.filter((e) => !isSpaceDeleted(e.spaceTarget) && !isSpaceArchived(e.spaceTarget)), [mergedEntries, spaces, spaceEntries]);
  const deletedSpaceCount = getDeletedSpaces().length;
  const archivedSpaceCount = getArchivedSpaces().length;

  // --- Reset stale state when switching spaces ---
  const prevSpaceRef = useRef(selectedSpace);
  useEffect(() => {
    if (prevSpaceRef.current !== selectedSpace) {
      // Destroy old SyncManager listener before switching
      const oldSyncManager = useEoStore.getState().syncManager;
      if (oldSyncManager) {
        oldSyncManager.destroy();
      }

      // Stop old Filen sync
      if (prevSpaceRef.current) {
        const oldCached = spaceCacheRef.current.get(prevSpaceRef.current);
        if (oldCached?.filenSync) {
          oldCached.filenSync.stop();
        }
      }

      prevSpaceRef.current = selectedSpace;
      // Clear Layout-level state so old space data doesn't flash
      setAllStates([]);
      setScopedRecords([]);
      setScopeFieldNameMap(new Map());
      setShowMembers(false);
      setShowRecycleBin(false);
      // Reset builder store so old space's views don't persist
      useBuilderStore.getState().reset();
      // Reset sync store so old space's peer/snapshot data doesn't persist
      useSyncStore.getState().reset();
    }
  }, [selectedSpace]);

  // --- Cached space stores (survive space switches, avoid re-init) ---
  const spaceCacheRef = useRef<Map<string, CachedSpace>>(new Map());

  // --- Per-space store init (re-runs when selectedSpace changes) ---
  useEffect(() => {
    if (!selectedSpace) return;
    // In local mode, the store is already initialized via initLocal() — skip
    if (localMode) return;

    let mounted = true;
    const cleanupFns: (() => void)[] = [];

    async function resolveOrCreateRoom(): Promise<string | null> {
      // When Matrix is disabled, skip all room resolution — local-only mode.
      if (!MATRIX_ENABLED) return null;

      // 0. Check the space cache first (handles freshly-created spaces
      //    whose state events haven't synced to the SDK yet)
      const cached = spaceCacheRef.current.get(selectedSpace!);
      if (cached?.mainRoomId) return cached.mainRoomId;

      // 1. Try the space's own mainRoomId from discovery
      const spaceEntry = mergedEntries.find((e) => e.spaceTarget === selectedSpace);
      if (spaceEntry?.mainRoomId) return spaceEntry.mainRoomId;

      // 2. Fall back to the root data room alias
      if (roomIdRef.current) return roomIdRef.current;

      // 3. Create a new Matrix room for this space if client is ready
      if (matrixReady && matrixClientRef.current) {
        const displayName = formatSpaceName(selectedSpace!.replace(/^space_/, ''));
        const newRoomId = await createSpaceRoom(
          matrixClientRef.current, displayName, session.userId,
        );
        if (newRoomId) {
          // Re-run space discovery so the new room appears in the browser
          try {
            const entries = discoverSpacesFromMatrix(matrixClientRef.current);
            if (entries.length > 0) setSpaceEntries(entries);
          } catch { /* best effort */ }
          return newRoomId;
        }
      }

      console.warn('[EO-DB] No room ID for space', selectedSpace, '— Matrix sync disabled.');
      return null;
    }

    const onFoldEvent = (event: any) => {
      useEoStore.setState((st) => ({
        recentEvents: [...st.recentEvents.slice(-99), event],
        lastSeq: event.seq,
      }));
    };

    async function setupSpaceStore() {
      const cache = spaceCacheRef.current;
      const existing = cache.get(selectedSpace!);

      const spaceRoomId = await resolveOrCreateRoom();

      if (existing) {
        // Reuse cached store — no IDB open, no key derivation, no Matrix hydration
        if (!mounted) return;
        await init(existing.store);

        // Restore cached sync manager
        if (existing.syncManager) {
          useEoStore.getState().setSyncManager(existing.syncManager);
        }

        // Restart Filen sync for cached space
        if (existing.filenSync) {
          existing.filenSync.start().catch(e =>
            console.warn('[EO-DB] Filen sync restart failed for cached space', selectedSpace, e),
          );
          useEoStore.getState().setFilenSync(existing.filenSync);
        }
        return;
      }

      // Open space-scoped IDB with stable key (userId + deviceId, no accessToken)
      const idb = await createIdb(selectedSpace!);
      const key = await deriveKey(session.userId, session.deviceId);
      const store = createStore(idb, key);
      if (!mounted) { store.close(); return; }

      await init(store);

      // Detect Filen org-mode from room state BEFORE starting sync layers.
      // When org-mode is active, Filen is the primary data store and we
      // skip Matrix SyncManager (which would send data via timeline events).
      let filenOrgMode = false;
      const filenState = useFilenStore.getState();
      if (!filenState.connected && matrixClientRef.current && spaceRoomId) {
        const room = matrixClientRef.current.getRoom(spaceRoomId);
        if (room) {
          const configEvent = room.currentState.getStateEvents('eo.filen.config' as any, '');
          if (configEvent) {
            const config = (configEvent as any).getContent?.() ?? configEvent;
            if (config.apiKey && config.masterKey) {
              try {
                await useFilenStore.getState().restoreFromRoomState({
                  email: config.email,
                  apiKey: config.apiKey,
                  masterKey: config.masterKey,
                  baseFolderUuid: config.baseFolderUuid,
                  eodbFolderUuid: config.eodbFolderUuid,
                });
                filenOrgMode = true;
                console.log('[EO-DB] Org-mode Filen auto-connected from room state');
              } catch (e) {
                console.warn('[EO-DB] Org-mode Filen auto-connect failed:', e);
              }
            }
          }
        }
      }
      // Listen for eo.filen.config room state updates so that when the admin
      // re-saves credentials (e.g. after session expiry), all clients auto-reconnect.
      if (matrixClientRef.current && spaceRoomId) {
        const handleRoomStateEvent = (event: any) => {
          if (
            event.getType?.() === 'eo.filen.config' &&
            event.getRoomId?.() === spaceRoomId
          ) {
            const config = event.getContent?.() ?? {};
            if (config.apiKey && config.masterKey) {
              console.log('[EO-DB] eo.filen.config updated — auto-reconnecting Filen');
              useFilenStore.getState().restoreFromRoomState({
                email: config.email,
                apiKey: config.apiKey,
                masterKey: config.masterKey,
                baseFolderUuid: config.baseFolderUuid,
                eodbFolderUuid: config.eodbFolderUuid,
              }).catch(e => console.warn('[EO-DB] Filen auto-reconnect from state update failed:', e));
            }
          }
        };
        matrixClientRef.current.on('RoomState.events' as any, handleRoomStateEvent);
        // Store handler for cleanup
        cleanupFns.push(() => {
          matrixClientRef.current?.removeListener('RoomState.events' as any, handleRoomStateEvent);
        });
      }

      // Also check if Filen is already in org-mode (from a previous space switch)
      if (useFilenStore.getState().isOrgMode) filenOrgMode = true;

      // Start Matrix sync if we have a room AND Filen org-mode is NOT active.
      // In org-mode, Filen handles all data persistence — Matrix is signals only.
      let syncManager: SyncManager | null = null;
      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current && !filenOrgMode) {
        try {
          syncManager = new SyncManager(
            matrixClientRef.current,
            spaceRoomId,
            store,
            onFoldEvent,
          );
          await syncManager.initialize();
          if (!mounted) { syncManager.destroy(); return; }
          useEoStore.getState().setSyncManager(syncManager);
        } catch (e) {
          console.warn('[EO-DB] Matrix sync initialization failed for space', selectedSpace, e);
          syncManager = null;
        }
      }

      // Start Filen sync (primary data store layer)
      let filenSync: FilenSyncService | null = null;

      // Now start Filen sync if connected (either org-mode or personal)
      const filenStateNow = useFilenStore.getState();
      if (filenStateNow.connected && selectedSpace) {
        try {
          // Find the space name from the merged entries
          const spaceEntry = mergedEntries.find(e => {
            const target = 'canonical' in e ? (e as any).canonical : (e as any).target;
            return target === selectedSpace;
          });
          const spaceName = spaceEntry ? ((spaceEntry as any).name || selectedSpace) : selectedSpace;

          const spaceFolderUuid = await filenStateNow.ensureSpaceFolder(selectedSpace, spaceName);

          // On fresh device (seq=0), hydrate from Filen before starting sync timer
          const currentSeq = await store.getCurrentSeq();
          if (currentSeq === 0) {
            try {
              const hydratedSeq = await FilenSyncService.hydrateFromFilen(store, spaceFolderUuid, onFoldEvent);
              if (hydratedSeq > 0) {
                await init(store);
              }
            } catch (e) {
              console.warn('[EO-DB] Filen hydration failed for space', selectedSpace, e);
            }
          }

          filenSync = new FilenSyncService({
            store,
            spaceId: selectedSpace,
            spaceName,
            spaceFolderUuid,
            userId: session.userId,
            matrixClient: matrixClientRef.current || undefined,
            roomId: spaceRoomId || undefined,
          });
          await filenSync.start();
          useEoStore.getState().setFilenSync(filenSync);
        } catch (e) {
          console.warn('[EO-DB] Filen sync start failed for space', selectedSpace, e);
          filenSync = null;
        }
      }

      // Cache this space's store + sync manager for fast re-access
      cache.set(selectedSpace!, { store, syncManager, filenSync, mainRoomId: spaceRoomId });
    }

    setupSpaceStore();

    return () => {
      mounted = false;
      cleanupFns.forEach(fn => fn());
    };
  }, [selectedSpace, session, init, matrixReady, mergedEntries]);

  async function handleLogout() {
    // Save snapshots for ALL cached spaces before clearing state
    const cache = spaceCacheRef.current;
    const savePromises: Promise<void>[] = [];
    for (const [, cached] of cache) {
      if (cached.syncManager) {
        savePromises.push(cached.syncManager.saveSnapshot().catch((err) => {
              console.warn('[EO-DB] Snapshot save failed:', err);
            }));
      }
      if (cached.filenSync) {
        savePromises.push(cached.filenSync.forceSave().catch((err) => {
              console.warn('[EO-DB] Filen save failed:', err);
            }));
      }
    }
    await Promise.all(savePromises);

    // Stop all Filen sync and close all cached stores
    for (const [, cached] of cache) {
      if (cached.filenSync) cached.filenSync.stop();
      cached.store.close();
    }
    cache.clear();

    teardown();
    logout();

    // Delete all eo-db IndexedDB databases so stale content doesn't
    // persist across sign-out / account switches.
    await deleteAllEoDatabases();

    onLogout();
  }

  // Save all cached space snapshots when the page is hidden or unloaded.
  // visibilitychange fires reliably when switching tabs/browsers/closing,
  // unlike beforeunload which can't await async work.
  useEffect(() => {
    let snapshotInFlight = false;

    const saveAllSnapshots = async () => {
      if (snapshotInFlight) return;
      snapshotInFlight = true;
      try {
        const promises: Promise<void>[] = [];
        for (const [, cached] of spaceCacheRef.current) {
          if (cached.syncManager) {
            promises.push(cached.syncManager.saveSnapshot().catch((err) => {
              console.warn('[EO-DB] Snapshot save failed:', err);
            }));
          }
          if (cached.filenSync) {
            promises.push(cached.filenSync.forceSave().catch((err) => {
              console.warn('[EO-DB] Filen save failed:', err);
            }));
          }
        }
        await Promise.all(promises);
      } finally {
        snapshotInFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        saveAllSnapshots();
      }
    };

    // beforeunload can't await — fire-and-forget is the best we can do there.
    // visibilitychange ('hidden') is the reliable path for saving snapshots.
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', () => { saveAllSnapshots(); });
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Extract display name from Matrix user ID
  const displayName = session.userId.startsWith('@')
    ? session.userId.slice(1).split(':')[0]
    : session.userId;

  const NAV_ICONS: Record<string, string> = {
    records: '\u25A6',  // grid icon
    log: '\u2630',      // list icon
    graph: '\u2B21',    // hexagon
    compose: '\u270E',  // pencil
    import: '\u2B07',   // download arrow
    builder: '\u2B1A',  // blocks
    settings: '\u2699', // gear
    messages: '\uD83D\uDCAC', // speech bubble
  };

  // --- Permission resolution ---
  const currentSpaceState = useMemo(() => {
    return spaces.find(s => normalizeSpaceTarget(s.target) === selectedSpace);
  }, [spaces, selectedSpace]);
  const currentPermissions = useMemo(() => {
    if (!currentSpaceState) {
      // No space state found — if a space is selected, treat current user as owner
      // (new space created locally, or offline with no cached state)
      if (selectedSpace) {
        return resolvePermissionsFromSharing(session.userId, session.userId, [], []);
      }
      return null;
    }
    const owner = currentSpaceState.last_agent;
    const sharing = currentSpaceState.value?._sharing || [];
    const fieldAssignments = currentSpaceState.value?._field_assignments || [];
    return resolvePermissionsFromSharing(session.userId, owner, sharing, fieldAssignments);
  }, [currentSpaceState, session.userId, selectedSpace]);
  const currentRole: AccessRole = currentPermissions?.role ?? 'viewer';
  const isViewer = currentRole === 'viewer';

  // Determine active view type from saved view
  const viewStore = useViewStore();
  const activeViewType: ViewType = useMemo(() => {
    if (!selectedScope) return 'grid';
    const sig = viewStore.getSig(selectedScope);
    if (!sig.activeViewId) return 'grid';
    const sv = viewStore.savedViews[sig.activeViewId];
    return sv?.viewType || 'grid';
  }, [selectedScope, viewStore]);

  return (
    <div style={s.container}>
      {/* Top bar */}
      <header style={s.topBar}>
        <div style={s.topBarLeft}>
          <span style={s.logo}>
            <span style={{ color: theme.success }}>EO</span>
            <span style={{ color: theme.borderLight, opacity: 0.5 }}>///</span>
            <span style={{ color: theme.textHeading }}>DB</span>
          </span>

          <div style={s.divider} />

          {/* Space selector — opens file-browser panel */}
          <button
            onClick={() => setSpaceOpen(!spaceOpen)}
            style={s.spaceBadge}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: theme.accent, flexShrink: 0 }} />
            {selectedSpace
              ? formatSpaceName(selectedSpace.split('.').pop() || '')
              : 'All Spaces'}
            <span style={{ fontSize: 8, opacity: 0.5, marginLeft: 2 }}>{spaceOpen ? '\u25B4' : '\u25BE'}</span>
          </button>

          {spaceOpen && (
            <SpaceBrowser
              entries={activeEntries}
              loading={MATRIX_ENABLED && !matrixReady && activeEntries.length === 0}
              activeSpace={selectedSpace}
              onSelect={(target) => {
                selectSpace(target);
                setSpaceOpen(false);
                setShowMembers(false);
                setShowRecycleBin(false);
              }}
              onClose={() => setSpaceOpen(false)}
              onCreate={async (name) => {
                const spaceTarget = `space_${name.toLowerCase().replace(/\s+/g, '_')}`;

                // Create Matrix room first (if client is ready) so sync works immediately
                let mainRoomId: string | null = null;
                if (matrixReady && matrixClientRef.current) {
                  mainRoomId = await createSpaceRoom(
                    matrixClientRef.current, name, session.userId,
                  );
                  // Refresh space entries so the new room is discoverable
                  if (mainRoomId) {
                    try {
                      const entries = discoverSpacesFromMatrix(matrixClientRef.current);
                      if (entries.length > 0) setSpaceEntries(entries);
                    } catch { /* best effort */ }
                  }
                }

                // Initialize the space store before dispatching so store is not null
                const idb = await createIdb(spaceTarget);
                const key = await deriveKey(session.userId, session.deviceId);
                const spaceStore = createStore(idb, key);
                await init(spaceStore);

                // Matrix sync disabled — events fold locally, Filen handles sync

                // Cache it so setupSpaceStore reuses it instead of re-opening
                spaceCacheRef.current.set(spaceTarget, { store: spaceStore, syncManager: null, filenSync: null, mainRoomId });

                // Now dispatch is safe — store is initialized (and sync will send to Matrix)
                const dispatch = useEoStore.getState().dispatch;
                await dispatch({
                  op: 'INS',
                  target: spaceTarget,
                  operand: { name },
                  agent: session.userId,
                  ts: new Date().toISOString(),
                  acquired_ts: new Date().toISOString(),
                });

                // Add to spaces list with correct owner so permissions resolve
                const now = new Date().toISOString();
                const idbTarget = `space.${name.toLowerCase().replace(/\s+/g, '_')}`;
                setSpaces((prev) => [...prev, {
                  target: idbTarget,
                  value: { name },
                  level: 1,
                  last_seq: 1,
                  last_op: 'INS',
                  last_agent: session.userId,
                  last_ts: now,
                  last_acquired_ts: now,
                } as EoState]);

                // Register space in root IDB so it survives page reload without Matrix
                const rootIdb = await createIdb();
                const rootKey = await deriveKey(session.userId, session.deviceId);
                const rootSt = createStore(rootIdb, rootKey);
                const { setState: setRootState } = await import('../db/state');
                await setRootState(rootSt, {
                  target: idbTarget,
                  value: { name },
                  level: 1,
                  last_seq: 1,
                  last_op: 'INS',
                  last_agent: session.userId,
                  last_ts: now,
                  last_acquired_ts: now,
                } as EoState);
                rootSt.close();

                selectSpace(spaceTarget);
                setSpaceOpen(false);
              }}
              onDelete={handleDeleteSpace}
              onArchive={handleArchiveSpace}
              onOpenRecycleBin={() => { setShowRecycleBin(true); setSpaceOpen(false); setShowMembers(false); }}
              deletedCount={deletedSpaceCount}
              archivedCount={archivedSpaceCount}
            />
          )}

          {/* Members button */}
          {selectedSpace && (
            <button
              onClick={() => setShowMembers(!showMembers)}
              style={{
                ...s.headerButton,
                ...(showMembers ? { background: theme.accent, color: '#fff' } : {}),
              }}
              title="Space members"
            >
              {'\u2B24'} {/* circle for avatar hint */}
              <span style={{ fontSize: 11 }}>Members</span>
            </button>
          )}
        </div>

        <div style={s.topBarRight}>
          {/* Stats — compact, subtle */}
          <div style={s.stats}>
            <span title="Sequence number">{lastSeq} seq</span>
            <span style={s.statSep}>{'\u00B7'}</span>
            <span title="Event count">{recentEvents.length} events</span>
            <span style={s.statSep}>{'\u00B7'}</span>
            <span title="Target count">{targetCount} targets</span>
          </div>
          <ConnectionStatus state={connectionState} />
          <SyncToast status={syncToastStatus} seq={syncToastSeq} />
          {selectedSpace && (
            <PermissionBadge role={currentRole} displayName={displayName} />
          )}
          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            style={s.headerIconButton}
            title={theme.mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          >
            {theme.mode === 'light' ? '\u263E' : '\u2600'}
          </button>
          {/* User */}
          <div style={s.userArea}>
            <div style={s.avatar}>{displayName.charAt(0).toUpperCase()}</div>
            <span style={{ fontSize: 12, color: theme.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
          </div>
          <button onClick={handleLogout} style={s.logoutButton}>Log out</button>
        </div>
      </header>

      {/* View-only banner for Viewer role */}
      {selectedSpace && isViewer && <ViewOnlyBanner />}

      {/* Horizon — full width, under header */}
      {activeView === 'records' && (
        <Horizon
          records={scopedRecords}
          dateColumns={dateColumns}
          filter={timeScrubberFilter}
          onFilterChange={setTimeScrubberFilter}
        />
      )}

      {/* Body */}
      <div style={s.body}>
        <aside style={s.sidebar}>
          {/* View navigation */}
          <nav style={s.sidebarNav}>
            <div style={s.navGroupLabel}>Views</div>
            {(['records'] as View[]).map((view) => (
              <button
                key={view}
                onClick={() => navigate({ view })}
                style={{
                  ...s.navItem,
                  ...(activeView === view ? s.navItemActive : {}),
                }}
              >
                <span style={s.navIcon}>{NAV_ICONS[view]}</span>
                {view.charAt(0).toUpperCase() + view.slice(1)}
              </button>
            ))}
            <div style={s.navGroupLabel}>Actions</div>
            {(['compose', 'import'] as View[]).map((view) => (
              <button
                key={view}
                onClick={() => navigate({ view })}
                style={{
                  ...s.navItem,
                  ...(activeView === view ? s.navItemActive : {}),
                }}
              >
                <span style={s.navIcon}>{NAV_ICONS[view]}</span>
                {view === 'compose' ? '+ Compose' : view.charAt(0).toUpperCase() + view.slice(1)}
              </button>
            ))}
            <div style={s.navGroupLabel}>Collaborate</div>
            <button
              onClick={() => navigate({ view: 'messages' })}
              style={{
                ...s.navItem,
                ...(activeView === 'messages' ? s.navItemActive : {}),
              }}
            >
              <span style={s.navIcon}>{NAV_ICONS.messages}</span>
              Messages
            </button>
            <div style={s.navGroupLabel}>System</div>
            {/* Log */}
            <button
              onClick={() => navigate({ view: 'log' })}
              style={{
                ...s.navItem,
                ...(activeView === 'log' ? s.navItemActive : {}),
              }}
            >
              <span style={s.navIcon}>{NAV_ICONS.log}</span>
              Log
            </button>
            {/* Builder — Admin+ only (PL >= 50) */}
            {currentPermissions?.can_build_views !== false && (
              <button
                onClick={() => navigate({ view: 'builder', builderViewId: null, customPageId: null })}
                style={{
                  ...s.navItem,
                  ...(activeView === 'builder' ? s.navItemActive : {}),
                }}
              >
                <span style={s.navIcon}>{NAV_ICONS.builder}</span>
                Builder
              </button>
            )}
            {/* Settings — Admin+ only (PL >= 50) */}
            {currentPermissions?.can_set_governance !== false && (
              <button
                onClick={() => navigate({ view: 'settings' })}
                style={{
                  ...s.navItem,
                  ...(activeView === 'settings' ? s.navItemActive : {}),
                }}
              >
                <span style={s.navIcon}>{NAV_ICONS.settings}</span>
                Settings
              </button>
            )}
          </nav>

          {/* Objects tree */}
          {ready ? (
            <HolonNav
              selectedScope={selectedScope}
              onSelectScope={(scope) => { navigate({ scope, record: null }); }}
              onSelectSegment={(_scope, _seg) => { navigate({ scope: _scope }); }}
            />
          ) : !selectedSpace ? (
            <div style={{ padding: '16px 12px', fontSize: 13, color: theme.textMuted }}>
              No space selected. Open the space browser above to create or select a space.
            </div>
          ) : (
            <SyncProgress message="Initializing store..." detail="Deriving encryption key" />
          )}
        </aside>

        <main style={s.main} key={selectedSpace ?? '__all__'}>
          {/* Space members panel */}
          {showMembers && selectedSpace && (
            <div style={{ padding: '20px 28px', maxWidth: 480 }}>
              <SpaceMembers
                spaceTarget={selectedSpace}
                currentUserId={session.userId}
                onClose={() => setShowMembers(false)}
                matrixClient={matrixClientRef.current}
                mainRoomId={spaceCacheRef.current.get(selectedSpace)?.mainRoomId ?? null}
              />
            </div>
          )}

          {showRecycleBin && (
            <RecycleBin
              onRestore={handleRestoreSpace}
              onPermanentDelete={handlePermanentDelete}
              onBack={() => setShowRecycleBin(false)}
            />
          )}

          {!showRecycleBin && <ErrorBoundary>
            {activeView === 'records' ? (
              <>
                {selectedScope && isLeafScope ? (
                  <RecordView
                    target={selectedScope}
                    onNavigate={(t) => navigate({ scope: t, record: null })}
                  />
                ) : selectedScope ? (
                  <>
                    <ViewTabs scope={selectedScope} session={{ userId: session.userId }} />
                    {activeViewType === 'graph' ? (
                      <GraphView allStates={allStates} />
                    ) : activeViewType === 'grid' ? (
                      <TableView
                        scope={selectedScope}
                        onSelectRecord={(rec) => navigate({ record: rec })}
                        onEmptyScope={(parentScope) => navigate({ scope: parentScope, record: null })}
                        activeRecord={selectedRecord}
                        session={{ userId: session.userId }}
                        timeScrubberFilter={timeScrubberFilter}
                        permissions={currentPermissions}
                      />
                    ) : (
                      <div style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'column' as const, gap: 8, color: theme.textMuted,
                      }}>
                        <div style={{ fontSize: 28, opacity: 0.3 }}>
                          {activeViewType === 'kanban' ? '\u25A5' : activeViewType === 'calendar' ? '\u25F7' : '\u25A6'}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {activeViewType.charAt(0).toUpperCase() + activeViewType.slice(1)} view
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.7 }}>Coming soon</div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={s.empty}>
                    <div style={s.emptyIcon}>{'\u25A6'}</div>
                    <div style={s.emptyText}>Select an object to get started</div>
                    <div style={s.emptySub}>
                      Pick a table or collection from the sidebar to browse its records
                    </div>
                  </div>
                )}
              </>
            ) : activeView === 'log' ? (
              <LogView targetFilter={selectedScope} />
            ) : activeView === 'graph' ? (
              <GraphView allStates={allStates} />
            ) : activeView === 'import' ? (
              <ImportView onImportComplete={(scope) => navigate({ view: 'records', scope, record: null })} />
            ) : activeView === 'compose' ? (
              <ComposeView permissions={currentPermissions} />
            ) : activeView === 'builder' ? (
              <BuilderView />
            ) : activeView === 'messages' ? (
              <MessagesView scope={selectedScope} userId={session.userId} />
            ) : activeView === 'settings' ? (
              <SettingsView session={session} matrixClient={matrixClientRef.current} roomId={spaceCacheRef.current.get(selectedSpace!)?.mainRoomId ?? null} onUnarchive={handleUnarchiveSpace} />
            ) : null}
          </ErrorBoundary>}
        </main>

        {selectedRecord && activeView === 'records' && (
          <RecordPageOrDrawer
            recordTarget={selectedRecord}
            allStates={allStates}
            onClose={() => navigate({ record: null })}
            onNavigate={(t) => navigate({ record: t })}
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

  // If we have a matching record page, render RecordPageView in an inline panel
  if (recordPageView) {
    return (
      <div style={{
        width: 720, maxWidth: '50vw', height: '100%',
        flexShrink: 0, borderLeft: '1px solid var(--border, #e0e0e0)',
        background: 'var(--bg, #fff)', display: 'flex', flexDirection: 'column',
      }}>
        <RecordPageView
          recordTarget={recordTarget}
          onNavigate={onNavigate}
          onBack={onClose}
        />
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
      transition: 'background 0.25s ease',
    },

    // Top bar — taller, cleaner, less dense
    topBar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 20px',
      height: 48,
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      transition: 'background 0.25s ease',
    },
    topBarLeft: { display: 'flex', alignItems: 'center', gap: 14, minWidth: 0, overflow: 'hidden' },
    topBarRight: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexShrink: 1 },
    logo: {
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 600,
      fontSize: 15,
      letterSpacing: '-0.5px',
    },
    divider: { width: 1, height: 20, background: t.borderDivider, opacity: 0.5 },

    // Space badge — pill-shaped with dot indicator
    spaceBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: t.bgMuted,
      color: t.text,
      border: `1px solid ${t.border}`,
      borderRadius: 20,
      padding: '4px 12px 4px 10px',
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      maxWidth: 180,
      overflow: 'hidden',
      whiteSpace: 'nowrap' as const,
      textOverflow: 'ellipsis',
      flexShrink: 1,
    },
    // Header buttons
    headerButton: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      background: t.bgMuted,
      color: t.textSecondary,
      border: `1px solid ${t.border}`,
      borderRadius: 20,
      padding: '4px 12px',
      fontSize: 10,
      fontWeight: 500,
      cursor: 'pointer',
      transition: 'all 0.15s ease',
      flexShrink: 0,
      whiteSpace: 'nowrap' as const,
    },
    headerIconButton: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 30,
      height: 30,
      borderRadius: '50%',
      background: 'transparent',
      border: 'none',
      color: t.textSecondary,
      fontSize: 15,
      cursor: 'pointer',
      transition: 'background 0.15s',
    },
    logoutButton: {
      background: 'transparent',
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: '4px 10px',
      fontSize: 11,
      color: t.textSecondary,
      cursor: 'pointer',
      transition: 'all 0.15s',
    },
    userArea: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
      flexShrink: 1,
      overflow: 'hidden',
    },
    avatar: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: t.accent,
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 11,
      fontWeight: 600,
    },

    // Stats — subtle, monospace
    stats: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      whiteSpace: 'nowrap' as const,
      flexShrink: 1,
      overflow: 'hidden',
    },
    statSep: {
      opacity: 0.3,
    },

    // Sidebar navigation — cleaner with group labels
    sidebarNav: {
      display: 'flex',
      flexDirection: 'column' as const,
      padding: '8px 0 4px',
      borderBottom: `1px solid ${t.border}`,
    },
    navGroupLabel: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      letterSpacing: '0.5px',
      textTransform: 'uppercase' as const,
      padding: '10px 16px 4px',
    },
    navItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '7px 16px',
      background: 'transparent',
      border: 'none',
      borderLeft: '2px solid transparent',
      cursor: 'pointer',
      fontSize: 12,
      fontWeight: 400,
      fontFamily: "'Outfit', system-ui, sans-serif",
      color: t.textSecondary,
      textAlign: 'left' as const,
      transition: 'all 0.12s ease',
    },
    navItemActive: {
      color: t.accent,
      background: t.accentBg,
      borderLeft: `2px solid ${t.accent}`,
      fontWeight: 500,
    },
    navIcon: {
      fontSize: 12,
      width: 16,
      textAlign: 'center' as const,
      opacity: 0.7,
      flexShrink: 0,
    },

    // Body
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: {
      width: 220,
      minWidth: 160,
      borderRight: `1px solid ${t.border}`,
      background: t.bgCard,
      display: 'flex',
      flexDirection: 'column' as const,
      transition: 'background 0.25s ease',
      flexShrink: 1,
    },
    main: {
      flex: 1,
      overflowY: 'auto' as const,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column' as const,
      background: t.bg,
      transition: 'background 0.25s ease',
    },

    // Empty states — centered with icon
    empty: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      flex: 1,
      gap: 10,
      padding: 40,
    },
    emptyIcon: {
      fontSize: 36,
      color: t.textMuted,
      opacity: 0.3,
      marginBottom: 4,
    },
    emptyText: {
      fontSize: 15,
      color: t.textSecondary,
      fontWeight: 400,
    },
    emptySub: {
      fontSize: 12,
      color: t.textMuted,
      maxWidth: 280,
      textAlign: 'center' as const,
      lineHeight: 1.5,
    },
  };
}
