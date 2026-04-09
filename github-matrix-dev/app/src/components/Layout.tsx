import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { logout, createMatrixClient, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { persistSpaceMeta, listSpaceMeta, clearAllSpaceMetas, saveSpaceMeta, removeSpaceMeta } from '../db/space-meta';
import { createFoldWorkerClient, initFoldWorker, type FoldWorkerClient } from '../db/lazy-fold';
import { SyncManager } from '../matrix/sync-manager';
import { Presence } from '../matrix/presence';
import { OnlineUsers } from './OnlineUsers';
import { GDriveSyncService } from '../google-drive/gdrive-sync';
import { useGDriveStore } from '../google-drive/gdrive-store';
import { useAirtableStore } from '../ingestion/airtable-store';
import { resolveDataRoom } from '../matrix/event-bridge';
import { configureMatrixDomain } from '../lib/matrix-domain';
import { HolonNav } from './HolonNav';
import { TableView } from './TableView';
import { SliceTabs } from './SliceTabs';
import { RecordDetailDrawer } from './RecordDetailDrawer';
import { detailLayoutTarget, type LayoutDisplayType } from './detail-layout';
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
import { ApiConnectionsView } from './ApiConnectionsView';
import { BuilderView } from './builder/BuilderView';
import { MessagesView } from './MessagesView';
import { PeopleView } from './PeopleView';
import { RecordPageView } from './builder/RecordPageView';
import { PermissionBadge } from './PermissionBadge';
import { ViewOnlyBanner } from './ViewOnlyBanner';
import { HeadlineMetrics } from './HeadlineMetrics';
import { useSliceStore } from '../store/slice-store';
import { useBuilderStore } from '../store/builder-store';
import { useSyncStore } from '../store/sync-store';
import { useEoServerStore } from '../store/eo-server-store';
import { processEvent } from '../db/fold';
import { useTheme, spaceBackgroundTint, roleBackgroundTint, type Theme } from '../theme';
import type { EoState } from '../db/types';
import type { ViewDefinition } from '../blocks/types';
import type { SliceType } from './slice-types';
import { discoverSpacesFromMatrix, discoverPublicSpaces, type SpaceEntry } from '../matrix/space-discovery';
import { SpaceBrowser } from './SpaceBrowser';
import { Horizon } from './Horizon';
import { type TimeScrubberFilter, type DateColumnOption, DEFAULT_FILTER, detectDateColumns, computeDateRange, buildAdaptiveFormatter } from './time-scrubber-utils';
import { hasFieldsSubObject, buildFieldNameMap } from './filter-types';
import { useHashRoute, type View } from '../lib/router';
import { type AccessRole, type UserTypeDefinition, type SpaceConfig, powerLevelToRole, legacyAccessToRole } from '../permissions/types';
import { UserTypeSwitcher } from './UserTypeSwitcher';
import { resolvePermissionsFromSharing } from '../permissions/resolve';
import { MultiUserTestView } from './MultiUserTestView';
import { RecycleBin, addDeletedSpace, isSpaceDeleted, removeDeletedSpace, getDeletedSpaces } from './RecycleBin';
import { addArchivedSpace, isSpaceArchived, removeArchivedSpace, getArchivedSpaces } from './ArchivedSpaces';
import { setSpaceConfig, getSpaceConfig, applyEoPowerLevels, EO_SPACE_CONFIG_TYPE } from '../permissions/room-topology';
import { EO_POWER_LEVEL_CONTENT } from '../permissions/types';
import { listAllHomeserverUsers } from '../matrix/user-discovery';
import { withRetry } from '../matrix/connection-resilience';

/** Set to false to disable all Matrix activity (sync, room creation, discovery). */
const MATRIX_ENABLED = true;

/**
 * Clear Matrix SDK crypto IndexedDB stores (Rust crypto, Olm sessions).
 *
 * These databases are NOT cleared by the OPFS/localStorage cleanup on logout.
 * A stale crypto store causes device-ID mismatches when the user logs out and
 * back in, because the new session gets a fresh device ID but the old crypto
 * store still references the previous one.
 */
async function clearMatrixCryptoStore(): Promise<void> {
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs
      .map((d) => d.name)
      .filter(
        (n): n is string =>
          typeof n === 'string' && (n.includes('matrix') || n.includes('rust-crypto')),
      )
      .map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          }),
      ),
  );
}

export interface CreateSpaceOptions {
  /** 'public' = listed in homeserver public directory, join by knock.
   *  'private' = invite-only, not discoverable. Defaults to 'public'. */
  discoverability?: 'public' | 'private';
  /** Matrix user IDs to invite immediately upon space creation. */
  inviteUserIds?: string[];
}

/**
 * Generate the canonical Matrix room alias local-part for a space.
 * e.g. spaceName "Drive Test 2" → "eo-db_drive_test_2"
 * Full alias becomes #eo-db_drive_test_2:<homeserver>.
 */
function spaceAliasLocal(spaceName: string): string {
  return `eo-db_${spaceName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.-]/g, '')}`;
}

/**
 * Build the full canonical alias (#local:server) from a space name + user ID.
 */
function spaceAliasFull(spaceName: string, userId: string): string {
  const server = userId.split(':').slice(1).join(':');
  return `#${spaceAliasLocal(spaceName)}:${server}`;
}

/**
 * Try to resolve a canonical space alias and join the room.
 * Returns the room ID if successful, null otherwise.
 */
async function resolveCanonicalAlias(
  client: ReturnType<typeof createMatrixClient>,
  spaceName: string,
  userId: string,
): Promise<string | null> {
  const alias = spaceAliasFull(spaceName, userId);
  try {
    const resolved = await (client as any).resolveRoomAlias(alias);
    const roomId = resolved?.room_id;
    if (!roomId) return null;

    // Ensure we're joined
    const room = client.getRoom(roomId);
    if (!room || room.getMyMembership?.() !== 'join') {
      try {
        await (client as any).joinRoom(roomId);
      } catch {
        // May already be joined or room requires invite — non-fatal
      }
    }
    console.info('[EO-DB] Resolved canonical alias', alias, '→', roomId);
    return roomId;
  } catch {
    return null; // Alias doesn't exist yet
  }
}

/**
 * Create a Matrix room for a space and publish the space config state event.
 * Sets a canonical alias so all clients can find the same room.
 * Returns the new room ID, or null if creation fails.
 */
