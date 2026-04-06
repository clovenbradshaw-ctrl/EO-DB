import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { logout, createMatrixClient, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { createIdb, deleteAllEoDatabases } from '../db/idb';
import { createStore } from '../db/encrypted-store';
import { deriveKey } from '../lib/crypto';
import { SyncManager } from '../matrix/sync-manager';
import { Presence } from '../matrix/presence';
import { OnlineUsers } from './OnlineUsers';
import { FilenSyncService } from '../filen/filen-sync';
import { useFilenStore } from '../filen/filen-store';
import { resolveDataRoom } from '../matrix/event-bridge';
import { configureMatrixDomain } from '../lib/matrix-domain';
import { HolonNav } from './HolonNav';
import { TableView } from './TableView';
import { ViewTabs } from './ViewTabs';
import { RecordDetailDrawer } from './RecordDetailDrawer';
import { RecordView } from './RecordView';
import { useIsMobile, useIsTablet, useIsNarrow } from '../hooks/useIsMobile';
import { formatName } from './scope-picker-utils';
import { ConnectionStatus, useConnectionState, type ConnectionState } from './ConnectionStatus';
import { SyncToast, useSyncToast } from './SyncToast';
import { ErrorBoundary } from './ErrorBoundary';
import { SyncProgress } from './SyncProgress';
import { LogView } from './LogView';
import { ComposeView } from './ComposeView';
import { GraphView } from './GraphView';
import { SchemaView } from './SchemaView';
import { SettingsView } from './SettingsView';
import { SpaceMembers } from './SpaceMembers';
import { ImportView } from './ImportView';
import { BuilderView } from './builder/BuilderView';
import { MessagesView } from './MessagesView';
import { PeopleView } from './PeopleView';
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
import { discoverSpacesFromMatrix, discoverPublicSpaces, type SpaceEntry } from '../matrix/space-discovery';
import { SpaceBrowser } from './SpaceBrowser';
import { Horizon } from './Horizon';
import { type TimeScrubberFilter, type DateColumnOption, DEFAULT_FILTER, detectDateColumns } from './time-scrubber-utils';
import { hasFieldsSubObject, buildFieldNameMap } from './filter-types';
import { useHashRoute, type View } from '../lib/router';
import { type AccessRole, powerLevelToRole, legacyAccessToRole } from '../permissions/types';
import { resolvePermissionsFromSharing } from '../permissions/resolve';
import { RecycleBin, addDeletedSpace, isSpaceDeleted, removeDeletedSpace, getDeletedSpaces } from './RecycleBin';
import { addArchivedSpace, isSpaceArchived, removeArchivedSpace, getArchivedSpaces } from './ArchivedSpaces';
import { setSpaceConfig, getSpaceConfig, applyEoPowerLevels, createGovernanceRoom } from '../permissions/room-topology';
import { EO_POWER_LEVEL_CONTENT } from '../permissions/types';
import { listAllHomeserverUsers } from '../matrix/user-discovery';

/** Set to false to disable all Matrix activity (sync, room creation, discovery).
 *  When false, the app uses Filen as the sole sync layer. */
const MATRIX_ENABLED = true;

export interface CreateSpaceOptions {
  /** 'public' = listed in homeserver public directory, join by knock.
   *  'private' = invite-only, not discoverable. Defaults to 'public'. */
  discoverability?: 'public' | 'private';
  /** Matrix user IDs to invite immediately upon space creation. */
  inviteUserIds?: string[];
}

/**
 * Create a Matrix room for a space and publish the space config state event.
 * Returns the new room ID, or null if creation fails.
 */
async function createSpaceRoom(
  client: ReturnType<typeof createMatrixClient>,
  spaceName: string,
  ownerUserId: string,
  opts: CreateSpaceOptions = {},
): Promise<string | null> {
  const discoverability = opts.discoverability ?? 'public';
  let inviteUserIds = opts.inviteUserIds ?? [];

  // For public spaces, auto-invite every discoverable homeserver user so
  // they receive a room invite (not just a knock-based discovery entry).
  if (discoverability === 'public') {
    try {
      const all = await listAllHomeserverUsers(client as any, 500);
      const merged = new Set<string>(inviteUserIds);
      for (const u of all) {
        if (u.userId && u.userId !== ownerUserId) merged.add(u.userId);
      }
      inviteUserIds = Array.from(merged);
    } catch (e) {
      console.warn('[EO-DB] Failed to enumerate homeserver users for public invite:', e);
    }
  }

  try {
    const initialState: any[] = [
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
    ];

    const createArgs: any = {
      name: spaceName,
      initial_state: initialState,
    };

    if (discoverability === 'public') {
      // Listed in homeserver's public room directory. Anyone not already
      // invited can still join by knocking.
      createArgs.visibility = 'public';
      initialState.push({
        type: 'm.room.join_rules',
        state_key: '',
        content: { join_rule: 'knock' },
      });
      initialState.push({
        type: 'm.room.guest_access',
        state_key: '',
        content: { guest_access: 'forbidden' },
      });
      // Also send direct invites to every discovered homeserver user so
      // they get a notification instead of having to discover+knock.
      if (inviteUserIds.length > 0) {
        createArgs.invite = inviteUserIds;
      }
    } else {
      // Private / invite-only (original behavior).
      createArgs.visibility = 'private';
      createArgs.preset = 'private_chat';
      if (inviteUserIds.length > 0) {
        createArgs.invite = inviteUserIds;
      }
    }

    let result: { room_id: string };
    try {
      result = await client.createRoom(createArgs);
    } catch (err: any) {
      // Homeserver may forbid public room creation (403). Fall back to
      // private visibility so the space is still usable.
      if (err?.httpStatus === 403 && discoverability === 'public') {
        console.warn('[EO-DB] Public room creation forbidden — falling back to private.');
        createArgs.visibility = 'private';
        createArgs.preset = 'private_chat';
        // Remove knock join rule — not valid for private rooms
        createArgs.initial_state = (createArgs.initial_state as any[]).filter(
          (s: any) => s.type !== 'm.room.join_rules' && s.type !== 'm.room.guest_access',
        );
        result = await client.createRoom(createArgs);
      } else {
        throw err;
      }
    }
    const roomId = result.room_id;

    // A space spans multiple rooms. Create the governance room eagerly so
    // admins have somewhere to publish policies / schema changes from day
    // one. The restricted room stays lazy (created on first restricted
    // field assignment) per spec. Only the owner is a member initially;
    // admins are invited when they're granted the admin role.
    let governanceRoomId: string | null = null;
    try {
      governanceRoomId = await createGovernanceRoom(client as any, spaceName, roomId);
    } catch (e) {
      console.warn('[EO-DB] Failed to create governance room for', spaceName, e);
    }

    // Publish space config so discoverSpacesFromMatrix() can find this room.
    // The config is authoritative and lists every associated room.
    const spaceConfig: any = {
      name: spaceName,
      rooms: { main: roomId, ...(governanceRoomId ? { governance: governanceRoomId } : {}) },
      field_assignments: [],
      space_settings: {},
      discoverability,
    };
    await setSpaceConfig(client, roomId, spaceConfig);
    // Mirror the config into the governance room as well so admins joining
    // via the governance room can resolve the space topology.
    if (governanceRoomId) {
      try {
        await setSpaceConfig(client, governanceRoomId, spaceConfig);
      } catch (e) {
        console.warn('[EO-DB] Failed to mirror space config to governance room:', e);
      }
    }

    // Best-effort: retry any invites that the homeserver rejected during
    // createRoom (Synapse drops invalid user IDs silently). This also
    // catches users added after the initial create.
    if (discoverability === 'public' && inviteUserIds.length > 0) {
      const room = client.getRoom?.(roomId);
      const already = new Set<string>(
        room?.getMembersWithMembership?.('invite')?.map((m: any) => m.userId) ?? [],
      );
      room?.getMembersWithMembership?.('join')?.forEach((m: any) => already.add(m.userId));
      for (const uid of inviteUserIds) {
        if (already.has(uid)) continue;
        try {
          await client.invite(roomId, uid);
        } catch (e) {
          console.warn('[EO-DB] Failed to invite', uid, 'to space', spaceName, e);
        }
      }
    }

    console.info(
      '[EO-DB] Created Matrix rooms for space', spaceName,
      '→ main:', roomId,
      governanceRoomId ? `governance: ${governanceRoomId}` : '(governance: skipped)',
      '(', discoverability, ',', inviteUserIds.length, 'invited)',
    );
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
  presence: Presence | null;
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
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isNarrow = useIsNarrow(); // mobile OR tablet
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [spaces, setSpaces] = useState<EoState[]>([]);
  const [spaceEntries, setSpaceEntries] = useState<SpaceEntry[]>([]);
  const [publicSpaceEntries, setPublicSpaceEntries] = useState<SpaceEntry[]>([]);
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const prevAllStatesKeyRef = useRef<string>('');
  const [timeScrubberFilter, setTimeScrubberFilter] = useState<TimeScrubberFilter>(DEFAULT_FILTER);
  const [scopedRecords, setScopedRecords] = useState<EoState[]>([]);
  const prevScopedRecordsKeyRef = useRef<string>('');
  const [scopeFieldNameMap, setScopeFieldNameMap] = useState<Map<string, string>>(new Map());
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const _browserOnline = useConnectionState(); // triggers re-render on network change
  const syncManager = useEoStore((s) => s.syncManager);
  const filenSync = useEoStore((s) => s.filenSync);
  const [syncToastStatus, syncToastSeq, onSyncStatus] = useSyncToast();
  const [matrixReady, setMatrixReady] = useState(false);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [connectionError, setConnectionError] = useState<{
    phase: 'auth' | 'crypto' | 'sync' | 'room';
    message: string;
  } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const retrySync = useCallback(() => {
    setConnectionError(null);
    setMatrixReady(false);
    setRetryCount(c => c + 1);
  }, []);
  // Show actual sync status. Filen is the primary data store when connected —
  // Matrix SyncManager is intentionally skipped in that case (see setupSpaceStore),
  // so treat an active Filen sync as "online" too.
  const connectionState: ConnectionState = !navigator.onLine
    ? 'offline'
    : (!MATRIX_ENABLED || localMode)
      ? 'local'
      : (syncManager || filenSync)
        ? 'online'
        : connectionError
          ? 'error'
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
  /**
   * Persist space lifecycle status to Matrix room state (source of truth).
   * Falls back to localStorage-only if the Matrix write fails (e.g. insufficient power level).
   */
  async function persistSpaceStatus(
    spaceTarget: string,
    status: 'active' | 'archived' | 'deleted',
  ): Promise<void> {
    const client = matrixClientRef.current;
    const entry = mergedEntries.find((e) => e.spaceTarget === spaceTarget);
    const mainRoomId = spaceCacheRef.current.get(spaceTarget)?.mainRoomId || entry?.mainRoomId;
    if (!client || !mainRoomId) return;

    try {
      const currentConfig = getSpaceConfig(client as any, mainRoomId);
      if (!currentConfig) return;

      const updatedConfig = {
        ...currentConfig,
        status,
        status_changed_at: Date.now(),
        status_changed_by: session.userId,
      };

      await setSpaceConfig(client, mainRoomId, updatedConfig);

      // Mirror to governance room if it exists
      const govRoomId = currentConfig.rooms?.governance;
      if (govRoomId) {
        try {
          await setSpaceConfig(client, govRoomId, updatedConfig);
        } catch {
          // Best-effort mirror
        }
      }
    } catch (e) {
      console.warn('[EO-DB] Failed to persist space status to Matrix — using localStorage fallback:', e);
    }
  }

  function handleDeleteSpace(spaceTarget: string) {
    const entry = mergedEntries.find((e) => e.spaceTarget === spaceTarget);
    addDeletedSpace({
      target: spaceTarget,
      name: entry?.displayName || formatSpaceName(spaceTarget.split('.').pop() || ''),
      deletedAt: Date.now(),
      deletedBy: session.userId,
      memberCount: entry?.memberCount || 0,
    });
    // Persist to Matrix room state (async, best-effort)
    persistSpaceStatus(spaceTarget, 'deleted');
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
    // Persist to Matrix room state (async, best-effort)
    persistSpaceStatus(target, 'active');
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
    // Persist to Matrix room state (async, best-effort)
    persistSpaceStatus(spaceTarget, 'archived');
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
    // Persist to Matrix room state (async, best-effort)
    persistSpaceStatus(target, 'active');
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
    getStateByPrefix('').then((states) => {
      const key = states.map(s => s.target + ':' + s.last_seq).join('|');
      if (key !== prevAllStatesKeyRef.current) {
        prevAllStatesKeyRef.current = key;
        setAllStates(states);
      }
    });
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
      const key = direct.map(r => r.target + ':' + r.last_seq).join('|');
      if (key !== prevScopedRecordsKeyRef.current) {
        prevScopedRecordsKeyRef.current = key;
        setScopedRecords(direct);
      }
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
        // Reuse existing client on retry — only create if absent
        let client = matrixClientRef.current;
        if (!client) {
          client = createMatrixClient(session);
          matrixClientRef.current = client;
        }

        // Initialize Rust crypto so E2EE rooms can send/receive decrypted messages.
        // Uses IndexedDB to persist device keys & megolm sessions across reloads.
        try {
          await client.initRustCrypto({ useIndexedDB: true });
          // Bootstrap cross-signing if missing so this device can trust itself
          // and send to encrypted rooms. auth is empty for servers that don't
          // require UIA for already-authenticated sessions; failure is non-fatal.
          try {
            await client.getCrypto()?.bootstrapCrossSigning({});
          } catch (e) {
            console.warn('[EO-DB] cross-signing bootstrap skipped:', e);
          }
        } catch (e) {
          console.warn('[EO-DB] rust crypto init failed — E2EE rooms will not work:', e);
          // Non-fatal: continue without E2EE — sync still works for unencrypted rooms
        }

        await client.startClient({ initialSyncLimit: 20 });

        // Wait for initial sync with a 30s timeout to avoid hanging forever
        await Promise.race([
          new Promise<void>((resolve) => {
            if (client!.isInitialSyncComplete()) {
              resolve();
            } else {
              client!.once('sync' as any, (state: string) => {
                if (state === 'PREPARED') resolve();
              });
            }
          }),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Initial sync timeout after 30s')), 30_000),
          ),
        ]);

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

        setConnectionError(null);
        setMatrixReady(true);
      } catch (e) {
        console.warn('[EO-DB] startMatrix failed:', e);
        if (mounted) {
          setConnectionError({
            phase: 'sync',
            message: e instanceof Error ? e.message : 'Matrix connection failed',
          });
        }
      }
    }

    startMatrix();

    return () => {
      mounted = false;
      if (matrixClientRef.current) matrixClientRef.current.stopClient();
      matrixClientRef.current = null;
      roomIdRef.current = null;
      setMatrixReady(false);
      setConnectionError(null);
    };
  }, [session, retryCount]);

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

    // Discover public (discoverable) spaces from the homeserver directory
    discoverPublicSpaces(matrixClientRef.current)
      .then((publics) => setPublicSpaceEntries(publics))
      .catch(() => { /* best effort */ });
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

        // Start a fresh presence instance for the cached space.
        // (Previous instance was stopped on unmount; creating a new one ensures
        // subscriber effects re-fire with fresh state.)
        if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
          const p = new Presence(matrixClientRef.current, spaceRoomId);
          existing.presence = p;
          void p.start();
          setPresence(p);
          cleanupFns.push(() => { p.stop(); setPresence(null); });
        }
        return;
      }

      // Open space-scoped IDB with stable key (userId + deviceId, no accessToken)
      const idb = await createIdb(selectedSpace!);
      const key = await deriveKey(session.userId, session.deviceId);
      const store = createStore(idb, key);
      if (!mounted) { store.close(); return; }

      await init(store);

      // Detect Filen org-mode via n8n webhook BEFORE starting sync layers.
      // The webhook validates the Matrix access token and returns the shared
      // Filen credentials, so clients no longer read Filen config from Matrix
      // room state. When org-mode is active, Filen is the primary data store
      // and we skip Matrix SyncManager (which would send data via timeline events).
      let filenOrgMode = false;
      const filenState = useFilenStore.getState();
      // Only call the n8n credentials webhook when this client is talking to
      // the app.aminoimmigration.com Matrix homeserver — the webhook validates
      // tokens against that server's /whoami endpoint.
      const isAminoHomeserver =
        (session.homeserver || '').toLowerCase().includes('app.aminoimmigration.com');
      if (!filenState.connected && session.accessToken && isAminoHomeserver) {
        try {
          await useFilenStore.getState().connectOrgFromWebhook(session.accessToken);
          filenOrgMode = true;
          console.log('[EO-DB] Org-mode Filen auto-connected via n8n webhook');
        } catch (e) {
          console.warn('[EO-DB] Org-mode Filen auto-connect via webhook failed:', e);
        }
      }

      // Also check if Filen is already in org-mode (from a previous space switch)
      if (useFilenStore.getState().isOrgMode) filenOrgMode = true;

      // Start Matrix sync ONLY if Filen is NOT connected (in any mode).
      // When Filen is the data store, Matrix is signals only — no SyncManager
      // needed (it would try to hydrate from Matrix media, causing 404 errors).
      let syncManager: SyncManager | null = null;
      const filenConnected = useFilenStore.getState().connected;
      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current && !filenOrgMode && !filenConnected) {
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          if (!mounted) return;
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
            break; // success
          } catch (e) {
            console.warn(`[EO-DB] SyncManager init attempt ${attempt + 1}/${maxRetries} for`, selectedSpace, e);
            syncManager = null;
            if (attempt < maxRetries - 1) {
              await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
            } else {
              setConnectionError({
                phase: 'sync',
                message: `Sync failed after ${maxRetries} attempts: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }
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

      // Start presence heartbeat for the space room (Matrix to-device pings).
      // Independent of SyncManager/Filen — works in all sync modes.
      let presenceInstance: Presence | null = null;
      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
        try {
          presenceInstance = new Presence(matrixClientRef.current, spaceRoomId);
          await presenceInstance.start();
          if (!mounted) {
            presenceInstance.stop();
            presenceInstance = null;
          } else {
            setPresence(presenceInstance);
            const p = presenceInstance;
            cleanupFns.push(() => { p.stop(); setPresence(null); });
          }
        } catch (e) {
          console.warn('[EO-DB] Presence start failed for space', selectedSpace, e);
          presenceInstance = null;
        }
      }

      // Cache this space's store + sync manager for fast re-access
      cache.set(selectedSpace!, { store, syncManager, filenSync, mainRoomId: spaceRoomId, presence: presenceInstance });
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
    people: '\u2689', // people icon
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
    if (sig.activeViewId === '__schema') return 'schema';
    if (!sig.activeViewId) return 'grid';
    const sv = viewStore.savedViews[sig.activeViewId];
    return sv?.viewType || 'grid';
  }, [selectedScope, viewStore]);

  return (
    <div style={s.container}>
      {/* Top bar */}
      <header style={s.topBar}>
        <div style={s.topBarLeft}>
          {isMobile && (
            <button
              onClick={() => setMobileSidebarOpen((prev) => !prev)}
              style={{
                background: 'none', border: 'none', color: theme.textHeading,
                fontSize: 18, cursor: 'pointer', padding: '0 8px 0 0', lineHeight: 1,
              }}
            >
              {'\u2630'}
            </button>
          )}
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
              onCreate={async (name, opts) => {
                const spaceTarget = `space_${name.toLowerCase().replace(/\s+/g, '_')}`;

                // Create Matrix room first (if client is ready) so sync works immediately
                let mainRoomId: string | null = null;
                if (matrixReady && matrixClientRef.current) {
                  mainRoomId = await createSpaceRoom(
                    matrixClientRef.current, name, session.userId,
                    {
                      discoverability: opts?.discoverability ?? 'public',
                      inviteUserIds: opts?.inviteUserIds,
                    },
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
                spaceCacheRef.current.set(spaceTarget, { store: spaceStore, syncManager: null, filenSync: null, mainRoomId, presence: null });

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
              publicEntries={publicSpaceEntries.filter((e) =>
                !activeEntries.some((a) => a.mainRoomId === e.mainRoomId)
              )}
              onRequestAccess={async (roomId) => {
                if (!matrixClientRef.current) return;
                try {
                  await (matrixClientRef.current as any).knockRoom(roomId, { reason: 'Request to join space' });
                  setPublicSpaceEntries((prev) => prev.filter((p) => p.mainRoomId !== roomId));
                } catch (e) {
                  console.warn('[EO-DB] knockRoom failed', e);
                }
              }}
            />
          )}

          {/* Members button — hidden on mobile */}
          {selectedSpace && !isMobile && (
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
          {/* Stats — hidden on mobile, compact on tablet */}
          {!isMobile && (
            <div style={s.stats}>
              <span title="Sequence number">{lastSeq} seq</span>
              {!isTablet && <>
                <span style={s.statSep}>{'\u00B7'}</span>
                <span title="Event count">{recentEvents.length} events</span>
                <span style={s.statSep}>{'\u00B7'}</span>
                <span title="Target count">{targetCount} targets</span>
              </>}
            </div>
          )}
          {!isMobile && (
            <OnlineUsers
              presence={presence}
              selfUserId={session.userId}
              selfDisplayName={displayName}
            />
          )}
          <ConnectionStatus
            state={connectionState}
            onRetry={retrySync}
            errorMessage={connectionError?.message}
          />
          {!isMobile && <SyncToast status={syncToastStatus} seq={syncToastSeq} />}
          {selectedSpace && !isMobile && (
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
            {!isMobile && (
              <span style={{ fontSize: 12, color: theme.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
            )}
          </div>
          <button onClick={handleLogout} style={{
            ...s.logoutButton,
            ...(isMobile ? { padding: '4px 8px', fontSize: 10 } : {}),
          }}>Log out</button>
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
        {/* Mobile overlay backdrop */}
        {isMobile && mobileSidebarOpen && (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }}
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}
        <aside style={{
          ...s.sidebar,
          ...(isTablet ? { width: 180, minWidth: 140 } : {}),
          ...(isMobile ? {
            position: 'fixed' as const, left: 0, top: 0, bottom: 0, zIndex: 999,
            transform: mobileSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 0.2s ease',
            width: 260,
          } : {}),
        }}>
          <nav style={s.sidebarNav}>
            <div style={s.navGroupLabel}>Records</div>
          </nav>

          {/* Objects tree — integrated under Records */}
          {!selectedSpace ? (
            <div style={{ padding: '16px 12px', fontSize: 13, color: theme.textMuted }}>
              No space selected. Open the space browser above to create or select a space.
            </div>
          ) : (
            <>
              {!ready && (
                <SyncProgress message="Initializing store..." detail="Deriving encryption key" />
              )}
              <HolonNav
                selectedScope={selectedScope}
                onSelectScope={(scope) => { navigate({ view: 'records', scope, record: null }); }}
                onSelectSegment={(_scope, _seg) => { navigate({ view: 'records', scope: _scope }); }}
                userId={session.userId}
              />
            </>
          )}

          <nav style={s.sidebarNav}>
            <div style={s.navGroupLabel}>Actions</div>
            {(['compose', 'import'] as View[]).map((view) => (
              <button
                key={view}
                onClick={() => { navigate({ view }); }}
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
              onClick={() => navigate({ view: 'people' })}
              style={{
                ...s.navItem,
                ...(activeView === 'people' ? s.navItemActive : {}),
              }}
            >
              <span style={s.navIcon}>{NAV_ICONS.people}</span>
              People
            </button>
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
            <button
              onClick={() => { navigate({ view: 'log' }); }}
              style={{
                ...s.navItem,
                ...(activeView === 'log' ? s.navItemActive : {}),
              }}
            >
              <span style={s.navIcon}>{NAV_ICONS.log}</span>
              Log
            </button>
            {currentPermissions?.can_build_views !== false && (
              <button
                onClick={() => { navigate({ view: 'builder', builderViewId: null, customPageId: null }); }}
                style={{
                  ...s.navItem,
                  ...(activeView === 'builder' ? s.navItemActive : {}),
                }}
              >
                <span style={s.navIcon}>{NAV_ICONS.builder}</span>
                Builder
              </button>
            )}
            {currentPermissions?.can_set_governance !== false && (
              <button
                onClick={() => { navigate({ view: 'settings' }); }}
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
                    {activeViewType === 'schema' ? (
                      <SchemaView scope={selectedScope} />
                    ) : activeViewType === 'graph' ? (
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
              <MessagesView scope={selectedScope} userId={session.userId} activeRoomId={route.query.roomId ?? null} matrixClient={matrixClientRef.current as any} />
            ) : activeView === 'people' ? (
              matrixClientRef.current ? (
                <PeopleView
                  matrixClient={matrixClientRef.current as any}
                  onOpenDirectMessage={(roomId) => navigate({ view: 'messages', query: { roomId } })}
                />
              ) : (
                <div style={s.empty}>
                  <div style={s.emptyIcon}>{'\u2689'}</div>
                  <div style={s.emptyText}>Matrix client not ready</div>
                  <div style={s.emptySub}>People discovery requires an active Matrix connection.</div>
                </div>
              )
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
            profileFields={selectedScope ? viewStore.getConfig(selectedScope).profileFields : undefined}
            isMobile={isMobile}
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
function RecordPageOrDrawer({ recordTarget, allStates, onClose, onNavigate, profileFields, isMobile }: {
  recordTarget: string;
  allStates: EoState[];
  onClose: () => void;
  onNavigate: (target: string) => void;
  profileFields?: string[];
  isMobile?: boolean;
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
        width: isMobile ? '100vw' : 720, maxWidth: isMobile ? '100vw' : '55vw', height: '100%',
        flexShrink: 0, borderLeft: isMobile ? 'none' : '1px solid var(--border, #e0e0e0)',
        background: 'var(--bg, #fff)', display: 'flex', flexDirection: 'column',
        ...(isMobile ? { position: 'fixed' as const, inset: 0, zIndex: 1000 } : {}),
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
      profileFields={profileFields}
      isMobile={isMobile}
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
      padding: '0 12px',
      height: 48,
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      transition: 'background 0.25s ease',
      gap: 8,
    },
    topBarLeft: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, overflow: 'hidden', flexShrink: 1 },
    topBarRight: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 },
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
      minWidth: 0,
      overflowX: 'hidden' as const,
      overflowY: 'auto' as const,
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