async function createSpaceRoom(
  client: ReturnType<typeof createMatrixClient>,
  spaceName: string,
  ownerUserId: string,
  opts: CreateSpaceOptions = {},
): Promise<{ mainRoomId: string; governanceRoomId: string | null } | null> {
  const discoverability = opts.discoverability ?? 'public';
  let inviteUserIds = opts.inviteUserIds ?? [];

  // For public spaces, auto-invite every discoverable LOCAL homeserver user
  // so they receive a room invite (not just a knock-based discovery entry).
  // Federated users are excluded — including them in the invite list can
  // cause Synapse to return 403 when it can't resolve the remote server.
  if (discoverability === 'public') {
    try {
      const all = await listAllHomeserverUsers(client as any, 500);
      const myDomain = ownerUserId.split(':').slice(1).join(':');
      const merged = new Set<string>(inviteUserIds);
      for (const u of all) {
        if (u.userId && u.userId !== ownerUserId && u.userId.endsWith(':' + myDomain)) {
          merged.add(u.userId);
        }
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

    // Before creating, check if the canonical alias already exists.
    // If it does, another client already created this space's room — join it.
    const existingRoomId = await resolveCanonicalAlias(client, spaceName, ownerUserId);
    if (existingRoomId) {
      // Ensure it has a space config (may be missing if the creator crashed mid-setup)
      const room = client.getRoom(existingRoomId);
      const hasConfig = room?.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
      if (!hasConfig) {
        try {
          await setSpaceConfig(client, existingRoomId, {
            name: spaceName,
            rooms: { main: existingRoomId },
            field_assignments: [],
            space_settings: {},
            discoverability,
          } as any);
        } catch { /* non-fatal — config may already exist server-side */ }
      }
      return { mainRoomId: existingRoomId, governanceRoomId: null };
    }

    const aliasLocal = spaceAliasLocal(spaceName);

    const createArgs: any = {
      name: spaceName,
      room_alias_name: aliasLocal,
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
      // Alias already taken → another client won the race. Resolve + join.
      if (err?.errcode === 'M_ROOM_IN_USE') {
        const raceRoomId = await resolveCanonicalAlias(client, spaceName, ownerUserId);
        if (raceRoomId) return { mainRoomId: raceRoomId, governanceRoomId: null };
      }
      // Homeserver may forbid public room creation (403). Progressive
      // fallback: private with custom state → bare-minimum room.
      if (err?.httpStatus === 403 && discoverability === 'public') {
        console.warn('[EO-DB] Public room creation forbidden — falling back to private.');
        createArgs.visibility = 'private';
        createArgs.preset = 'private_chat';
        createArgs.initial_state = (createArgs.initial_state as any[]).filter(
          (s: any) => s.type !== 'm.room.join_rules' && s.type !== 'm.room.guest_access',
        );
        // Strip invite list — federated users or bulk invites may cause 403
        delete createArgs.invite;
        try {
          result = await client.createRoom(createArgs);
        } catch (err2: any) {
          // Alias collision on fallback → resolve existing
          if (err2?.errcode === 'M_ROOM_IN_USE') {
            const raceRoomId = await resolveCanonicalAlias(client, spaceName, ownerUserId);
            if (raceRoomId) return { mainRoomId: raceRoomId, governanceRoomId: null };
          }
          // Last resort: bare-minimum room with retry on transient failures
          console.warn('[EO-DB] Private room also rejected — trying minimal room with retry:', err2);
          result = await withRetry(() => client.createRoom({
            name: spaceName,
            visibility: 'private' as any,
            preset: 'private_chat' as any,
          }));
        }
      } else {
        throw err;
      }
    }
    const roomId = result.room_id;

    // Governance room deferred: EVAs live in LevelDB, not Matrix. The
    // governance room can be created lazily if an admin needs to publish
    // governance-specific state events. The restricted room is also lazy
    // (created on first restricted field assignment) per spec.

    // Publish space config so discoverSpacesFromMatrix() can find this room.
    // The config is authoritative and lists every associated room.
    const spaceConfig: any = {
      name: spaceName,
      rooms: { main: roomId },
      field_assignments: [],
      space_settings: {},
      discoverability,
      canonical_alias: spaceAliasFull(spaceName, ownerUserId),
    };
    await setSpaceConfig(client, roomId, spaceConfig);

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
      '[EO-DB] Created Matrix room for space', spaceName,
      '→ main:', roomId,
      '(', discoverability, ',', inviteUserIds.length, 'invited)',
    );
    return { mainRoomId: roomId, governanceRoomId: null };
  } catch (e) {
    console.warn('[EO-DB] Failed to create Matrix room for space', spaceName, e);
    return null;
  }
}

/**
 * Directly scan all joined rooms for a com.eo-db.space.config state event
 * matching the given spaceTarget. Returns the mainRoomId and full room
 * topology, or null if no matching room is found.
 *
 * This is synchronous (reads from the SDK's in-memory room store) and
 * serves as a fallback when discoverSpacesFromMatrix() hasn't indexed
 * the space yet due to timing.
 */
function findSpaceRoomByDirectScan(
  client: ReturnType<typeof createMatrixClient>,
  spaceTarget: string,
): { mainRoomId: string; rooms: SpaceConfig['rooms'] } | null {
  const rooms = (client as any).getRooms?.() ?? [];
  // When multiple rooms match (duplicate space creation), pick the one with
  // the lexicographically smallest mainRoomId so all clients converge.
  let best: { mainRoomId: string; rooms: SpaceConfig['rooms'] } | null = null;
  for (const room of rooms) {
    const configEvent = room.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
    if (!configEvent) continue;

    const config = configEvent.getContent() as SpaceConfig;
    if (!config?.name || !config?.rooms?.main) continue;

    const target = `space_${config.name.toLowerCase().replace(/\s+/g, '_')}`;
    if (target === spaceTarget) {
      if (!best || config.rooms.main < best.mainRoomId) {
        best = { mainRoomId: config.rooms.main, rooms: config.rooms };
      }
    }
  }
  return best;
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

function getHttpStatus(err: any): number | undefined {
  const status = err?.httpStatus ?? err?.statusCode ?? err?.data?.statusCode ?? err?.event?.status;
  return typeof status === 'number' ? status : undefined;
}

function describeMatrixError(err: any): { phase: 'auth' | 'crypto' | 'sync' | 'room'; message: string } {
  const status = getHttpStatus(err);
  const code = String(err?.errcode ?? err?.data?.errcode ?? '');
  const raw = err?.message ? String(err.message) : String(err);

  if (status === 401 || code === 'M_UNKNOWN_TOKEN') {
    return { phase: 'auth', message: 'Matrix auth failed (401/M_UNKNOWN_TOKEN). Your session may be expired — please log out and sign in again.' };
  }
  if (status === 403 || code === 'M_FORBIDDEN') {
    return { phase: 'auth', message: 'Matrix permission denied (403/M_FORBIDDEN). Account may lack access to one or more rooms.' };
  }
  if (status === 404) {
    return { phase: 'sync', message: `Matrix endpoint missing (404). This is often homeserver feature mismatch (for example optional cross-signing routes). ${raw}` };
  }
  return { phase: 'sync', message: raw || 'Matrix connection failed' };
}

interface CachedSpace {
  workerClient: FoldWorkerClient;
  syncManager: SyncManager | null;
  gdriveSync: GDriveSyncService | null;
  mainRoomId: string | null;
  presence: Presence | null;
  /** Full room topology from SpaceConfig (when available) */
  spaceRooms?: { main: string; restricted?: string; governance?: string } | null;
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
    // Prefer space from URL hash (enables direct links)
    if (route.space) {
      const fromUrl = normalizeSpaceTarget(route.space);
      localStorage.setItem('eo-selected-space', fromUrl);
      return fromUrl;
    }
    // Fall back to last selected space from localStorage
    const saved = localStorage.getItem('eo-selected-space');
    if (!saved) return null;
    // Normalize legacy "space.foo" format to canonical "space_foo"
    return normalizeSpaceTarget(saved);
  });
  const [spaceOpen, setSpaceOpen] = useState(false);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isNarrow = useIsNarrow(); // mobile OR tablet
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [spaces, setSpaces] = useState<EoState[]>([]);
  const [spaceEntries, setSpaceEntries] = useState<SpaceEntry[]>([]);
  const [publicSpaceEntries, setPublicSpaceEntries] = useState<SpaceEntry[]>([]);
  const [cachedSpaceMetas, setCachedSpaceMetas] = useState<Map<string, import('../db/space-meta').SpaceMeta>>(new Map());
  const [allStates, setAllStates] = useState<EoState[]>([]);
  const prevAllStatesKeyRef = useRef<string>('');
  const allStatesFetchGenRef = useRef(0);
  const [timeScrubberFilter, setTimeScrubberFilter] = useState<TimeScrubberFilter>(DEFAULT_FILTER);
  const [tableRecordTargets, setTableRecordTargets] = useState<string[]>([]);
  const [recordOpenedViaNav, setRecordOpenedViaNav] = useState(false);
  const [scopedRecords, setScopedRecords] = useState<EoState[]>([]);
  const prevScopedRecordsKeyRef = useRef<string>('');
  const scopedRecordsFetchGenRef = useRef(0);
  const [scopeFieldNameMap, setScopeFieldNameMap] = useState<Map<string, string>>(new Map());
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getState = useEoStore((s) => s.getState);
  const _browserOnline = useConnectionState(); // triggers re-render on network change
  const syncManager = useEoStore((s) => s.syncManager);
  const [syncToastStatus, syncToastSeq, onSyncStatus] = useSyncToast();
  const [matrixReady, setMatrixReady] = useState(false);
  const [presence, setPresence] = useState<Presence | null>(null);
  // Reactive room ID for the current space — drives SettingsView, MultiUserTestView, etc.
  // Updated by setupSpaceStore when room resolution completes (including retries).
  const [spaceRoomId, setSpaceRoomId] = useState<string | null>(null);
  const [spaceRooms, setSpaceRooms] = useState<CachedSpace['spaceRooms']>(null);
  const [connectionError, setConnectionError] = useState<{
    phase: 'auth' | 'crypto' | 'sync' | 'room';
    message: string;
  } | null>(null);
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  // Deferred loading flag — only show "Initializing store" after a short delay
  // so quick re-inits (cached stores) don't cause a visible blink.
  const [showStoreLoading, setShowStoreLoading] = useState(false);
  useEffect(() => {
    if (ready) {
      setShowStoreLoading(false);
      return;
    }
    const timer = setTimeout(() => setShowStoreLoading(true), 400);
    return () => clearTimeout(timer);
  }, [ready]);
  const retrySync = useCallback(() => {
    setConnectionError(null);
    setConnectionDetail(null);
    setMatrixReady(false);
    setRetryCount(c => c + 1);
  }, []);
  const connectionState: ConnectionState = !navigator.onLine
    ? 'offline'
    : (!MATRIX_ENABLED || localMode)
      ? 'local'
      : syncManager
        ? 'online'
        : connectionError
          ? 'error'
          : matrixReady
            ? 'online'
            : 'syncing';
  const connectionMessage = connectionError?.message
    ?? connectionDetail
    ?? (connectionState === 'syncing' ? 'Matrix is starting and performing initial sync.' : undefined);

  // Helper to select a space and persist the choice
  function selectSpace(target: string) {
    const canonical = normalizeSpaceTarget(target);
    setSelectedSpace(canonical);
    localStorage.setItem('eo-selected-space', canonical);
    // Clear route state when switching spaces — space is now part of the URL
    navigate({ space: canonical, scope: null, record: null, view: 'records', builderViewId: null, customPageId: null });
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
        navigate({ space: null });
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
        navigate({ space: null });
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

  // Sync selectedSpace → URL: when selectedSpace changes outside of navigate
  // (e.g. auto-select on discovery), push it into the URL
  useEffect(() => {
    if (selectedSpace && route.space !== selectedSpace) {
      navigate({ space: selectedSpace });
    } else if (!selectedSpace && route.space) {
      navigate({ space: null });
    }
  }, [selectedSpace]);

  // Sync URL → selectedSpace: when browser back/forward changes the hash space
  useEffect(() => {
    const urlSpace = route.space ? normalizeSpaceTarget(route.space) : null;
    if (urlSpace && urlSpace !== selectedSpace) {
      setSelectedSpace(urlSpace);
      localStorage.setItem('eo-selected-space', urlSpace);
    }
  }, [route.space]);

  // Permanently delete a space's local OPFS data
  async function handlePermanentDelete(target: string) {
    const cached = spaceCacheRef.current.get(target);
    if (cached) {
      cached.workerClient.worker.terminate();
      spaceCacheRef.current.delete(target);
    }
    // Delete the space's OPFS subdirectory
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(`space.${target}`, { recursive: true });
    } catch { /* best effort */ }
    removeSpaceMeta(target);
  }

  const { theme, toggleTheme } = useTheme();
  const spaceTint = spaceBackgroundTint(selectedSpace, theme.mode);
  const themedBg = spaceTint ? { ...theme, bg: spaceTint.bg, bgCard: spaceTint.bgCard, bgMuted: spaceTint.bgMuted } : theme;
  const s = makeStyles(themedBg);

  // Load all states — each space has its own isolated IDB, no prefix needed
  useEffect(() => {
    if (!ready) return;
    const gen = ++allStatesFetchGenRef.current;
    getStateByPrefix('').then((states) => {
      if (gen !== allStatesFetchGenRef.current) return;
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
    const gen = ++scopedRecordsFetchGenRef.current;
    const scopeDepth = selectedScope.split('.').length;
    getStateByPrefix(selectedScope + '.').then((states) => {
      if (gen !== scopedRecordsFetchGenRef.current) return;
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
      if (gen !== scopedRecordsFetchGenRef.current) return;
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

  // How far back the slider is: 0 = present, 1 = oldest data point
  const pastDateRange = useMemo(
    () => computeDateRange(scopedRecords, timeScrubberFilter.dateField, useFieldsSub),
    [scopedRecords, timeScrubberFilter.dateField, useFieldsSub],
  );
  const pastnessFraction = useMemo(() => {
    if (timeScrubberFilter.rangeMax == null || !pastDateRange) return 0;
    const span = pastDateRange.max - pastDateRange.min;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(1, (pastDateRange.max - timeScrubberFilter.rangeMax) / span));
  }, [timeScrubberFilter.rangeMax, pastDateRange]);
  const pastDateLabel = useMemo(() => {
    if (timeScrubberFilter.rangeMax == null || !pastDateRange) return null;
    const fmt = buildAdaptiveFormatter(pastDateRange.max - pastDateRange.min);
    return fmt(timeScrubberFilter.rangeMax);
  }, [timeScrubberFilter.rangeMax, pastDateRange]);

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
          try {
            await client.getCrypto()?.bootstrapCrossSigning({});
          } catch (e) {
            if (getHttpStatus(e) === 404) {
              console.info('[EO-DB] cross-signing bootstrap unavailable on this homeserver (404). Continuing without cross-signing bootstrap.');
            } else {
              console.warn('[EO-DB] cross-signing bootstrap skipped:', e);
            }
          }
        } catch (e) {
          // Device-ID mismatch — stale crypto store from a previous session.
          // The OPFS/localStorage cleanup on logout does not touch the Matrix
          // Rust crypto store. Clear it and retry once.
          if (e instanceof Error && e.message.includes("doesn't match")) {
            console.warn('[EO-DB] Stale crypto store (device mismatch) — clearing and retrying.');
            await clearMatrixCryptoStore();
            try {
              await client.initRustCrypto({ useIndexedDB: true });
              try { await client.getCrypto()?.bootstrapCrossSigning({}); } catch { /* best effort */ }
            } catch (e2) {
              console.warn('[EO-DB] rust crypto init failed after store clear:', e2);
            }
          } else {
            console.warn('[EO-DB] rust crypto init failed — E2EE rooms will not work:', e);
          }
        }

        const onSync = (state: string, _prevState: string, data?: any) => {
          if (!mounted) return;
          if (state === 'ERROR') {
            const described = describeMatrixError(data?.error);
            setConnectionError(described);
          } else if (state === 'RECONNECTING') {
            setConnectionDetail('Matrix reconnecting after a network interruption.');
          } else if (state === 'SYNCING' || state === 'PREPARED') {
            setConnectionDetail(null);
            setConnectionError(null);
          }
        };
        client.on('sync' as any, onSync);

        await client.startClient({ initialSyncLimit: 20 });

        // Wait for initial sync with a 30s timeout to avoid hanging forever.
        // Also reject immediately on ERROR (e.g. 401 auth) instead of waiting
        // the full 30s — the onSync listener above will have already set
        // connectionError, but we need the await to throw so startMatrix()
        // enters its catch block.
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            if (client!.isInitialSyncComplete()) {
              resolve();
            } else {
              const onInitSync = (state: string, _prev: string | null, data?: any) => {
                if (state === 'PREPARED') {
                  client!.removeListener('sync' as any, onInitSync);
                  resolve();
                } else if (state === 'ERROR') {
                  client!.removeListener('sync' as any, onInitSync);
                  const described = describeMatrixError(data?.error);
                  reject(new Error(described.message));
                }
              };
              client!.on('sync' as any, onInitSync);
            }
          }),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Initial sync timeout after 30s')), 30_000),
          ),
        ]);

        if (!mounted) { client.stopClient(); return; }

        // Auto-join any rooms where we have a pending invite. Invited rooms
        // only expose stripped state — custom state events like
        // com.eo-db.space.config are not readable until the user joins.
        // Without this, the second user can never discover the space room.
        for (const room of client.getRooms()) {
          if (room.getMyMembership?.() === 'invite') {
            try {
              await (client as any).joinRoom(room.roomId);
            } catch (e) {
              console.warn('[EO-DB] Auto-join invited room failed:', room.roomId, e);
            }
          }
        }

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
        setConnectionDetail(null);
        setMatrixReady(true);
      } catch (e) {
        console.warn('[EO-DB] startMatrix failed:', e);
        if (mounted) {
          setConnectionError(describeMatrixError(e));
        }
      }
    }

    startMatrix();

    return () => {
      mounted = false;
      if (matrixClientRef.current) {
        matrixClientRef.current.removeAllListeners('sync' as any);
        matrixClientRef.current.stopClient();
      }
      matrixClientRef.current = null;
      roomIdRef.current = null;
      setMatrixReady(false);
      setConnectionError(null);
      setConnectionDetail(null);
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

      // Load persisted space metadata (room IDs, etc.) from localStorage
      // so sync services can start without Matrix discovery.
      try {
        const metas = listSpaceMeta();
        if (metas.length > 0) {
          const map = new Map(metas.map(m => [m.spaceId, m]));
          setCachedSpaceMetas(map);

          // Convert localStorage space metas to EoState shape for the UI.
          const now = new Date().toISOString();
          const spaceRoots = metas.map((m) => ({
            target: m.spaceId,
            value: { name: m.spaceName },
            level: 1,
            last_seq: 0,
            last_op: 'INS' as const,
            last_agent: session.userId,
            last_ts: now,
            last_acquired_ts: now,
          }));

          if (!mounted) return;

          if (spaceRoots.length > 0) {
            setSpaces(spaceRoots);
            localStorage.setItem('eo-spaces', JSON.stringify(spaceRoots));
            if (selectedSpace === null) selectSpace(spaceRoots[0].target);
          }
        }
      } catch { /* best effort */ }
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
    // Offline fallback: adapt IDB-sourced spaces to SpaceEntry shape,
    // enriched with persisted space metadata (room IDs, etc.)
    return spaces.map((sp) => {
      const spaceTarget = normalizeSpaceTarget(sp.target);
      const meta = cachedSpaceMetas.get(spaceTarget);
      const name = meta?.spaceName || sp.value?.name || formatSpaceName(sp.target.split('.').pop() || '');
      return {
        spaceTarget,
        displayName: name,
        mainRoomId: meta?.mainRoomId || '',
        createdAt: sp.last_ts ? new Date(sp.last_ts).getTime() : 0,
        lastActivity: sp.last_ts ? new Date(sp.last_ts).getTime() : 0,
        ownerUserId: sp.last_agent || '',
        ownerDisplayName: sp.last_agent
          ? (sp.last_agent.startsWith('@') ? sp.last_agent.slice(1).split(':')[0] : sp.last_agent)
          : 'Unknown',
        memberCount: (sp.value?._sharing || []).length + 1,
      };
    });
  }, [spaceEntries, spaces, cachedSpaceMetas]);

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

      if (prevSpaceRef.current) {
        const oldCached = spaceCacheRef.current.get(prevSpaceRef.current);
        if (oldCached?.gdriveSync) {
          oldCached.gdriveSync.stop();
        }
      }

      prevSpaceRef.current = selectedSpace;
      // Clear Layout-level state so old space data doesn't flash
      setAllStates([]);
      setScopedRecords([]);
      setScopeFieldNameMap(new Map());
      setShowMembers(false);
      setShowRecycleBin(false);
      // Clear connection error from previous space (e.g. stale "resolve failed")
      setConnectionError(null);
      // Clear room ID and presence so SettingsView/MultiUserTestView don't show stale data
      setSpaceRoomId(null);
      setSpaceRooms(null);
      setPresence(null);
      // Reset builder store so old space's views don't persist
      useBuilderStore.getState().reset();
      // Reset sync store so old space's peer/snapshot data doesn't persist
      useSyncStore.getState().reset();
    }
  }, [selectedSpace]);

  // --- Cached space stores (survive space switches, avoid re-init) ---
  const spaceCacheRef = useRef<Map<string, CachedSpace>>(new Map());

  // Generation counter: increments each time setupSpaceStore starts. Stale
  // async completions compare their generation to the current value and bail
  // if a newer run has started, preventing race conditions when the effect
  // re-fires (e.g. matrixReady, mergedEntries change) mid-flight.
  const setupGenRef = useRef(0);

  // --- Per-space store init (re-runs when selectedSpace changes) ---
  useEffect(() => {
    if (!selectedSpace) return;
    // In local mode, the store is already initialized via initLocal() — skip
    if (localMode) return;

    const generation = ++setupGenRef.current;
    let mounted = true;
    const isStale = () => !mounted || setupGenRef.current !== generation;
    const cleanupFns: (() => void)[] = [];

    // Holds the room topology discovered during resolution (used to populate cache).
    let resolvedSpaceRooms: SpaceConfig['rooms'] | null = null;

    async function resolveOrCreateRoom(): Promise<string | null> {
      // When Matrix is disabled, skip all room resolution — local-only mode.
      if (!MATRIX_ENABLED) return null;

      // 0. Check the space cache first (handles freshly-created spaces
      //    whose state events haven't synced to the SDK yet)
      const cached = spaceCacheRef.current.get(selectedSpace!);
      if (cached?.mainRoomId) {
        resolvedSpaceRooms = cached.spaceRooms ?? null;
        return cached.mainRoomId;
      }


      // 0b. Auto-join any invited rooms so their full state becomes readable.
      //     Invites received since initial sync may still be pending.
      if (matrixClientRef.current) {
        for (const room of matrixClientRef.current.getRooms()) {
          if (room.getMyMembership?.() === 'invite') {
            try {
              await (matrixClientRef.current as any).joinRoom(room.roomId);
            } catch (e) {
              console.warn('[EO-DB] Auto-join invited room failed:', room.roomId, e);
            }
          }
        }
      }

      // 1. Try the space's own mainRoomId from discovery
      const spaceEntry = mergedEntries.find((e) => e.spaceTarget === selectedSpace);
      if (spaceEntry?.mainRoomId) {
        // Also run the direct scan to populate the full room topology for Settings.
        if (matrixClientRef.current) {
          const scanResult = findSpaceRoomByDirectScan(matrixClientRef.current, selectedSpace!);
          if (scanResult) resolvedSpaceRooms = scanResult.rooms;
        }
        return spaceEntry.mainRoomId;
      }

      // 2. Direct scan: search ALL joined rooms for a space config matching
      //    this space. Catches premade/existing spaces that discovery hasn't
      //    indexed yet (e.g., timing issues, initial sync delay).
      if (matrixClientRef.current) {
        const scanResult = findSpaceRoomByDirectScan(matrixClientRef.current, selectedSpace!);
        if (scanResult) {
          resolvedSpaceRooms = scanResult.rooms;
          return scanResult.mainRoomId;
        }
      }

      // 2b. State events may still be arriving after initial sync.
      //     The SDK's PREPARED state doesn't guarantee all room state is loaded.
      //     Wait for the next sync cycle to complete, then re-scan before
      //     concluding the room doesn't exist and creating a new one.
      if (matrixReady && matrixClientRef.current) {
        const client = matrixClientRef.current;
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            client.removeListener('sync' as any, onNextSync);
            resolve();
          }, 5000);
          const onNextSync = (state: string) => {
            if (state === 'SYNCING') {
              client.removeListener('sync' as any, onNextSync);
              clearTimeout(timeout);
              resolve();
            }
          };
          client.on('sync' as any, onNextSync);
        });

        // Re-run discovery + direct scan with fully-loaded state
        const retryEntries = discoverSpacesFromMatrix(client);
        if (retryEntries.length > 0) setSpaceEntries(retryEntries);
        const retryEntry = retryEntries.find((e) => e.spaceTarget === selectedSpace);
        if (retryEntry?.mainRoomId) {
          const scan = findSpaceRoomByDirectScan(client, selectedSpace!);
          if (scan) resolvedSpaceRooms = scan.rooms;
          return retryEntry.mainRoomId;
        }
        const retryScan = findSpaceRoomByDirectScan(client, selectedSpace!);
        if (retryScan) {
          resolvedSpaceRooms = retryScan.rooms;
          return retryScan.mainRoomId;
        }
      }

      // 2c. Fallback: check persisted space metadata from IndexedDB.
      //     This lets the app reuse a known room ID when Matrix discovery
      //     fails (slow sync, offline, etc.) — avoids creating duplicate rooms.
      const savedMeta = cachedSpaceMetas.get(selectedSpace!);
      if (savedMeta?.mainRoomId) {
        console.log('[EO-DB] Using cached room ID from space-meta for', selectedSpace);
        return savedMeta.mainRoomId;
      }

      // 2d. Public room discovery + join: the user may have navigated to a
      //     space URL but hasn't joined the room yet (invite failed, different
      //     device, URL shared directly). Query the homeserver's public room
      //     directory for a matching space and attempt to join/knock.
      if (matrixClientRef.current) {
        try {
          const publicSpaces = await discoverPublicSpaces(matrixClientRef.current);
          const match = publicSpaces.find((e) => e.spaceTarget === selectedSpace);
          if (match?.mainRoomId) {
            console.log('[EO-DB] Found public room for space', selectedSpace, '→', match.mainRoomId);
            try {
              // Try joining directly first (works for public rooms)
              await (matrixClientRef.current as any).joinRoom(match.mainRoomId);
              console.log('[EO-DB] Joined public room', match.mainRoomId, 'for space', selectedSpace);
            } catch (joinErr: any) {
              // If direct join fails, try knocking (for knock-only rooms)
              try {
                await (matrixClientRef.current as any).knockRoom(match.mainRoomId, {
                  reason: 'Auto-join via space URL',
                });
                console.log('[EO-DB] Knocked on room', match.mainRoomId, 'for space', selectedSpace);
              } catch (knockErr) {
                console.warn('[EO-DB] Could not join or knock on public room', match.mainRoomId, joinErr, knockErr);
              }
            }

            // After joining, re-scan to pick up the full room topology
            const postJoinScan = findSpaceRoomByDirectScan(matrixClientRef.current, selectedSpace!);
            if (postJoinScan) {
              resolvedSpaceRooms = postJoinScan.rooms;
              return postJoinScan.mainRoomId;
            }
            // Even if direct scan doesn't work yet (state still syncing),
            // return the mainRoomId from the public listing
            return match.mainRoomId;
          }
        } catch (e) {
          console.warn('[EO-DB] Public room discovery during resolve failed:', e);
        }
      }

      // 2e. Canonical alias resolution: the room may exist but we haven't
      //     joined it yet and discovery didn't find it. The canonical alias
      //     is the single source of truth for "which room IS this space".
      if (matrixClientRef.current) {
        const displayName = formatSpaceName(selectedSpace!.replace(/^space_/, ''));
        const aliasRoomId = await resolveCanonicalAlias(
          matrixClientRef.current, displayName, session.userId,
        );
        if (aliasRoomId) {
          const scan = findSpaceRoomByDirectScan(matrixClientRef.current, selectedSpace!);
          if (scan) resolvedSpaceRooms = scan.rooms;
          else resolvedSpaceRooms = { main: aliasRoomId };
          return aliasRoomId;
        }
      }

      // 3. Room genuinely doesn't exist — create it (with canonical alias).
      if (matrixReady && matrixClientRef.current) {
        const displayName = formatSpaceName(selectedSpace!.replace(/^space_/, ''));
        const result = await createSpaceRoom(
          matrixClientRef.current, displayName, session.userId,
        );
        if (result) {
          resolvedSpaceRooms = {
            main: result.mainRoomId,
            ...(result.governanceRoomId ? { governance: result.governanceRoomId } : {}),
          };
          // Re-run space discovery so the new room appears in the browser
          try {
            const entries = discoverSpacesFromMatrix(matrixClientRef.current);
            if (entries.length > 0) setSpaceEntries(entries);
          } catch { /* best effort */ }
          return result.mainRoomId;
        }
      }

      console.warn('[EO-DB] No room ID for space', selectedSpace, '— Matrix sync disabled.');
      return null;
    }

    /**
     * Wrapper: resolve room, then immediately persist + update reactive state.
     * Every successful resolution feeds the UI (via setSpaceRoomId) and IDB
     * (via persistSpaceMeta) so future runs never lose a known room ID.
     */
    async function resolveRoom(): Promise<string | null> {
      const roomId = await resolveOrCreateRoom();
      if (isStale()) return roomId;  // newer run started, don't update state

      if (roomId) {
        setSpaceRoomId(roomId);
        setSpaceRooms(resolvedSpaceRooms ?? null);
        // Persist immediately — don't wait until end of setup
        persistSpaceMeta({
          spaceId: selectedSpace!,
          mainRoomId: roomId,
        }).catch(e => console.warn('[EO-DB] Failed to persist room ID:', e));
      }
      return roomId;
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

      const spaceRoomId = await resolveRoom();
      if (isStale()) return;

      if (existing) {
        // Reuse cached worker — no OPFS re-open, no replay
        if (isStale()) return;
        await init(existing.workerClient);

        // Update mainRoomId if room resolution succeeded on this run
        // (fixes the case where the first run cached null because Matrix
        // wasn't ready yet, but a subsequent re-run resolved the room).
        if (spaceRoomId && !existing.mainRoomId) {
          existing.mainRoomId = spaceRoomId;
          existing.spaceRooms = resolvedSpaceRooms;
        }

        // Try Google Drive hydration if store is empty
        const currentStore = useEoStore.getState().store;
        const cachedSeq = currentStore ? await currentStore.getCurrentSeq() : 0;
        if (cachedSeq === 0 && session.accessToken && selectedSpace) {
          try {
            const dataType = `eodb-${selectedSpace}`;
            const hydratedSeq = await GDriveSyncService.hydrateFromGDrive(
              currentStore!, session.accessToken, dataType, onFoldEvent,
            );
            if (hydratedSeq > 0) {
              await init(existing.workerClient);
            }
          } catch (e) {
            console.warn('[EO-DB] Cache-path GDrive hydration failed for space', selectedSpace, e);
          }
        }

        // Restore cached sync manager
        if (existing.syncManager) {
          useEoStore.getState().setSyncManager(existing.syncManager);
        }

        // Restart Google Drive sync for cached space
        if (existing.gdriveSync) {
          existing.gdriveSync.start().catch(e =>
            console.warn('[EO-DB] Google Drive sync restart failed for cached space', selectedSpace, e),
          );
          useEoStore.getState().setGDriveSync(existing.gdriveSync);
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

      // Open space-scoped OPFS fold worker
      const workerClient = createFoldWorkerClient();
      await initFoldWorker(workerClient, selectedSpace!);
      if (isStale()) { workerClient.worker.terminate(); return; }

      // Cache the worker immediately so that re-runs of this effect reuse
      // the SAME worker instead of creating a new one.
      cache.set(selectedSpace!, { workerClient, syncManager: null, gdriveSync: null, mainRoomId: spaceRoomId, presence: null, spaceRooms: resolvedSpaceRooms });

      await init(workerClient);

      // ── EO-DB server real-time sync ──────────────────────────────────────────
      // If the user has configured a server URL, open a WebSocket to receive
      // field changes from other users in real-time. Each incoming event is
      // folded into the local store and bumps lastSeq so components re-render.
      {
        const { serverUrl, connect: connectServer, disconnect: disconnectServer } = useEoServerStore.getState();
        if (serverUrl && session.accessToken) {
          const storeNow = useEoStore.getState().store;
          const currentSeq = storeNow ? await storeNow.getCurrentSeq() : 0;

          const handleServerEvent = async (event: any) => {
            const s = useEoStore.getState().store;
            if (!s) return;
            await processEvent(s, event, onFoldEvent);
          };

          connectServer(currentSeq, session.accessToken, handleServerEvent);
          useEoStore.getState().setOnDispatch((event) => useEoServerStore.getState().sendEvent(event));

          cleanupFns.push(() => {
            disconnectServer();
            useEoStore.getState().setOnDispatch(null);
          });
        }
      }

      let syncManager: SyncManager | null = null;

      // If Matrix is required but we couldn't get a room, surface the error.
      if (MATRIX_ENABLED && !spaceRoomId && matrixClientRef.current) {
        console.warn('[EO-DB] No room for space', selectedSpace, '— cannot start sync.');
        setConnectionError({
          phase: 'room',
          message: 'Could not create or find a room for this space. The homeserver may restrict room creation — try logging out and back in.',
        });
      }

      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
        const maxRetries = 3;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          if (isStale()) return;
          try {
            syncManager = new SyncManager(
              matrixClientRef.current,
              spaceRoomId,
              useEoStore.getState().store!,
              onFoldEvent,
            );
            await syncManager.initialize();
            if (isStale()) { syncManager.destroy(); return; }
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

      // Start Google Drive sync (backup layer via n8n webhook)
      // Auto-creates the Drive folder for the space if it doesn't exist
      // (n8n's Google Drive node uses folderId mode "name", which auto-creates).
      let gdriveSync: GDriveSyncService | null = null;

      if (selectedSpace && session.accessToken) {
        try {
          // Connect to Google Drive via n8n webhook (validates Matrix token)
          const gdriveState = useGDriveStore.getState();
          if (!gdriveState.connected) {
            await gdriveState.connect(session.accessToken);
            console.log('[EO-DB] Google Drive auto-connected via n8n webhook');
          }

          // Find the space name
          const gdriveSpaceEntry = mergedEntries.find(e => {
            const target = 'canonical' in e ? (e as any).canonical : (e as any).target;
            return target === selectedSpace;
          });
          const gdriveSpaceName = gdriveSpaceEntry ? ((gdriveSpaceEntry as any).name || selectedSpace) : selectedSpace;

          // Set current space in GDrive store
          useGDriveStore.getState().setCurrentSpace(selectedSpace, gdriveSpaceName);

          // On fresh device (seq=0), hydrate from Google Drive before starting sync
          const activeStore = useEoStore.getState().store!;
          const gdriveCurrentSeq = activeStore ? await activeStore.getCurrentSeq() : 0;
          if (gdriveCurrentSeq === 0) {
            try {
              const dataType = `eodb-${selectedSpace}`;
              const gdriveHydratedSeq = await GDriveSyncService.hydrateFromGDrive(
                activeStore, session.accessToken, dataType, onFoldEvent,
              );
              if (gdriveHydratedSeq > 0) {
                await init(workerClient);
              }
            } catch (e) {
              console.warn('[EO-DB] Google Drive hydration failed for space', selectedSpace, e);
            }
          }

          gdriveSync = new GDriveSyncService({
            store: useEoStore.getState().store!,
            spaceId: selectedSpace,
            spaceName: gdriveSpaceName,
            userId: session.userId,
            matrixAccessToken: session.accessToken,
            matrixClient: matrixClientRef.current || undefined,
            roomId: spaceRoomId || undefined,
            onEvent: onFoldEvent,
            onHydrated: () => { init(workerClient); },
          });
          await gdriveSync.start();
          useEoStore.getState().setGDriveSync(gdriveSync);
        } catch (e) {
          console.warn('[EO-DB] Google Drive sync start failed for space', selectedSpace, e);
          gdriveSync = null;
        }
      }

      // Start presence heartbeat for the space room (Matrix to-device pings).
      // Independent of SyncManager — works in all sync modes.
      let presenceInstance: Presence | null = null;
      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
        try {
          presenceInstance = new Presence(matrixClientRef.current, spaceRoomId);
          await presenceInstance.start();
          if (isStale()) {
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

      // Persist space metadata to root IndexedDB so the app can reconnect
      // to Google Drive without needing Matrix for space discovery.
      {
        const spaceEntry = mergedEntries.find(e => e.spaceTarget === selectedSpace);
        persistSpaceMeta({
          spaceId: selectedSpace!,
          spaceName: spaceEntry?.displayName || selectedSpace!,
          // Only persist mainRoomId if we actually resolved one — avoid
          // overwriting a previously saved room ID with an empty string
          // when Matrix isn't ready yet on this run.
          ...(spaceRoomId ? { mainRoomId: spaceRoomId } : {}),
        }).catch(e => console.warn('[EO-DB] Failed to persist space meta:', e));
      }

      // Update the cached entry with sync services (worker was cached earlier
      // to prevent race conditions; now enrich with fully-initialized services).
      cache.set(selectedSpace!, { workerClient, syncManager, gdriveSync, mainRoomId: spaceRoomId, presence: presenceInstance, spaceRooms: resolvedSpaceRooms });
    }

    setupSpaceStore();

    return () => {
      mounted = false;
      cleanupFns.forEach(fn => fn());
    };
    // Note: spaceRoomId/spaceRooms are intentionally NOT in the dep array —
    // they are outputs of this effect, not inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (cached.gdriveSync) {
        savePromises.push(cached.gdriveSync.forceSave().catch((err) => {
              console.warn('[EO-DB] Google Drive save failed:', err);
            }));
      }
    }
    await Promise.all(savePromises);

    for (const [, cached] of cache) {
      if (cached.gdriveSync) cached.gdriveSync.stop();
      cached.workerClient.worker.terminate();
    }
    cache.clear();

    teardown();
    logout();

    // Clear all OPFS space directories so stale content doesn't persist
    // across sign-out / account switches.
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of (root as any).entries()) {
        if (typeof name === 'string' && name.startsWith('space.')) {
          await root.removeEntry(name, { recursive: true }).catch(() => {});
        }
      }
    } catch { /* best effort */ }
    // Clear persisted space metadata from localStorage.
    clearAllSpaceMetas();
    // Also clear Matrix crypto stores — they use a different prefix and
    // would otherwise cause device-ID mismatches on the next login.
    await clearMatrixCryptoStore();

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
          if (cached.gdriveSync) {
            promises.push(cached.gdriveSync.forceSave().catch((err) => {
              console.warn('[EO-DB] Google Drive save failed:', err);
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
    api: '\uD83D\uDD17', // link icon
    builder: '\u2B1A',  // blocks
    settings: '\u2699', // gear
    messages: '\uD83D\uDCAC', // speech bubble
    people: '\u2689', // people icon
    members: '\u2736', // star/members icon
    multiuser: '\u2194', // left-right arrow
  };

  // --- Permission resolution ---
  const currentSpaceState = useMemo(() => {
    return spaces.find(s => normalizeSpaceTarget(s.target) === selectedSpace);
  }, [spaces, selectedSpace]);
  const activeUserType = useEoStore((st) => st.activeUserType);
  const setActiveUserType = useEoStore((st) => st.setActiveUserType);

  // User type definitions & assignments from space state
  const spaceUserTypeDefinitions: UserTypeDefinition[] = currentSpaceState?.value?._user_type_definitions || [];
  const spaceUserTypeAssignments = currentSpaceState?.value?._user_type_assignments || [];
  const spaceFieldTypeVisibility = currentSpaceState?.value?._field_type_visibility || [];

  // Active role definition and its background tint (computed after spaceUserTypeDefinitions is available)
  const activeTypeDef = spaceUserTypeDefinitions.find(d => d.id === activeUserType) ?? null;
  const roleTint = roleBackgroundTint(activeTypeDef?.color, theme.mode);
  const roleAccentColor = activeTypeDef?.color ?? null;
  const currentUserAssignedTypes: string[] = useMemo(() => {
    const assignment = spaceUserTypeAssignments.find(
      (a: { user_id: string }) => a.user_id === session.userId,
    );
    return assignment?.type_ids ?? [];
  }, [spaceUserTypeAssignments, session.userId]);

  // Restore active user type from localStorage on space change
  useEffect(() => {
    try {
      const saved = localStorage.getItem('eo-active-user-type');
      if (saved && currentUserAssignedTypes.includes(saved)) {
        setActiveUserType(saved);
      } else if (currentUserAssignedTypes.length > 0) {
        setActiveUserType(currentUserAssignedTypes[0]);
      } else {
        setActiveUserType(null);
      }
    } catch {
      setActiveUserType(null);
    }
  }, [selectedSpace, currentUserAssignedTypes]);

  // When the active role restricts nav views, redirect away from now-hidden views
  useEffect(() => {
    if (activeTypeDef?.visible_views?.length && !activeTypeDef.visible_views.includes(activeView)) {
      navigate({ view: 'records' });
    }
  }, [activeUserType]);

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
    return resolvePermissionsFromSharing(
      session.userId, owner, sharing, fieldAssignments,
      spaceUserTypeAssignments, spaceFieldTypeVisibility, activeUserType,
    );
  }, [currentSpaceState, session.userId, selectedSpace, spaceUserTypeAssignments, spaceFieldTypeVisibility, activeUserType]);
  const currentRole: AccessRole = currentPermissions?.role ?? 'viewer';
  const isViewer = currentRole === 'viewer';

  // Determine active slice type from saved slice
  const sliceStore = useSliceStore();
  const sliceSigs = sliceStore.sigs;
  const savedSlices = sliceStore.savedSlices;
  const openScopes = sliceStore.openScopes;
  const activeSliceType: SliceType = useMemo(() => {
    if (!selectedScope) return 'grid';
    const sig = sliceSigs[selectedScope];
    if (!sig) return 'grid';
    if (sig.activeSliceId === '__schema') return 'schema';
    if (!sig.activeSliceId) return 'grid';
    const sv = savedSlices[sig.activeSliceId];
    return sv?.sliceType || 'grid';
  }, [selectedScope, sliceSigs, savedSlices]);

  const mono = "'JetBrains Mono', monospace";

  return (
    <div style={{
      ...s.container,
      background: roleTint ? roleTint.bg : themedBg.bg,
      transition: 'background 0.5s cubic-bezier(.4,0,.2,1)',
    }}>
      {/* Top bar */}
      <header style={{
        ...s.topBar,
        background: roleTint ? roleTint.bgCard : themedBg.bgCard,
        borderBottom: `1px solid ${roleTint ? roleTint.border : themedBg.border}`,
        boxShadow: roleAccentColor
          ? `0 2px 0 0 ${roleAccentColor}50`
          : s.topBar.boxShadow ?? 'none',
        transition: 'background 0.4s, border-color 0.4s, box-shadow 0.4s',
      }}>
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
              matrixReady={!MATRIX_ENABLED || matrixReady}
              activeSpace={selectedSpace}
              onSelect={(target) => {
                selectSpace(target);
                setSpaceOpen(false);
                setShowMembers(false);
                setShowRecycleBin(false);
              }}
              onClose={() => setSpaceOpen(false)}
              onCreate={async (name, opts) => {
                // ── Gate: Matrix MUST be connected ──
                if (MATRIX_ENABLED && (!matrixReady || !matrixClientRef.current)) {
                  throw new Error('Cannot create a space while Matrix is disconnected. Wait for connection or check your login.');
                }

                const spaceTarget = `space_${name.toLowerCase().replace(/\s+/g, '_')}`;
                const client = matrixClientRef.current!;

                // ── Step 1: Create Matrix rooms (main + governance) ──
                const roomResult = await createSpaceRoom(
                  client, name, session.userId,
                  {
                    discoverability: opts?.discoverability ?? 'public',
                    inviteUserIds: opts?.inviteUserIds,
                  },
                );
                if (!roomResult) {
                  throw new Error('Failed to create Matrix rooms for this space. The homeserver may be unreachable or restricting room creation.');
                }
                const { mainRoomId, governanceRoomId } = roomResult;
                const spaceRooms: SpaceConfig['rooms'] = {
                  main: mainRoomId,
                  ...(governanceRoomId ? { governance: governanceRoomId } : {}),
                };

                // ── Step 2: Refresh discovery ──
                try {
                  const entries = discoverSpacesFromMatrix(client);
                  if (entries.length > 0) setSpaceEntries(entries);
                } catch { /* best effort */ }

                // ── Step 3: Create OPFS fold worker for the new space ──
                const newSpaceWorker = createFoldWorkerClient();
                await initFoldWorker(newSpaceWorker, spaceTarget);
                await init(newSpaceWorker);

                // Cache with full topology so Settings and sync resolve correctly
                spaceCacheRef.current.set(spaceTarget, {
                  workerClient: newSpaceWorker,
                  syncManager: null,
                  gdriveSync: null,
                  mainRoomId,
                  presence: null,
                  spaceRooms,
                });

                // Dispatch INS event
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

                // Register space metadata in localStorage so it survives page reload without Matrix
                saveSpaceMeta({
                  spaceId: idbTarget,
                  spaceName: name,
                  mainRoomId: mainRoomId || '',
                });

                selectSpace(spaceTarget);
                setSpaceOpen(false);
              }}
              onDelete={handleDeleteSpace}
              onArchive={handleArchiveSpace}
              onOpenRecycleBin={() => { setShowRecycleBin(true); setSpaceOpen(false); }}
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
              onClick={() => navigate({ view: 'members' })}
              style={{
                ...s.headerButton,
                ...(activeView === 'members' ? { background: theme.accent, color: '#fff' } : {}),
              }}
              title="Space members &amp; roles"
            >
              {'\u2736'} {/* star icon */}
              <span style={{ fontSize: 11 }}>Members</span>
            </button>
          )}
        </div>

        <div style={s.topBarRight}>
          {/* Stats — hidden on mobile, compact on tablet */}
          {!isMobile && (
            <OnlineUsers
              presence={presence}
              selfUserId={session.userId}
              selfDisplayName={displayName}
            />
          )}
          <ConnectionStatus
            state={connectionState}
            onRetry={connectionError?.phase === 'auth' ? handleLogout : retrySync}
            errorMessage={connectionMessage}
            retryLabel={connectionError?.phase === 'auth' ? 'Re-login' : undefined}
          />
          {!isMobile && <SyncToast status={syncToastStatus} seq={syncToastSeq} />}
          {selectedSpace && !isMobile && (
            <PermissionBadge role={currentRole} displayName={displayName} />
          )}
          {/* User type switcher */}
          {selectedSpace && !isMobile && currentUserAssignedTypes.length > 0 && (
            <UserTypeSwitcher
              typeDefinitions={spaceUserTypeDefinitions}
              assignedTypeIds={currentUserAssignedTypes}
              activeTypeId={activeUserType}
              onSelect={setActiveUserType}
            />
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
            <div style={{
              ...s.avatar,
              border: roleAccentColor ? `2px solid ${roleAccentColor}60` : (s.avatar as React.CSSProperties & { border?: string }).border,
              transition: 'border-color 0.4s',
            }}>{displayName.charAt(0).toUpperCase()}</div>
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

      {/* Role banner — appears when an active user type (role) is selected */}
      {activeTypeDef && roleAccentColor && (
        <div style={{
          background: `${roleAccentColor}12`,
          borderBottom: `1px solid ${roleAccentColor}25`,
          padding: '5px 16px',
          display: 'flex', alignItems: 'center', gap: 8,
          fontFamily: mono, fontSize: 11,
          flexShrink: 0,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: roleAccentColor, flexShrink: 0 }} />
          <span style={{ color: roleAccentColor, fontWeight: 600 }}>Viewing as {activeTypeDef.label}</span>
          {activeTypeDef.description && (
            <>
              <span style={{ color: roleAccentColor, opacity: 0.5 }}>·</span>
              <span style={{ color: roleAccentColor, opacity: 0.7 }}>{activeTypeDef.description}</span>
            </>
          )}
          {activeTypeDef.visible_views && (
            <>
              <span style={{ color: roleAccentColor, opacity: 0.5 }}>·</span>
              <span style={{ color: roleAccentColor, opacity: 0.7 }}>
                {activeTypeDef.visible_views.length} of 8 views
              </span>
            </>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={() => setActiveUserType(null)}
            style={{
              fontFamily: mono, fontSize: 11, fontWeight: 600,
              color: roleAccentColor, background: 'none',
              border: `1px solid ${roleAccentColor}40`, borderRadius: 6,
              padding: '3px 8px', cursor: 'pointer',
            }}
          >Exit role</button>
        </div>
      )}

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

      {/* Headline metrics — type-scoped, under Horizon */}
      {activeView === 'records' && activeUserType && (() => {
        const activeDef = spaceUserTypeDefinitions.find(d => d.id === activeUserType);
        const metrics = activeDef?.headline_metrics;
        if (!metrics || metrics.length === 0) return null;
        return (
          <HeadlineMetrics
            metrics={metrics}
            records={scopedRecords}
            typeColor={activeDef?.color}
          />
        );
      })()}

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
          background: roleTint ? roleTint.bgCard : s.sidebar.background,
          borderRight: roleTint ? `1px solid ${roleTint.border}` : s.sidebar.borderRight,
          transition: 'background 0.5s, border-color 0.4s',
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
              {showStoreLoading && (
                <SyncProgress message="Initializing store..." detail="Deriving encryption key" />
              )}
              <HolonNav
                selectedScope={selectedScope}
                onSelectScope={(scope) => { navigate({ view: 'records', scope, record: null }); }}
                onSelectSegment={(_scope, _seg) => { navigate({ view: 'records', scope: _scope }); }}
                userId={session.userId}
                selectedRecord={selectedRecord}
                onSelectRecord={(rec) => { setRecordOpenedViaNav(true); navigate({ record: rec }); }}
              />
            </>
          )}

          {selectedSpace && (() => {
            // Helper: is this view visible given the active role's visible_views restriction?
            function isNavViewVisible(view: View): boolean {
              if (!activeTypeDef?.visible_views?.length) return true;
              return activeTypeDef.visible_views.includes(view);
            }
            // Helper: nav item style, applying role color to active items
            function navItemStyle(view: View): React.CSSProperties {
              const active = activeView === view;
              return {
                ...s.navItem,
                ...(active ? s.navItemActive : {}),
                ...(active && roleAccentColor ? {
                  background: `${roleAccentColor}18`,
                  color: roleAccentColor,
                  borderLeft: `3px solid ${roleAccentColor}`,
                } : {}),
              };
            }
            // Configurable views (excludes records/multiuser which are special-cased)
            const CONFIGURABLE_VIEWS: View[] = ['compose', 'import', 'api', 'people', 'messages', 'members', 'log', 'builder', 'settings'];
            const hiddenCount = activeTypeDef?.visible_views
              ? CONFIGURABLE_VIEWS.filter(v => !activeTypeDef.visible_views!.includes(v)).length
              : 0;
            return (
          <nav style={s.sidebarNav}>
            <div style={s.navGroupLabel}>Actions</div>
            {(['compose', 'import'] as View[]).map((view) => isNavViewVisible(view) && (
              <button
                key={view}
                onClick={() => { navigate({ view }); }}
                style={navItemStyle(view)}
              >
                <span style={s.navIcon}>{NAV_ICONS[view]}</span>
                {view === 'compose' ? '+ Compose' : view.charAt(0).toUpperCase() + view.slice(1)}
              </button>
            ))}
            {isNavViewVisible('api') && (
              <button
                onClick={() => { navigate({ view: 'api' }); }}
                style={navItemStyle('api')}
              >
                <span style={s.navIcon}>{NAV_ICONS.api}</span>
                API Connections
              </button>
            )}
            <div style={s.navGroupLabel}>Collaborate</div>
            {isNavViewVisible('people') && (
              <button
                onClick={() => navigate({ view: 'people' })}
                style={navItemStyle('people')}
              >
                <span style={s.navIcon}>{NAV_ICONS.people}</span>
                People
              </button>
            )}
            {isNavViewVisible('messages') && (
              <button
                onClick={() => navigate({ view: 'messages' })}
                style={navItemStyle('messages')}
              >
                <span style={s.navIcon}>{NAV_ICONS.messages}</span>
                Messages
              </button>
            )}
            {isNavViewVisible('members') && (
              <button
                onClick={() => navigate({ view: 'members' })}
                style={navItemStyle('members')}
              >
                <span style={s.navIcon}>{NAV_ICONS.members}</span>
                Members &amp; Roles
              </button>
            )}
            <div style={s.navGroupLabel}>System</div>
            {isNavViewVisible('log') && (
              <button
                onClick={() => { navigate({ view: 'log' }); }}
                style={navItemStyle('log')}
              >
                <span style={s.navIcon}>{NAV_ICONS.log}</span>
                Log
              </button>
            )}
            {currentPermissions?.can_build_slices !== false && isNavViewVisible('builder') && (
              <button
                onClick={() => { navigate({ view: 'builder', builderViewId: null, customPageId: null }); }}
                style={navItemStyle('builder')}
              >
                <span style={s.navIcon}>{NAV_ICONS.builder}</span>
                Builder
              </button>
            )}
            {currentPermissions?.can_set_governance !== false && isNavViewVisible('settings') && (
              <button
                onClick={() => { navigate({ view: 'settings' }); }}
                style={navItemStyle('settings')}
              >
                <span style={s.navIcon}>{NAV_ICONS.settings}</span>
                Settings
              </button>
            )}
            <div style={s.navGroupLabel}>Testing</div>
            <button
              onClick={() => { navigate({ view: 'multiuser' }); }}
              style={navItemStyle('multiuser')}
            >
              <span style={s.navIcon}>{NAV_ICONS.multiuser}</span>
              Multi-User Test
            </button>
            {/* Hidden views badge — shown when role restricts nav access */}
            {hiddenCount > 0 && roleAccentColor && (
              <div style={{
                marginTop: 'auto', padding: '8px 12px',
                fontFamily: mono, fontSize: 10, color: roleAccentColor,
                background: `${roleAccentColor}12`,
                borderTop: `1px solid ${roleAccentColor}25`,
                borderRadius: '0 0 0 0',
              }}>
                {hiddenCount} view{hiddenCount !== 1 ? 's' : ''} hidden by role
              </div>
            )}
          </nav>
            );
          })()}
        </aside>

        <main style={s.main} key={selectedSpace ?? '__all__'}>
          {/* Time-travel indicator — fades in when Horizon slider is in the past */}
          {pastnessFraction > 0 && pastDateLabel && (
            <div style={{
              position: 'absolute', top: 10, right: 16, zIndex: 10,
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 10px', borderRadius: 20,
              background: theme.bgCard, border: `1px solid ${theme.border}`,
              fontSize: 11, fontFamily: "'JetBrains Mono', monospace",
              color: theme.textSecondary,
              opacity: Math.min(1, pastnessFraction * 1.5 + 0.25),
              transition: 'opacity 0.3s ease',
              pointerEvents: 'none', userSelect: 'none',
            }}>
              <span style={{ opacity: 0.6 }}>{'◷'}</span>
              {pastDateLabel}
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
                    <SliceTabs
                      openScopes={openScopes.length > 0 ? openScopes : [selectedScope]}
                      activeScope={selectedScope}
                      onSelectScope={(sc) => navigate({ view: 'records', scope: sc, record: null })}
                      onCloseScope={(sc) => {
                        sliceStore.closeScope(sc);
                        if (sc === selectedScope) {
                          const remaining = sliceStore.getOpenScopes();
                          navigate({ scope: remaining[0] || null, record: null });
                        }
                      }}
                      session={{ userId: session.userId }}
                      activeUserType={activeUserType}
                      userTypeDefinitions={spaceUserTypeDefinitions}
                      canManageSlices={currentPermissions?.can_build_slices}
                    />
                    <ScopeBreadcrumb
                      scope={selectedScope}
                      allStates={allStates}
                      theme={theme}
                      onNavigate={(sc) => navigate({ view: 'records', scope: sc, record: null })}
                    />
                    {activeSliceType === 'schema' ? (
                      <SchemaView
                        scope={selectedScope}
                      />
                    ) : activeSliceType === 'graph' ? (
                      <GraphView allStates={allStates} />
                    ) : activeSliceType === 'grid' ? (
                      <TableView
                        scope={selectedScope}
                        onSelectRecord={(rec) => navigate({ record: rec })}
                        onEmptyScope={(parentScope) => navigate({ scope: parentScope, record: null })}
                        activeRecord={selectedRecord}
                        session={{ userId: session.userId }}
                        timeScrubberFilter={timeScrubberFilter}
                        permissions={currentPermissions}
                        onVisibleRecordTargets={setTableRecordTargets}
                        sliceReadOnly={(() => {
                          if (!activeUserType) return false;
                          const sig = sliceSigs[selectedScope];
                          if (!sig?.activeSliceId) return false;
                          const sv = savedSlices[sig.activeSliceId];
                          return sv?.readOnlyForTypes?.includes(activeUserType) ?? false;
                        })()}
                      />
                    ) : (
                      <div style={{
                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'column' as const, gap: 8, color: theme.textMuted,
                      }}>
                        <div style={{ fontSize: 28, opacity: 0.3 }}>
                          {activeSliceType === 'kanban' ? '\u25A5' : activeSliceType === 'calendar' ? '\u25F7' : '\u25A6'}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>
                          {activeSliceType.charAt(0).toUpperCase() + activeSliceType.slice(1)} slice
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.7 }}>Coming soon</div>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={s.empty}>
                    <div style={s.emptyIcon}>{'\u25A6'}</div>
                    <div style={s.emptyText}>Select a collection to get started</div>
                    <div style={s.emptySub}>
                      Pick a collection from the sidebar to view its schema
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
            ) : activeView === 'members' ? (
              selectedSpace ? (
                <div style={{ padding: '20px 28px', maxWidth: 560 }}>
                  <SpaceMembers
                    spaceTarget={selectedSpace}
                    currentUserId={session.userId}
                    onClose={() => navigate({ view: 'records' })}
                    matrixClient={matrixClientRef.current}
                    mainRoomId={spaceRoomId}
                  />
                </div>
              ) : (
                <div style={s.empty}>
                  <div style={s.emptyIcon}>{'\u2736'}</div>
                  <div style={s.emptyText}>No space selected</div>
                  <div style={s.emptySub}>Select a space to manage its members and roles.</div>
                </div>
              )
            ) : activeView === 'settings' ? (
              <SettingsView session={session} matrixClient={matrixClientRef.current} roomId={spaceRoomId} spaceRooms={spaceRooms ?? null} onUnarchive={handleUnarchiveSpace} connectionState={connectionState} connectionError={connectionError} matrixReady={matrixReady} onRetry={retrySync} onLogout={handleLogout} />
            ) : activeView === 'multiuser' ? (
              <MultiUserTestView matrixClient={matrixClientRef.current} roomId={spaceRoomId} presence={presence} />
            ) : activeView === 'api' ? (
              <ApiConnectionsView />
            ) : null}
          </ErrorBoundary>}
        </main>

        {selectedRecord && activeView === 'records' && (
          <RecordPageOrDrawer
            recordTarget={selectedRecord}
            allStates={allStates}
            onClose={() => { setRecordOpenedViaNav(false); navigate({ record: null }); }}
            onNavigate={(t) => { setRecordOpenedViaNav(false); navigate({ record: t }); }}
            profileFields={selectedScope ? sliceStore.getConfig(selectedScope).profileFields : undefined}
            isMobile={isMobile}
            tableRecordTargets={tableRecordTargets}
            layoutOverride={recordOpenedViaNav ? 'modal' : undefined}
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
function RecordPageOrDrawer({ recordTarget, allStates, onClose, onNavigate, profileFields, isMobile, tableRecordTargets, layoutOverride }: {
  recordTarget: string;
  allStates: EoState[];
  onClose: () => void;
  onNavigate: (target: string) => void;
  profileFields?: string[];
  isMobile?: boolean;
  tableRecordTargets?: string[];
  layoutOverride?: LayoutDisplayType;
}) {
  const loadView = useBuilderStore((s) => s.loadView);
  const getState = useEoStore((s) => s.getState);
  const [layoutType, setLayoutType] = useState<LayoutDisplayType>('drawer');

  // Read layout type from the detail layout DEF
  useEffect(() => {
    const parts = recordTarget.split('.');
    const scope = parts.length >= 2 ? parts.slice(0, -1).join('.') : recordTarget;
    getState(detailLayoutTarget(scope))
      .then((state) => {
        if (state?.value?.layoutType) setLayoutType(state.value.layoutType as LayoutDisplayType);
        else setLayoutType('drawer');
      })
      .catch(() => {});
  }, [recordTarget, getState]);

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
      layoutType={layoutOverride ?? layoutType}
      tableRecordTargets={tableRecordTargets}
    />
  );
}

// ---------------------------------------------------------------------------
// ScopeBreadcrumb — clickable path navigation above grid/schema
// ---------------------------------------------------------------------------

interface ScopeBreadcrumbProps {
  scope: string;
  allStates: EoState[];
  theme: Theme;
  onNavigate: (scope: string) => void;
}

function ScopeBreadcrumb({ scope, allStates, theme, onNavigate }: ScopeBreadcrumbProps) {
  const parts = scope.split('.');
  // Cap at last 3 segments for narrow layouts
  const showEllipsis = parts.length > 3;
  const visibleParts = showEllipsis ? parts.slice(-3) : parts;
  const startIndex = showEllipsis ? parts.length - 3 : 0;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 12px',
        borderBottom: `1px solid ${theme.borderLight}`,
        fontSize: 11,
        color: theme.textMuted,
        flexWrap: 'nowrap' as const,
        overflow: 'hidden',
        minHeight: 26,
        flexShrink: 0,
        background: theme.bgCard,
      }}
    >
      {showEllipsis && (
        <>
          <span style={{ color: theme.textMuted, opacity: 0.5 }}>&hellip;</span>
          <span style={{ color: theme.borderLight, margin: '0 2px' }}>/</span>
        </>
      )}
      {visibleParts.map((seg, i) => {
        const actualIndex = startIndex + i;
        const fullPath = parts.slice(0, actualIndex + 1).join('.');
        const isLast = actualIndex === parts.length - 1;
        const stateForSeg = allStates.find((st) => st.target === fullPath);
        const label = (stateForSeg?.value?.name as string | undefined) || formatName(seg);

        return (
          <span key={fullPath} style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            {i > 0 && (
              <span style={{ color: theme.borderLight, flexShrink: 0, margin: '0 1px' }}>/</span>
            )}
            <span
              onClick={isLast ? undefined : () => onNavigate(fullPath)}
              style={{
                fontWeight: isLast ? 600 : 400,
                color: isLast ? theme.text : theme.accent,
                cursor: isLast ? 'default' : 'pointer',
                padding: '1px 3px',
                borderRadius: 3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' as const,
                maxWidth: 160,
                flexShrink: 1,
              }}
              title={label}
            >
              {label}
            </span>
          </span>
        );
      })}
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
      position: 'relative' as const,
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
