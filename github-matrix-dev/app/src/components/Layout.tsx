import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, lazy, Suspense, type ComponentType } from 'react';
import { logout, createMatrixClient, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { persistSpaceMeta, listSpaceMeta, clearAllSpaceMetas, saveSpaceMeta, removeSpaceMeta } from '../db/space-meta';
import { clearSpaceLocalData } from '../db/clear-space-data';
import { Modal } from './Modal';
import { createFoldWorkerClient, initFoldWorker, type FoldWorkerClient } from '../db/lazy-fold';
import { SyncManager, eraseOfflineQueueDb } from '../matrix/sync-manager';
import { PeerSync } from '../matrix/peer-sync';
import { WebRTCPeer } from '../matrix/webrtc-peer';
import {
  hydrateBlocksIfStale,
  listenForChainUpdates,
  isAutoIngestEnabled,
  clearAllHydratedHeadMarkers,
  getPersistedHydratedHead,
  setPersistedHydratedHead,
} from '../sync/block-hydration';
import type { BlockDriveMirrorDeps } from '../sync/block-drive-mirror';
import {
  startNetworkSyncSystem,
  isOperatorSyncEnabled,
  type NetworkSyncSystem,
} from '../sync/network-sync-system';
import { Presence, type PresenceUser } from '../matrix/presence';
import { usePresencePrefs } from '../lib/presence-prefs';
import { OnlineUsers } from './OnlineUsers';
import {
  loadSpaceKeyring,
  generateSpaceKey,
  importDeliveredKey,
  exportKeyMaterial,
} from '../crypto/keyring-store';
import {
  KEY_DELIVER_TYPE,
  KEY_HEAL_REQUEST_TYPE,
  KEY_HEAL_RESPONSE_TYPE,
  type KeyDeliverPayload,
  type KeyHealRequest,
  type KeyHealResponse,
} from '../crypto/key-delivery';
import { useAirtableStore } from '../ingestion/airtable-store';
import { resolveDataRoom } from '../matrix/event-bridge';
import { configureMatrixDomain, isAminoHomeserver } from '../lib/matrix-domain';
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
import { AirtableSyncBadge } from './AirtableSyncBadge';
import { ErrorBoundary } from './ErrorBoundary';
import { PressureBadge } from './PressureBadge';
import { SyncProgress } from './SyncProgress';
// Lazily-loaded views — split into separate chunks so the initial bundle
// does not include code that users may never visit.
//
// `lazyWithRetry` wraps React.lazy() so that when a dynamic import fails
// because the chunk's content hash changed after a deploy (the old hashed
// file has been deleted from GitHub Pages), we force-refresh index.html and
// reload. Without this, an open tab loaded from a previous deploy shows
// "Failed to fetch dynamically imported module" the moment the user
// navigates to any lazy view, and ErrorBoundary's "Try again" button can't
// recover because the chunk is still missing.
import { isChunkLoadError, tryRecoverFromChunkError, clearChunkReloadGuard } from '../lib/chunk-reload';
function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): ReturnType<typeof lazy<T>> {
  return lazy(async () => {
    try {
      const mod = await factory();
      // Successful load — clear the reload guard so a future stale-deploy
      // error in the same session can reload again.
      clearChunkReloadGuard();
      return mod;
    } catch (err) {
      if (isChunkLoadError(err) && tryRecoverFromChunkError()) {
        // Return a never-resolving promise so React's Suspense keeps showing
        // the fallback (not the error) while the page reloads.
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}
const LogView = lazyWithRetry(() => import('./LogView').then(m => ({ default: m.LogView })));
const ComposeView = lazyWithRetry(() => import('./ComposeView').then(m => ({ default: m.ComposeView })));
const GraphView = lazyWithRetry(() => import('./GraphView').then(m => ({ default: m.GraphView })));
const SchemaView = lazyWithRetry(() => import('./SchemaView').then(m => ({ default: m.SchemaView })));
const KanbanView = lazyWithRetry(() => import('./KanbanView').then(m => ({ default: m.KanbanView })));
const CalendarView = lazyWithRetry(() => import('./CalendarView').then(m => ({ default: m.CalendarView })));
const SettingsView = lazyWithRetry(() => import('./SettingsView').then(m => ({ default: m.SettingsView })));
const SpaceMembers = lazyWithRetry(() => import('./SpaceMembers').then(m => ({ default: m.SpaceMembers })));
const ImportView = lazyWithRetry(() => import('./ImportView').then(m => ({ default: m.ImportView })));
const BuilderView = lazyWithRetry(() => import('./builder/BuilderView').then(m => ({ default: m.BuilderView })));
const PeopleView = lazyWithRetry(() => import('./PeopleView').then(m => ({ default: m.PeopleView })));
const RecordPageView = lazyWithRetry(() => import('./builder/RecordPageView').then(m => ({ default: m.RecordPageView })));
import { PermissionBadge } from './PermissionBadge';
import { ViewOnlyBanner } from './ViewOnlyBanner';
import { HeadlineMetrics } from './HeadlineMetrics';
import { PersonaQuickActions } from './PersonaQuickActions';
import { useSliceStore } from '../store/slice-store';
import { useBuilderStore } from '../store/builder-store';
import { useSyncStore } from '../store/sync-store';
import { useTheme, spaceBackgroundTint, roleBackgroundTint, type Theme } from '../theme';
import type { EoState } from '../db/types';
import type { ViewDefinition } from '../blocks/types';
import type { SliceType } from './slice-types';
import { discoverSpacesFromMatrix, discoverPublicSpaces, type SpaceEntry } from '../matrix/space-discovery';
import { SpaceBrowser } from './SpaceBrowser';
import { Horizon } from './Horizon';
import { type TimeScrubberFilter, type DateColumnOption, DEFAULT_FILTER, detectDateColumns, computeDateRange, buildAdaptiveFormatter } from './time-scrubber-utils';
import { hasFieldsSubObject, buildFieldNameMap } from './filter-types';
import { useHashRoute, type View, type AppRoute } from '../lib/router';
import { TabBar } from './TabBar';
import { useTabsStore, routeFromTab, defaultTitleFor, defaultIconFor } from '../store/tabs-store';
import { type AccessRole, type UserTypeDefinition, type SpaceConfig, type TerminologyKey, powerLevelToRole, legacyAccessToRole, resolveTerminology } from '../permissions/types';
import { DEFAULT_LAW_FIRM_PERSONAS } from '../permissions/default-personas';
import { UserTypeSwitcher } from './UserTypeSwitcher';
import { resolvePermissionsFromSharing, getUserPowerLevel } from '../permissions/resolve';
const MultiUserTestView = lazyWithRetry(() => import('./MultiUserTestView').then(m => ({ default: m.MultiUserTestView })));
import { RecycleBin, addDeletedSpace, isSpaceDeleted, removeDeletedSpace, getDeletedSpaces } from './RecycleBin';
import { addArchivedSpace, isSpaceArchived, removeArchivedSpace, getArchivedSpaces } from './ArchivedSpaces';
import { setSpaceConfig, getSpaceConfig, applyEoPowerLevels, EO_SPACE_CONFIG_TYPE } from '../permissions/room-topology';
import { EO_POWER_LEVEL_CONTENT } from '../permissions/types';
import { listAllHomeserverUsers } from '../matrix/user-discovery';
import { withRetry } from '../matrix/connection-resilience';
import { invalidateStatsCache } from '../db/space-statistics';
import { useApiConnectionStore } from '../store/api-connection-store';

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
 * Build the deps `hydrateBlocksIfStale` needs to use the Drive mirror as a
 * read fallback. Returns null when the Matrix client has no access token
 * yet (pre-login race) — callers then hydrate from mxc:// only, which is
 * the same behavior as before mirroring existed.
 */
function buildBlockMirror(
  client: ReturnType<typeof createMatrixClient>,
  spaceRoomId: string,
): BlockDriveMirrorDeps | null {
  const token = client.getAccessToken?.();
  if (!token) return null;
  return {
    matrixToken: token,
    spaceRoomId,
    loadKeyring: () => loadSpaceKeyring(spaceRoomId),
  };
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
 *
 * When `spaceTarget` is null, ANY room carrying a valid space config
 * matches. This is used for single-tenant Amino homeservers where there
 * is exactly one space and the URL-derived `space_*` target may not match
 * the config's derived target (e.g. the room is named "Amino Immigration"
 * but the URL says `space_amino`).
 */
function findSpaceRoomByDirectScan(
  client: ReturnType<typeof createMatrixClient>,
  spaceTarget: string | null,
): { mainRoomId: string; rooms: SpaceConfig['rooms'] } | null {
  const rooms = (client as any).getRooms?.() ?? [];
  // When multiple rooms match (duplicate space creation), pick the one with
  // the lexicographically smallest mainRoomId so all clients converge.
  let best: { mainRoomId: string; rooms: SpaceConfig['rooms'] } | null = null;
  for (const room of rooms) {
    // Only consider rooms the user is actually joined to — invited/left
    // rooms expose stale or partial state that must not seed resolution.
    if (room.getMyMembership?.() && room.getMyMembership() !== 'join') continue;

    const configEvent = room.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
    if (!configEvent) continue;

    const config = configEvent.getContent() as SpaceConfig;
    if (!config?.name || !config?.rooms?.main) continue;

    const target = `space_${config.name.toLowerCase().replace(/\s+/g, '_')}`;
    if (spaceTarget === null || target === spaceTarget) {
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
  /** Kept for teardown of old sessions; null in new spaces that use PeerSync. */
  syncManager: SyncManager | null;
  peerSync: PeerSync | null;
  webrtcPeer: WebRTCPeer | null;
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
  // Airtable integration relies on shared n8n proxy credentials scoped to the
  // hosted Amino deployment. Gate UI on the homeserver so users on foreign
  // Matrix servers never see the endpoints.
  const isAmino = isAminoHomeserver(session.homeserver);
  const { route, navigate } = useHashRoute();
  const activeView = route.view;
  const selectedScope = route.scope;
  const selectedRecord = route.record;

  // ─── Browser-style tabs ────────────────────────────────────────────────
  // The tabs store owns the list of open tabs; the active tab's route stays
  // mirrored with the URL hash. `openRouteAsTab` creates a new tab (or
  // focuses an existing one with matching identity) and navigates to it.
  // TabBar subscribes to the store directly, so Layout only subscribes to
  // the active-tab id (needed by the route-sync effect below).
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const tabs = useTabsStore((s) => s.tabs);
  const hydrateTabs = useTabsStore((s) => s.hydrate);
  const openTabAction = useTabsStore((s) => s.openTab);
  const updateActiveTabRoute = useTabsStore((s) => s.updateActiveTab);
  const setTabMeta = useTabsStore((s) => s.setTabMeta);

  // Seed the tabs store from the URL on first mount.
  useEffect(() => {
    if (useTabsStore.getState().tabs.length === 0) {
      const initial = {
        id: crypto.randomUUID ? crypto.randomUUID() : `tab_${Date.now().toString(36)}`,
        view: route.view,
        space: route.space,
        scope: route.scope,
        record: route.record,
        builderViewId: route.builderViewId,
        customPageId: route.customPageId,
        query: route.query,
        title: defaultTitleFor(route),
        icon: defaultIconFor(route),
      };
      hydrateTabs([initial], initial.id);
    }
    // Run once on mount — subsequent route sync is handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the active tab's route in sync with the URL (covers back/forward
  // navigation and navigate() calls alike).
  useEffect(() => {
    if (!activeTabId) return;
    updateActiveTabRoute(route);
  }, [route, activeTabId, updateActiveTabRoute]);

  /** Open a new tab for the given route partial, focus it, and update the URL. */
  const openRouteAsTab = useCallback(
    (partial: Partial<AppRoute> & { title?: string; icon?: string }, opts?: { reuseByView?: boolean }) => {
      openTabAction(partial, { reuseByView: opts?.reuseByView });
      navigate(partial);
    },
    [openTabAction, navigate],
  );
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
  // When the user clicks a different space in SpaceBrowser we stash the
  // target here and surface the wipe-confirmation modal instead of switching
  // immediately. `confirmSpaceSwitch` is the only code path that actually
  // advances the space after a user-initiated switch.
  const [pendingSpaceSwitch, setPendingSpaceSwitch] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const isNarrow = useIsNarrow(); // mobile OR tablet
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [spaces, setSpaces] = useState<EoState[]>([]);
  const [spaceEntries, setSpaceEntries] = useState<SpaceEntry[]>([]);
  const [publicSpaceEntries, setPublicSpaceEntries] = useState<SpaceEntry[]>([]);
  const [cachedSpaceMetas, setCachedSpaceMetas] = useState<Map<string, import('../db/space-meta').SpaceMeta>>(new Map());
  const [allStates, setAllStates] = useState<EoState[]>([]);
  // Ref so the per-space store init effect can always read the latest mergedEntries
  // without appearing in the dep array (prevents spurious re-inits when
  // onSpaceConfigChange fires and updates spaceEntries on every background sync).
  const mergedEntriesRef = useRef<SpaceEntry[]>([]);
  const prevAllStatesKeyRef = useRef<string>('');
  const allStatesFetchGenRef = useRef(0);
  const [timeScrubberFilter, setTimeScrubberFilter] = useState<TimeScrubberFilter>(DEFAULT_FILTER);
  const [tableRecordTargets, setTableRecordTargets] = useState<string[]>([]);

  // Details panel collapse — hides the right-side record drawer without
  // clearing the selected record. Persists across reloads. When collapsed,
  // clicking a table row still selects the record (so navigation, highlight,
  // and keyboard shortcuts work) but the drawer stays hidden until the user
  // clicks the expand rail on the right edge.
  const [detailsPanelCollapsed, setDetailsPanelCollapsedState] = useState<boolean>(() => {
    try { return localStorage.getItem('eo:detailsPanelCollapsed') === '1'; } catch { return false; }
  });
  const setDetailsPanelCollapsed = useCallback((v: boolean) => {
    setDetailsPanelCollapsedState(v);
    try { localStorage.setItem('eo:detailsPanelCollapsed', v ? '1' : '0'); } catch {}
  }, []);
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
  // Ref mirror of matrixReady so async code inside setupSpaceStore can branch
  // on the latest value without making matrixReady a dependency of the effect
  // (which previously caused the effect to re-fire mid-init and race the
  // worker setup). Updated by the effect below.
  const matrixReadyRef = useRef(false);
  useEffect(() => { matrixReadyRef.current = matrixReady; }, [matrixReady]);
  // Separate "initial sync caught up" flag. matrixReady now flips as soon as
  // `startClient()` resolves (so local data renders immediately); this flag
  // tracks the slower 'PREPARED' state for things that genuinely need a
  // fresh sync (e.g. discovering rooms that haven't been seen yet).
  const [syncCaughtUp, setSyncCaughtUp] = useState(false);
  void syncCaughtUp;
  const [presence, setPresence] = useState<Presence | null>(null);
  const [presencePeers, setPresencePeers] = useState<PresenceUser[]>([]);
  const [presencePrefs] = usePresencePrefs();
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
  const [spaceActionError, setSpaceActionError] = useState<string | null>(null);
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

  // --- Presence peer subscription ---------------------------------------
  // Mirror the active Presence instance's peer list into React state so we
  // can render subtle "user X is here" indicators throughout the UI.
  useEffect(() => {
    if (!presence) {
      setPresencePeers([]);
      return;
    }
    return presence.subscribe(setPresencePeers);
  }, [presence]);

  // Keep the current user's share-location preference in sync with the
  // Presence broadcaster. When the user switches to "discrete" mode, the
  // next ping immediately clears their location on all peers.
  useEffect(() => {
    if (!presence) return;
    presence.setShareLocation(presencePrefs.shareLocation);
  }, [presence, presencePrefs.shareLocation]);

  // Broadcast our current in-app location whenever the route changes. The
  // Presence instance debounces rapid updates, so this is safe to fire on
  // every navigation.
  useEffect(() => {
    if (!presence) return;
    presence.setLocation({
      view: route.view,
      space: selectedSpace,
      scope: route.scope,
      record: route.record,
    });
  }, [presence, route.view, route.scope, route.record, selectedSpace]);

  // --- Peer location derivations ----------------------------------------
  // Group visible peers by the scope they're looking at, so HolonNav can
  // render a small indicator next to each scope that has observers.
  // Respects `showPeers` — when the viewer has opted out, the map is empty.
  const peersByScope = useMemo(() => {
    const m = new Map<string, PresenceUser[]>();
    if (!presencePrefs.showPeers) return m;
    for (const u of presencePeers) {
      if (u.userId === session.userId) continue;
      const scope = u.location?.scope;
      if (!scope) continue;
      const arr = m.get(scope);
      if (arr) arr.push(u);
      else m.set(scope, [u]);
    }
    return m;
  }, [presencePeers, presencePrefs.showPeers, session.userId]);
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
  // V4: surface block-chain hydration state to the user. The chain SEG
  // fires fire-and-forget after init, so the UI is interactive but reads
  // may lag the homeserver's head until it completes. The status badge
  // already supports a `syncing` state; piggyback on its message slot
  // when the higher-priority error/detail/initial-sync messages aren't
  // claiming it.
  const hydratingChain = useEoStore((s) => s.hydratingChain);
  const connectionMessage = connectionError?.message
    ?? connectionDetail
    ?? (connectionState === 'syncing' ? 'Matrix is starting and performing initial sync.' : undefined)
    ?? (hydratingChain ? 'Catching up on the block chain — local reads may be slightly stale.' : undefined);

  // Helper to select a space and persist the choice.
  //
  // NOTE: Internal callers (archive / delete fallbacks, startup auto-select,
  // post-create) call `_doSelectSpace` directly — they must not surface the
  // wipe-confirmation modal. Only user-initiated clicks in SpaceBrowser go
  // through the gated `selectSpace` wrapper below.
  function _doSelectSpace(target: string) {
    const canonical = normalizeSpaceTarget(target);
    // Hardwall: purge all caches not scoped to a space before loading new space data.
    invalidateStatsCache();
    useApiConnectionStore.getState().reset();
    setSelectedSpace(canonical);
    localStorage.setItem('eo-selected-space', canonical);
    // Clear route state when switching spaces — space is now part of the URL
    navigate({ space: canonical, scope: null, record: null, view: 'records', builderViewId: null, customPageId: null });
  }

  // User-initiated space switch. Shows a confirmation modal warning that
  // switching will wipe the outgoing space's local cache. If there is no
  // current space (first load) we skip the prompt and select immediately.
  function selectSpace(target: string) {
    const canonical = normalizeSpaceTarget(target);
    if (canonical === selectedSpace) return;
    if (!selectedSpace) {
      _doSelectSpace(canonical);
      return;
    }
    setPendingSpaceSwitch(canonical);
  }

  // Tear down every in-memory service attached to a cached space so its
  // Workers, timers, and open RTC connections don't keep running after the
  // user has left. Safe to call with a spaceId that is not in the cache.
  function evictSpaceCache(target: string) {
    const cached = spaceCacheRef.current.get(target);
    if (!cached) return;
    try { cached.workerClient.worker.terminate(); } catch { /* best effort */ }
    try { cached.peerSync?.destroy(); } catch { /* best effort */ }
    try { cached.webrtcPeer?.stop(); } catch { /* best effort */ }
    try { cached.syncManager?.destroy(); } catch { /* best effort */ }
    try { cached.presence?.stop(); } catch { /* best effort */ }
    spaceCacheRef.current.delete(target);
  }

  // Confirm the pending user-initiated space switch: evict the outgoing
  // space's live services, wipe its local data (OPFS + slice-store + space
  // metadata), then advance to the new space.
  async function confirmSpaceSwitch() {
    const incoming = pendingSpaceSwitch;
    const outgoing = selectedSpace;
    setPendingSpaceSwitch(null);
    if (!incoming || !outgoing) return;
    evictSpaceCache(outgoing);
    try {
      await clearSpaceLocalData(outgoing);
    } catch (e) {
      console.warn('[EO-DB] clearSpaceLocalData failed:', e);
    }
    _doSelectSpace(incoming);
  }
  // Soft-delete a space: hide from list, track in recycle bin
  /**
   * Persist space lifecycle status to Matrix room state (source of truth).
   * Falls back to localStorage-only if the Matrix write fails (e.g. insufficient power level).
   */
  async function persistSpaceStatus(
    spaceTarget: string,
    status: 'active' | 'archived' | 'deleted',
  ): Promise<boolean> {
    const client = matrixClientRef.current;
    const entry = mergedEntries.find((e) => e.spaceTarget === spaceTarget);
    const mainRoomId = spaceCacheRef.current.get(spaceTarget)?.mainRoomId || entry?.mainRoomId;
    if (!client || !mainRoomId) return false;

    try {
      const currentConfig = getSpaceConfig(client as any, mainRoomId);
      if (!currentConfig) return false;

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
      return true;
    } catch (e) {
      console.warn('[EO-DB] Failed to persist space status to Matrix:', e);
      return false;
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
        _doSelectSpace(remaining[0].spaceTarget);
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
    _doSelectSpace(target);
    setShowRecycleBin(false);
  }

  // Archive a space: hide from browser, viewable in Settings
  async function handleArchiveSpace(spaceTarget: string) {
    const client = matrixClientRef.current;
    const entry = mergedEntries.find((e) => e.spaceTarget === spaceTarget);
    const mainRoomId = spaceCacheRef.current.get(spaceTarget)?.mainRoomId || entry?.mainRoomId;

    // Permission guard: only admins (pl >= 50) may archive a shared space
    if (client && mainRoomId) {
      const room = client.getRoom(mainRoomId);
      if (room && getUserPowerLevel(room, session.userId) < 50) {
        setSpaceActionError('Only admins (power level \u2265 50) can archive a space.');
        return;
      }
    }

    setSpaceActionError(null);
    addArchivedSpace({
      target: spaceTarget,
      name: entry?.displayName || formatSpaceName(spaceTarget.split('.').pop() || ''),
      archivedAt: Date.now(),
      archivedBy: session.userId,
      memberCount: entry?.memberCount || 0,
    });

    const ok = await persistSpaceStatus(spaceTarget, 'archived');
    if (!ok) {
      // Rollback optimistic localStorage write
      removeArchivedSpace(spaceTarget);
      setSpaceActionError('Could not archive space \u2014 insufficient permissions or connection error.');
      setSpaces([...spaces]);
      setSpaceEntries([...spaceEntries]);
      return;
    }

    if (selectedSpace === spaceTarget) {
      const remaining = mergedEntries.filter((e) => e.spaceTarget !== spaceTarget && !isSpaceDeleted(e.spaceTarget) && !isSpaceArchived(e.spaceTarget));
      if (remaining.length > 0) {
        _doSelectSpace(remaining[0].spaceTarget);
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
  async function handleUnarchiveSpace(target: string) {
    setSpaceActionError(null);
    removeArchivedSpace(target);

    const ok = await persistSpaceStatus(target, 'active');
    if (!ok) {
      // Rollback optimistic localStorage write
      addArchivedSpace({
        target,
        name: mergedEntries.find(e => e.spaceTarget === target)?.displayName || target,
        archivedAt: Date.now(),
        archivedBy: session.userId,
        memberCount: mergedEntries.find(e => e.spaceTarget === target)?.memberCount || 0,
      });
      setSpaceActionError('Could not unarchive space \u2014 insufficient permissions or connection error.');
      setSpaces([...spaces]);
      setSpaceEntries([...spaceEntries]);
      return;
    }

    setSpaces([...spaces]);
    setSpaceEntries([...spaceEntries]);
    _doSelectSpace(target);
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

  // Permanently delete a space's local data (OPFS + slice-store + metadata)
  async function handlePermanentDelete(target: string) {
    evictSpaceCache(target);
    try {
      await clearSpaceLocalData(target);
    } catch (e) {
      console.warn('[EO-DB] clearSpaceLocalData failed:', e);
    }
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

  // Replace the raw scope leaf (e.g. "tblXxxx") with the table's display name
  // (state.value.name) on records tabs once the underlying state resolves.
  useEffect(() => {
    if (allStates.length === 0 || tabs.length === 0) return;
    const byTarget = new Map<string, EoState>();
    for (const st of allStates) {
      if (!byTarget.has(st.target)) byTarget.set(st.target, st);
    }
    for (const tab of tabs) {
      if (tab.view !== 'records' || !tab.scope) continue;
      const st = byTarget.get(tab.scope);
      const name = st && typeof st.value === 'object' && st.value
        ? (st.value as { name?: unknown }).name
        : undefined;
      if (typeof name === 'string' && name && tab.title !== name) {
        setTabMeta(tab.id, { title: name });
      }
    }
  }, [allStates, tabs, setTabMeta]);

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

        if (!mounted) { client.stopClient(); return; }

        // Unblock the UI as soon as the SDK is running. Local OPFS data is
        // already decrypted and ready to render — we should not wait for the
        // initial /sync round-trip ('PREPARED' state) before flipping
        // matrixReady. Anything that genuinely needs fresh sync data (e.g.
        // discovering a brand-new space, creating rooms) gates on the
        // syncCaughtUp flag set by the listener below.
        setConnectionError(null);
        setConnectionDetail(null);
        setMatrixReady(true);

        // Background: when initial sync (PREPARED) completes, flip the
        // syncCaughtUp flag and run the post-sync housekeeping that used to
        // block the boot path. Fail open — any error here is non-fatal for
        // local rendering.
        const finishInitialSync = async () => {
          if (!mounted) return;
          // Auto-join any rooms where we have a pending invite. Invited rooms
          // only expose stripped state — custom state events like
          // com.eo-db.space.config are not readable until the user joins.
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
          // sync — stopping before startClient() is ineffective because the
          // sync loop re-registers its listeners during processSyncResponse.
          try { client.matrixRTC?.stop(); } catch { /* older SDK — safe */ }
          // Root data-room resolution is best-effort; fire-and-forget.
          try { roomIdRef.current = await resolveDataRoom(client); } catch { /* per-space rooms */ }
          if (!mounted) return;
          setSyncCaughtUp(true);
        };

        if (client.isInitialSyncComplete()) {
          void finishInitialSync();
        } else {
          const onInitSync = (state: string) => {
            if (state === 'PREPARED') {
              client.removeListener('sync' as any, onInitSync);
              void finishInitialSync();
            } else if (state === 'ERROR') {
              // ERROR after startClient() resolved means the sync loop is
              // failing (network, token). Leave matrixReady=true so the UI
              // stays interactive on cached data; the onSync handler above
              // already surfaces the error in connectionError.
              client.removeListener('sync' as any, onInitSync);
            }
          };
          client.on('sync' as any, onInitSync);
        }

        // Re-run space discovery whenever a space config state event changes so
        // all connected clients reflect archive/unarchive/delete actions immediately.
        const onSpaceConfigChange = (event: any) => {
          if (event.getType?.() !== EO_SPACE_CONFIG_TYPE) return;
          try {
            const updated = discoverSpacesFromMatrix(client!);
            setSpaceEntries(updated);
          } catch { /* best effort */ }
        };
        client.on('RoomState.events' as any, onSpaceConfigChange);
      } catch (e) {
        console.warn('[EO-DB] startMatrix failed:', e);
        if (!mounted) return;
        const described = describeMatrixError(e);
        // If we have a cached session (userId known), start in offline/local mode
        // so the user can still read their OPFS data without a Matrix connection.
        if (session.userId) {
          console.info('[EO-DB] Falling back to offline mode — local OPFS data accessible');
          setConnectionDetail('offline');
          setConnectionError(described);
          // matrixReady stays false — setupSpaceStore will skip PeerSync
          // but will still init the OPFS worker and load data.
          setMatrixReady(false);
        } else {
          setConnectionError(described);
        }
      }
    }

    startMatrix();

    // When the browser regains connectivity, re-attempt Matrix init if we're
    // in offline mode (matrixReady is false, client has session).
    const handleOnline = () => {
      if (!mounted) return;
      if (!matrixClientRef.current || !matrixClientRef.current.isInitialSyncComplete()) {
        setRetryCount(c => c + 1);
      }
    };
    window.addEventListener('online', handleOnline);

    return () => {
      mounted = false;
      window.removeEventListener('online', handleOnline);
      if (matrixClientRef.current) {
        matrixClientRef.current.removeAllListeners('sync' as any);
        matrixClientRef.current.removeAllListeners('RoomState.events' as any);
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
      if (selectedSpace === null) _doSelectSpace('space_local');
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
            if (selectedSpace === null) _doSelectSpace(parsed[0].target);
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
            if (selectedSpace === null) _doSelectSpace(spaceRoots[0].target);
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
  // Keep the ref in sync every render so the per-space effect always reads
  // the latest entries without re-running due to mergedEntries changes.
  mergedEntriesRef.current = mergedEntries;

  // Filter out soft-deleted spaces from the browser entries.
  // Amino-hosted accounts always present a single unified "Amino" space —
  // the homeserver is single-tenant by design, so collapsing avoids exposing
  // multiple internal spaces to end users.
  const activeEntries = useMemo(() => {
    const filtered = mergedEntries.filter((e) => !isSpaceDeleted(e.spaceTarget) && !isSpaceArchived(e.spaceTarget));
    if (!isAmino || filtered.length === 0) return filtered;
    const canonical = filtered.find((e) => e.spaceTarget === 'space_amino' || e.displayName.toLowerCase() === 'amino') ?? filtered[0];
    return [{ ...canonical, displayName: 'Amino' }];
  }, [mergedEntries, spaces, spaceEntries, isAmino]);
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

      prevSpaceRef.current = selectedSpace;
      // Clear Layout-level state so old space data doesn't flash
      setAllStates([]);
      setScopedRecords([]);
      setScopeFieldNameMap(new Map());
      navigate({ view: 'records' });
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

  // Pre-warm the OPFS fold worker before the first paint so the browser can
  // parse the Worker module and acquire the OPFS file handle in parallel with
  // React rendering the initial frame. useLayoutEffect fires synchronously
  // before paint — ~one full frame (~16 ms) ahead of useEffect, and worker
  // startup (~100–400 ms) overlaps with the paint instead of following it.
  const eagerWorkerRef = useRef<{
    client: FoldWorkerClient;
    initPromise: Promise<{ headSeq: number } | null>;
    spaceId: string;
  } | null>(null);
  useLayoutEffect(() => {
    if (!selectedSpace || localMode || eagerWorkerRef.current) return;
    const client = createFoldWorkerClient();
    // Swallow errors — setupSpaceStore will retry on failure. On success we
    // carry the worker's headSeq so the main-thread init can skip scanLog and
    // snapshot-resave when the log hasn't advanced since the last snapshot.
    const initPromise = initFoldWorker(client, selectedSpace)
      .then(({ headSeq }) => ({ headSeq }))
      .catch(() => null);
    eagerWorkerRef.current = { client, initPromise, spaceId: selectedSpace };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — intentionally runs once before first paint

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

    const startEodbBlobWriter = (roomId: string): (() => void) => {
      // Google Drive / n8n blob persistence is retired. All durability now
      // flows through Matrix-native block sealing — see `sync/block-sealer.ts`
      // and `sync/block-hydration.ts`. This function is kept as a no-op
      // so the surrounding wiring (cleanup registration, room-id capture)
      // doesn't need to be rewritten across the parent space-cache flow.
      void roomId;
      return () => {};
    };

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
      const spaceEntry = mergedEntriesRef.current.find((e) => e.spaceTarget === selectedSpace);
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
      if (matrixReadyRef.current && matrixClientRef.current) {
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

      // 2f. Amino single-tenant fallback: the homeserver hosts exactly one
      //     space, and the UI already collapses every entry into a unified
      //     "Amino" space. The URL-derived target (`space_amino`) may not
      //     match the config's derived target (e.g. a room named "Amino
      //     Immigration" → `space_amino_immigration`), which would make the
      //     exact-match scans above miss it and fall through to creating a
      //     duplicate room. Match ANY joined room carrying a space config.
      if (isAmino && matrixClientRef.current) {
        const anyScan = findSpaceRoomByDirectScan(matrixClientRef.current, null);
        if (anyScan) {
          console.log('[EO-DB] Resolved Amino space room (target-agnostic) for', selectedSpace, '→', anyScan.mainRoomId);
          resolvedSpaceRooms = anyScan.rooms;
          return anyScan.mainRoomId;
        }
      }

      // 3. Room genuinely doesn't exist — create it (with canonical alias).
      if (matrixReadyRef.current && matrixClientRef.current) {
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
        // Clear any stale room-phase error now that we have a valid room
        setConnectionError(prev => prev?.phase === 'room' ? null : prev);
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

      // Check cache BEFORE resolveRoom so local data loads immediately without
      // waiting for Matrix network calls. cache.set() is always synchronous
      // (called before any await), so any concurrent run that started before us
      // has already populated the cache by the time our synchronous code runs here.
      const existing = cache.get(selectedSpace!);
      if (existing) {
        // Reuse cached worker — no OPFS re-open, no replay
        if (isStale()) return;
        await init(existing.workerClient);

        // Resolve the Matrix room AFTER local data is loaded.
        // ready=true is already set above — UI is unblocked before this await.
        const spaceRoomId = await resolveRoom();
        if (isStale()) return;

        // Update mainRoomId if room resolution succeeded on this run
        // (fixes the case where the first run cached null because Matrix
        // wasn't ready yet, but a subsequent re-run resolved the room).
        if (spaceRoomId && !existing.mainRoomId) {
          existing.mainRoomId = spaceRoomId;
          existing.spaceRooms = resolvedSpaceRooms;
        }

        // Surface a room-resolution failure on the cached path too. Without
        // this, a null result leaves the UI stuck on "Resolving room..."
        // forever with no error and no retry affordance (the cold-start
        // branch below already does this).
        if (MATRIX_ENABLED && !spaceRoomId && matrixClientRef.current && matrixReadyRef.current) {
          console.warn('[EO-DB] No room for cached space', selectedSpace, '— cannot start PeerSync.');
          setConnectionError({
            phase: 'room',
            message: 'Could not create or find a room for this space. The homeserver may restrict room creation — try logging out and back in.',
          });
        }

        // SEG: check if the block chain has advanced past what we've
        // folded locally. Idempotent — chain hasn't moved → no-op,
        // costing one m.eo.head state lookup. Chain has moved → fetch
        // only the new blocks (stopAt the persisted hydrated head) and
        // fold them through batchImport so the main thread stays
        // responsive. Fire-and-forget so the UI doesn't wait on network
        // round-trips; the fold engine dedups by client_event_id so
        // concurrent live events + hydration converge.
        if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
          const hydrateClient = matrixClientRef.current;
          const hydrateStore = useEoStore.getState().store;
          if (hydrateStore) {
            // Reconcile the snapshot's hydration cursor with localStorage
            // before triggering hydrateBlocksIfStale. If localStorage was
            // cleared but the snapshot recorded the cursor, restore it so
            // the SEG check short-circuits on "chain hasn't moved".
            // (V9 of HELIX-AUDIT-2026-05-11.md.)
            const snapHead = useEoStore.getState().snapshotHydratedHead;
            if (snapHead && !getPersistedHydratedHead(spaceRoomId)) {
              setPersistedHydratedHead(spaceRoomId, snapHead);
            }
            const mirror = buildBlockMirror(hydrateClient, spaceRoomId);
            useEoStore.getState().runChainHydrate(() =>
              hydrateBlocksIfStale(hydrateClient, spaceRoomId, hydrateStore, {
                bulkApply: (events) => useEoStore.getState().batchImport(events),
                mirror,
              }),
            )
              .then((r) => {
                if (r) return useEoStore.getState().flushToOpfs(r.latestBlockEventId);
              })
              .catch((e) => console.warn('[EO-DB] block-chain hydration failed:', e));

            // Auto-ingest live updates from other clients (see cold-start
            // branch below for full context). Same guards: gated by
            // isAutoIngestEnabled, idempotent via hydrateBlocksIfStale.
            let ingestInFlight = false;
            const stopListening = listenForChainUpdates(hydrateClient, spaceRoomId, () => {
              if (!isAutoIngestEnabled(spaceRoomId)) return;
              if (ingestInFlight) return;
              const liveStore = useEoStore.getState().store;
              if (!liveStore) return;
              ingestInFlight = true;
              useEoStore.getState().runChainHydrate(() =>
                hydrateBlocksIfStale(hydrateClient, spaceRoomId, liveStore, {
                  bulkApply: (events) => useEoStore.getState().batchImport(events),
                  mirror,
                }),
              )
                .then((r) => {
                  if (r) return useEoStore.getState().flushToOpfs(r.latestBlockEventId);
                })
                .catch((e) => console.warn('[EO-DB] auto-ingest fold failed:', e))
                .finally(() => { ingestInFlight = false; });
            });
            cleanupFns.push(stopListening);
          }
        }

        // Restore cached sync manager (legacy path — null in new spaces)
        if (existing.syncManager) {
          useEoStore.getState().setSyncManager(existing.syncManager);
        }

        // Start PeerSync if room is now available but wasn't on the first run
        if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current && !existing.peerSync) {
          try {
            const wrtc = new WebRTCPeer(matrixClientRef.current, spaceRoomId, useEoStore.getState().store!, onFoldEvent);
            wrtc.start();
            const ps = new PeerSync(
              matrixClientRef.current,
              spaceRoomId,
              useEoStore.getState().store!,
              onFoldEvent,
              undefined,
              (events) => useEoStore.getState().batchImport(events),
            );
            ps.setWebRTCPeer(wrtc);
            await ps.start();
            if (!isStale()) {
              existing.peerSync = ps;
              existing.webrtcPeer = wrtc;
              useEoStore.getState().setSyncManager(ps as any);
              cleanupFns.push(() => { ps.stop(); wrtc.stop(); });
              cleanupFns.push(startEodbBlobWriter(spaceRoomId));
            } else {
              ps.stop(); wrtc.stop();
            }
          } catch (e) {
            console.warn('[EO-DB] PeerSync init failed for cached space', selectedSpace, e);
          }
        } else if (existing.peerSync) {
          // Re-announce presence after re-mount
          existing.peerSync.start().catch(() => {});
          useEoStore.getState().setSyncManager(existing.peerSync as any);
          cleanupFns.push(() => {});
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

      // Open space-scoped OPFS fold worker.
      // Cache the entry BEFORE initFoldWorker so that any concurrent run that
      // starts during the await finds the entry and takes the reuse path above,
      // preventing two workers from racing to open the same OPFS file.
      //
      // Prefer the pre-warmed worker started by useLayoutEffect (before first
      // paint) for the initial space load — it may already be fully initialized
      // by the time we reach this point, making the await below instant.
      const eager = eagerWorkerRef.current;
      const usingEager = eager !== null && eager.spaceId === selectedSpace!;
      const workerClient = usingEager ? eager.client : createFoldWorkerClient();
      cache.set(selectedSpace!, { workerClient, syncManager: null, peerSync: null, webrtcPeer: null, mainRoomId: null, presence: null, spaceRooms: null });

      let initError: unknown;
      // Captured from the ready message so eo-store.init can compare it
      // against the kv-snapshot seq and skip scanLog / snapshot-resave when
      // the log hasn't advanced since the snapshot was written.
      let workerHeadSeq: number | undefined;
      if (usingEager) {
        // Await the pre-warmed init — often already resolved, so no wait.
        try {
          const result = await eager.initPromise;
          if (result) workerHeadSeq = result.headSeq;
        } catch (e) {
          initError = e;
        }
      } else {
        // Retry up to 3 times — the previous worker may still hold the
        // SyncAccessHandle for a brief window after termination.
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 600));
            const { headSeq } = await initFoldWorker(workerClient, selectedSpace!);
            workerHeadSeq = headSeq;
            initError = undefined;
            break;
          } catch (e) {
            initError = e;
          }
        }
      }
      if (initError) {
        // All retries failed — remove the cache entry so the next run retries cleanly.
        cache.delete(selectedSpace!);
        workerClient.worker.terminate();
        console.error('[EO-DB] initFoldWorker failed for', selectedSpace, initError);
        return;
      }

      // If stale, don't terminate — a concurrent run already found this worker
      // in the cache above and is about to use it. Just bail silently.
      if (isStale()) return;

      await init(workerClient, workerHeadSeq);

      // Resolve the Matrix room AFTER local data is loaded.
      // ready=true is already set above — UI is unblocked before this await.
      const spaceRoomId = await resolveRoom();
      if (isStale()) return;

      // SEG: same boundary check as the cache-hit branch above. On cold
      // start the snapshot is empty (or was just loaded from OPFS), and
      // m.eo.head may point at a chain head that doesn't yet have its
      // blocks folded into the local store.
      //
      // The initial SEG is owned by `PeerSync.start()` via its
      // `chainSeg` hook (constructed below) — that places the trigger
      // inside the sync layer rather than the UI shell, satisfying V8.
      // Here we only wire the V9 reconciliation (snapshot cursor →
      // localStorage backfill) and the auto-ingest listener that
      // handles subsequent chain updates.
      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
        const hydrateClient = matrixClientRef.current;
        const hydrateStore = useEoStore.getState().store;
        if (hydrateStore) {
          // V9 reconciliation — see cached-space branch for full context.
          const snapHead = useEoStore.getState().snapshotHydratedHead;
          if (snapHead && !getPersistedHydratedHead(spaceRoomId)) {
            setPersistedHydratedHead(spaceRoomId, snapHead);
          }
          const mirror = buildBlockMirror(hydrateClient, spaceRoomId);

          // Auto-ingest: subscribe to live m.eo.head / m.eo.block / disabled
          // state-event changes and fold the new gap incrementally. Idempotent
          // (hydrateBlocksIfStale short-circuits when the head matches what's
          // already folded) and gated by the per-room preference, so the user
          // can opt out via the Uploaded Blocks UI.
          let ingestInFlight = false;
          const stopListening = listenForChainUpdates(hydrateClient, spaceRoomId, () => {
            if (!isAutoIngestEnabled(spaceRoomId)) return;
            if (ingestInFlight) return;
            const liveStore = useEoStore.getState().store;
            if (!liveStore) return;
            ingestInFlight = true;
            hydrateBlocksIfStale(hydrateClient, spaceRoomId, liveStore, {
              bulkApply: (events) => useEoStore.getState().batchImport(events),
              mirror,
            })
              .then((r) => {
                if (r) return useEoStore.getState().flushToOpfs(r.latestBlockEventId);
              })
              .catch((e) => console.warn('[EO-DB] auto-ingest fold failed:', e))
              .finally(() => { ingestInFlight = false; });
          });
          cleanupFns.push(stopListening);
        }
      }

      // If Matrix is ready but we couldn't get a room, surface the error.
      // Only show this when matrixReady=true — if Matrix hasn't connected yet,
      // the sync-phase error from startMatrix() is already displayed and the
      // room error would be misleading and overwrite the real cause.
      if (MATRIX_ENABLED && !spaceRoomId && matrixClientRef.current && matrixReadyRef.current) {
        console.warn('[EO-DB] No room for space', selectedSpace, '— cannot start PeerSync.');
        setConnectionError({
          phase: 'room',
          message: 'Could not create or find a room for this space. The homeserver may restrict room creation — try logging out and back in.',
        });
      }

      let peerSync: PeerSync | null = null;
      let webrtcPeer: WebRTCPeer | null = null;
      let operatorSync: NetworkSyncSystem | null = null;

      const useOperatorSync = isOperatorSyncEnabled(
        (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_NETWORK_SYNC_WORKER,
      );

      if (MATRIX_ENABLED && spaceRoomId && matrixClientRef.current) {
        try {
          webrtcPeer = new WebRTCPeer(matrixClientRef.current, spaceRoomId, useEoStore.getState().store!, onFoldEvent);
          webrtcPeer.start();
          if (useOperatorSync) {
            operatorSync = await startNetworkSyncSystem({
              matrix: matrixClientRef.current,
              roomId: spaceRoomId,
              store: useEoStore.getState().store!,
              webrtcPeer,
              userId: session.userId,
              deviceId: matrixClientRef.current.getDeviceId() ?? '',
              onFoldEvent,
              createWorker: () =>
                new Worker(new URL('../workers/network-sync.worker.ts', import.meta.url), {
                  type: 'module',
                  name: 'eo-network-sync',
                }),
            });
            if (isStale()) { await operatorSync.stop(); webrtcPeer.stop(); return; }
            cleanupFns.push(() => {
              void operatorSync!.stop();
              webrtcPeer!.stop();
            });
            console.log('[EO-DB] Operator-native sync active for', spaceRoomId);
          } else {
            const psClient = matrixClientRef.current;
            const psStore = useEoStore.getState().store!;
            const psMirror = buildBlockMirror(psClient, spaceRoomId);
            // V8: PeerSync.start() owns the initial chain-SEG via this
            // closure, replacing the Layout-side initial hydrate call.
            // listenForChainUpdates (wired earlier in this effect) still
            // handles subsequent updates from other clients.
            const psChainSeg = () =>
              useEoStore.getState().runChainHydrate(() =>
                hydrateBlocksIfStale(psClient, spaceRoomId, psStore, {
                  bulkApply: (events) => useEoStore.getState().batchImport(events),
                  mirror: psMirror,
                }).then((r) => {
                  if (r) return useEoStore.getState().flushToOpfs(r.latestBlockEventId);
                }),
              );
            peerSync = new PeerSync(
              psClient,
              spaceRoomId,
              psStore,
              onFoldEvent,
              undefined,
              (events) => useEoStore.getState().batchImport(events),
              psChainSeg,
            );
            peerSync.setWebRTCPeer(webrtcPeer);
            await peerSync.start();
            if (isStale()) { peerSync.stop(); webrtcPeer.stop(); return; }
            useEoStore.getState().setSyncManager(peerSync as any);
            cleanupFns.push(() => { peerSync!.stop(); webrtcPeer!.stop(); });
            cleanupFns.push(startEodbBlobWriter(spaceRoomId));
          }
        } catch (e) {
          console.warn('[EO-DB] Sync init failed for', selectedSpace, e);
          peerSync = null;
          webrtcPeer = null;
          operatorSync = null;
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
        const spaceEntry = mergedEntriesRef.current.find(e => e.spaceTarget === selectedSpace);
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
      cache.set(selectedSpace!, { workerClient, syncManager: null, peerSync, webrtcPeer, mainRoomId: spaceRoomId, presence: presenceInstance, spaceRooms: resolvedSpaceRooms });
    }

    setupSpaceStore();

    return () => {
      mounted = false;
      cleanupFns.forEach(fn => fn());
    };
    // Note: spaceRoomId/spaceRooms are intentionally NOT in the dep array —
    // they are outputs of this effect, not inputs.
    // mergedEntries is intentionally NOT in the dep array — it is read via
    // mergedEntriesRef (always current) to avoid re-running the full store init
    // every time onSpaceConfigChange fires during background Matrix sync.
    // matrixReady is intentionally NOT in the dep array — local OPFS data must
    // load and `ready: true` must fire independently of any Matrix round-trip.
    // The body branches on matrixReadyRef.current for Matrix-dependent paths,
    // and a separate effect (below) attaches PeerSync/Presence/room-resolution
    // once Matrix actually becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpace, session, init]);

  // --- Late Matrix-attach effect ---
  // setupSpaceStore (above) deliberately runs without waiting for matrixReady
  // so local OPFS data renders immediately. When Matrix subsequently becomes
  // ready (cold boot raced ahead of /sync, or we recovered from offline),
  // attach the Matrix-dependent services to the already-loaded space: resolve
  // the room, start PeerSync + WebRTC + Presence, and wire the block-chain
  // hydration listener. Skipped if these services were already started
  // (peerSync !== null) or if there's no cached entry for the current space.
  useEffect(() => {
    if (!MATRIX_ENABLED || localMode) return;
    if (!matrixReady || !matrixClientRef.current) return;
    if (!selectedSpace) return;
    const cached = spaceCacheRef.current.get(selectedSpace);
    if (!cached) return;
    if (cached.peerSync || cached.presence) return; // already attached

    let cancelled = false;
    const cleanupFns: (() => void)[] = [];
    (async () => {
      try {
        // Resolve the room now that Matrix is available. Mirrors a subset of
        // resolveOrCreateRoom() but only the read paths — we don't auto-create
        // here, the user can retry the space from SpaceBrowser if needed.
        const client = matrixClientRef.current!;
        let roomId: string | null = cached.mainRoomId ?? null;
        if (!roomId) {
          const entry = mergedEntriesRef.current.find(e => e.spaceTarget === selectedSpace);
          roomId = entry?.mainRoomId ?? null;
        }
        if (!roomId) {
          const scan = findSpaceRoomByDirectScan(client, selectedSpace);
          if (scan) { roomId = scan.mainRoomId; cached.spaceRooms = scan.rooms; }
        }
        if (!roomId) {
          const meta = cachedSpaceMetas.get(selectedSpace);
          if (meta?.mainRoomId) roomId = meta.mainRoomId;
        }
        if (cancelled || !roomId) return;

        cached.mainRoomId = roomId;
        setSpaceRoomId(roomId);
        setSpaceRooms(cached.spaceRooms ?? null);
        setConnectionError(prev => prev?.phase === 'room' ? null : prev);
        persistSpaceMeta({ spaceId: selectedSpace, mainRoomId: roomId })
          .catch(e => console.warn('[EO-DB] Failed to persist room ID (late attach):', e));

        const store = useEoStore.getState().store;
        if (!store) return;

        // PeerSync + WebRTC
        const onFoldEvent = (event: any) => {
          useEoStore.setState((st) => ({
            recentEvents: [...st.recentEvents.slice(-99), event],
            lastSeq: event.seq,
          }));
        };
        const wrtc = new WebRTCPeer(client, roomId, store, onFoldEvent);
        wrtc.start();
        const psMirror = buildBlockMirror(client, roomId);
        const psChainSeg = () =>
          useEoStore.getState().runChainHydrate(() =>
            hydrateBlocksIfStale(client, roomId, store, {
              bulkApply: (events) => useEoStore.getState().batchImport(events),
              mirror: psMirror,
            }).then((r) => {
              if (r) return useEoStore.getState().flushToOpfs(r.latestBlockEventId);
            }),
          );
        const ps = new PeerSync(
          client, roomId, store, onFoldEvent, undefined,
          (events) => useEoStore.getState().batchImport(events),
          psChainSeg,
        );
        ps.setWebRTCPeer(wrtc);
        await ps.start();
        if (cancelled) { ps.stop(); wrtc.stop(); return; }
        cached.peerSync = ps;
        cached.webrtcPeer = wrtc;
        useEoStore.getState().setSyncManager(ps as any);
        cleanupFns.push(() => { ps.stop(); wrtc.stop(); });

        // Presence
        const presenceInstance = new Presence(client, roomId);
        await presenceInstance.start();
        if (cancelled) { presenceInstance.stop(); return; }
        cached.presence = presenceInstance;
        setPresence(presenceInstance);
        cleanupFns.push(() => { presenceInstance.stop(); setPresence(null); });

        // Auto-ingest chain updates
        let ingestInFlight = false;
        const stopListening = listenForChainUpdates(client, roomId, () => {
          if (!isAutoIngestEnabled(roomId)) return;
          if (ingestInFlight) return;
          const liveStore = useEoStore.getState().store;
          if (!liveStore) return;
          ingestInFlight = true;
          useEoStore.getState().runChainHydrate(() =>
            hydrateBlocksIfStale(client, roomId, liveStore, {
              bulkApply: (events) => useEoStore.getState().batchImport(events),
              mirror: psMirror,
            }),
          )
            .then((r) => {
              if (r) return useEoStore.getState().flushToOpfs(r.latestBlockEventId);
            })
            .catch((e) => console.warn('[EO-DB] auto-ingest fold failed:', e))
            .finally(() => { ingestInFlight = false; });
        });
        cleanupFns.push(stopListening);
      } catch (e) {
        console.warn('[EO-DB] Late Matrix attach failed for', selectedSpace, e);
      }
    })();

    return () => {
      cancelled = true;
      cleanupFns.forEach(fn => fn());
    };
  }, [matrixReady, selectedSpace, localMode, cachedSpaceMetas]);

  async function handleLogout() {
    // Save snapshots for ALL cached spaces before clearing state
    const cache = spaceCacheRef.current;
    const savePromises: Promise<unknown>[] = [];
    for (const [, cached] of cache) {
      if (cached.syncManager) {
        savePromises.push(cached.syncManager.saveSnapshot().catch((err) => {
              console.warn('[EO-DB] Snapshot save failed:', err);
            }));
      }
    }
    await Promise.all(savePromises);

    for (const [, cached] of cache) {
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
    // Wipe block-chain hydration cursors so a new account doesn't inherit
    // a "we already hydrated up to X" marker that would skip blocks on
    // re-login. (V5/V9 of HELIX-AUDIT-2026-05-11.md.)
    clearAllHydratedHeadMarkers();
    // Drop the IDB offline queue so queued writes from the prior session
    // don't get replayed under the new account's identity. (V5.)
    await eraseOfflineQueueDb();

    onLogout();
  }

  // Auto-REC on session expiry: when Matrix returns 401 / M_UNKNOWN_TOKEN
  // (surfaced via connectionError.phase === 'auth'), the prior session's
  // token is dead. Trust in any persisted state from this session is now
  // unverifiable, so trigger the same handleLogout path the user would
  // hit via the "Re-login" button. Without this, the user can continue
  // editing against state that the homeserver will reject on next flush.
  // (V6 of HELIX-AUDIT-2026-05-11.md.)
  const handleLogoutRef = useRef(handleLogout);
  handleLogoutRef.current = handleLogout;
  const autoLogoutFiredRef = useRef(false);
  useEffect(() => {
    if (connectionError?.phase !== 'auth') {
      autoLogoutFiredRef.current = false;
      return;
    }
    if (autoLogoutFiredRef.current) return;
    autoLogoutFiredRef.current = true;
    void handleLogoutRef.current();
  }, [connectionError]);

  // Handle tab visibility changes.
  //
  // On `hidden`: save SyncManager snapshot (cheap; only fires for older spaces
  //   that don't use PeerSync).
  //
  // On `visible`: re-announce PeerSync presence so peers push us anything we
  //   missed while the tab was backgrounded.
  //
  // On `beforeunload`: save snapshots for durability before the tab closes.
  useEffect(() => {
    let fullSaveInFlight = false;

    const fullSaveAll = async () => {
      if (fullSaveInFlight) return;
      fullSaveInFlight = true;
      try {
        const promises: Promise<unknown>[] = [];
        for (const [, cached] of spaceCacheRef.current) {
          if (cached.syncManager) {
            promises.push(cached.syncManager.saveSnapshot().catch((err) => {
              console.warn('[EO-DB] Snapshot save failed:', err);
            }));
          }
        }
        await Promise.all(promises);
      } finally {
        fullSaveInFlight = false;
      }
    };

    const lightSaveOnHide = () => {
      for (const [, cached] of spaceCacheRef.current) {
        if (cached.syncManager) {
          cached.syncManager.saveSnapshot().catch((err) => {
            console.warn('[EO-DB] Snapshot save failed:', err);
          });
        }
      }
    };

    const refreshOnVisible = () => {
      for (const [, cached] of spaceCacheRef.current) {
        if (cached.peerSync) {
          cached.peerSync.start().catch((err) => {
            console.warn('[EO-DB] PeerSync re-announce failed:', err);
          });
        }
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lightSaveOnHide();
      } else if (document.visibilityState === 'visible') {
        refreshOnVisible();
      }
    };

    const handleBeforeUnload = () => { fullSaveAll(); };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
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
    branch: '\u22EE',   // vertical ellipsis (branch fork)
    nl: '\u2766',       // floral heart — natural-language / documents
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

  // When the active persona changes, route to its home destination (if defined).
  // Falls back to the visible_views redirect if no home is set but the current
  // view is hidden by the persona's nav restriction.
  useEffect(() => {
    if (!activeTypeDef) return;
    const home = activeTypeDef.home;
    if (home) {
      // Route to the persona's home destination. We only override fields the
      // persona explicitly set, so the user stays on the same space.
      navigate({
        view: home.view,
        scope: home.scope ?? null,
        record: null,
        builderViewId: home.builderViewId ?? null,
        customPageId: home.customPageId ?? null,
      });
      return;
    }
    // No home set — fall back to hiding currently-active view if it's now restricted.
    if (activeTypeDef.visible_views?.length && !activeTypeDef.visible_views.includes(activeView)) {
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
      spaceUserTypeDefinitions,
    );
  }, [currentSpaceState, session.userId, selectedSpace, spaceUserTypeAssignments, spaceFieldTypeVisibility, activeUserType, spaceUserTypeDefinitions]);
  const currentRole: AccessRole = currentPermissions?.role ?? 'viewer';
  const isViewer = currentRole === 'viewer';

  // Determine active slice type from saved slice
  const sliceStore = useSliceStore();
  const sliceSigs = sliceStore.sigs;
  const savedSlices = sliceStore.savedSlices;
  const openScopes = sliceStore.openScopes;

  // Apply the active persona's default slice for a scope when the scope is
  // opened and no slice is currently active. Respects user overrides within
  // a session — if the user has already picked a different slice, we leave
  // it alone. Runs when scope or persona changes.
  useEffect(() => {
    if (!selectedScope || !activeTypeDef?.default_slices) return;
    const defaultSliceId = activeTypeDef.default_slices[selectedScope];
    if (!defaultSliceId) return;
    const slice = savedSlices[defaultSliceId];
    if (!slice || slice.scope !== selectedScope) return;
    // Only apply if no slice is already active for this scope (respect user choice).
    const sig = sliceSigs[selectedScope];
    if (sig?.activeSliceId) return;
    sliceStore.activateSlice(selectedScope, slice);
    // We deliberately do NOT list sliceSigs in deps — that would re-apply
    // after every SIG mutation, overwriting the user's manual slice picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScope, activeUserType, activeTypeDef, savedSlices]);
  const activeSliceType: SliceType = useMemo(() => {
    if (!selectedScope) return 'grid';
    const sig = sliceSigs[selectedScope];
    if (!sig) return 'grid';
    if (sig.activeSliceId === '__schema') return 'schema';
    if (!sig.activeSliceId) return 'grid';
    const sv = savedSlices[sig.activeSliceId];
    return sv?.sliceType || 'grid';
  }, [selectedScope, sliceSigs, savedSlices]);

  // Target of the record pinned in the active slice (only when sliceType === 'record')
  const activeRecordSliceTarget: string | null = useMemo(() => {
    if (activeSliceType !== 'record' || !selectedScope) return null;
    const sig = sliceSigs[selectedScope];
    if (!sig?.activeSliceId) return null;
    const sv = savedSlices[sig.activeSliceId];
    return sv?.config?.recordTarget ?? null;
  }, [activeSliceType, selectedScope, sliceSigs, savedSlices]);

  const mono = "'JetBrains Mono', monospace";

  return (
    <div style={{
      ...s.container,
      background: roleTint ? roleTint.bg : themedBg.bg,
      transition: 'background 0.5s cubic-bezier(.4,0,.2,1)',
    }}>
      {/* Dev-gated PressureMonitor badge (?pressure=1 or localStorage flag). */}
      <PressureBadge />
      {/* Persona strip — always visible at the very top when a persona is
          active so the user has a persistent at-a-glance indicator of the
          persona they're currently in (works on mobile and desktop). */}
      {activeTypeDef && roleAccentColor && (
        <div
          title={`Active persona: ${activeTypeDef.label}`}
          style={{
            flexShrink: 0,
            background: roleAccentColor,
            color: '#fff',
            fontFamily: mono,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: 'uppercase' as const,
            padding: '3px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            boxShadow: `0 1px 0 0 ${roleAccentColor}40`,
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#fff', opacity: 0.9, flexShrink: 0,
          }} />
          <span>{activeTypeDef.label}</span>
          <span style={{ opacity: 0.7, fontWeight: 500 }}>persona active</span>
        </div>
      )}
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
        <div style={s.topBarRow}>
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
            style={{
              ...s.spaceBadge,
              ...(roleAccentColor ? {
                borderColor: `${roleAccentColor}60`,
                background: `${roleAccentColor}10`,
              } : {}),
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: roleAccentColor || theme.accent,
              flexShrink: 0,
            }} />
            {selectedSpace
              ? (isAmino ? 'Amino' : formatSpaceName(selectedSpace.split('.').pop() || ''))
              : 'All Spaces'}
            {activeTypeDef && (
              <span style={{
                fontSize: 9, fontWeight: 600,
                color: roleAccentColor || theme.accent,
                background: roleAccentColor ? `${roleAccentColor}20` : theme.accentBg,
                padding: '1px 6px', borderRadius: 4,
                marginLeft: 2,
              }}>
                {activeTypeDef.label}
              </span>
            )}
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
                  peerSync: null,
                  webrtcPeer: null,
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

                // Seed the default law-firm personas so a fresh space has
                // sensible role segmentation out of the box. The admin can
                // rename, delete, or extend any of these via UserTypeManager.
                try {
                  await dispatch({
                    op: 'DEF',
                    target: spaceTarget,
                    operand: {
                      _user_type_definitions: DEFAULT_LAW_FIRM_PERSONAS,
                    },
                    agent: session.userId,
                    ts: new Date().toISOString(),
                    acquired_ts: new Date().toISOString(),
                  });
                } catch (e) {
                  console.warn('[EO-DB] Failed to seed default personas:', e);
                }

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

                _doSelectSpace(spaceTarget);
                setSpaceOpen(false);
              }}
              onDelete={handleDeleteSpace}
              onArchive={handleArchiveSpace}
              onOpenRecycleBin={() => { setShowRecycleBin(true); setSpaceOpen(false); }}
              deletedCount={deletedSpaceCount}
              archivedCount={archivedSpaceCount}
              publicEntries={isAmino ? [] : publicSpaceEntries.filter((e) =>
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
              actionError={spaceActionError}
              onDismissActionError={() => setSpaceActionError(null)}
            />
          )}

          {/* Members button — hidden on mobile. Opens (or focuses) a
              dedicated "Share / Members" tab instead of replacing the
              current view. */}
          {selectedSpace && !isMobile && (
            <button
              onClick={() => openRouteAsTab(
                { view: 'members', space: selectedSpace },
                { reuseByView: true },
              )}
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
              showPeers={presencePrefs.showPeers}
            />
          )}
          <ConnectionStatus
            state={connectionState}
            onRetry={connectionError?.phase === 'auth' ? handleLogout : retrySync}
            errorMessage={connectionMessage}
            retryLabel={connectionError?.phase === 'auth' ? 'Re-login' : undefined}
          />
          {showStoreLoading && (
            <div
              role="status"
              aria-live="polite"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: theme.bgMuted,
                color: theme.textSecondary,
                border: `1px solid ${theme.border}`,
                borderRadius: 20,
                padding: '4px 10px',
                fontSize: 11,
                fontWeight: 500,
                fontFamily: "'JetBrains Mono', monospace",
                whiteSpace: 'nowrap' as const,
                flexShrink: 0,
              }}
              title="Local data is still loading"
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  border: `1.5px solid ${theme.border}`,
                  borderTopColor: theme.accent,
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                  display: 'inline-block',
                }}
              />
              Loading data{lastSeq > 0 ? ` (${lastSeq})` : ''}…
            </div>
          )}
          {!isMobile && <SyncToast status={syncToastStatus} seq={syncToastSeq} />}
          {!isMobile && isAmino && <AirtableSyncBadge />}
          {selectedSpace && !isMobile && (
            <PermissionBadge role={currentRole} displayName={displayName} />
          )}
          {/* User type switcher. Admins (can_manage_members) also get
              "Preview as…" for personas they are not assigned to. Preview
              selections skip localStorage so they clear on refresh. */}
          {selectedSpace && !isMobile && (
            currentUserAssignedTypes.length > 0 ||
            (currentPermissions?.can_manage_members && spaceUserTypeDefinitions.length > 0)
          ) && (
            <UserTypeSwitcher
              typeDefinitions={spaceUserTypeDefinitions}
              assignedTypeIds={currentUserAssignedTypes}
              activeTypeId={activeUserType}
              canPreview={!!currentPermissions?.can_manage_members}
              onSelect={(typeId, opts) => setActiveUserType(typeId, !opts?.preview)}
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
        </div>

        {/* Horizon — integrated as a second row of the header */}
        {activeView === 'records' && (
          <div style={s.topBarHorizon}>
            <Horizon
              records={scopedRecords}
              dateColumns={dateColumns}
              filter={timeScrubberFilter}
              onFilterChange={setTimeScrubberFilter}
            />
          </div>
        )}
      </header>

      {/* Chrome-style tab strip — sits below the header, above every view */}
      <TabBar
        onActivate={(tab) => {
          navigate(routeFromTab(tab));
        }}
        onNewTab={() => {
          openRouteAsTab(
            { view: 'records', space: selectedSpace, scope: null, record: null },
            { reuseByView: false },
          );
        }}
      />

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

      {/* Persona quick actions — shown when active persona has actions for the current scope */}
      {activeView === 'records' && activeTypeDef?.quick_actions && selectedScope && (
        <PersonaQuickActions
          actions={activeTypeDef.quick_actions}
          currentScope={selectedScope}
          typeColor={activeTypeDef.color}
          onRecordCreated={(target) => navigate({ record: target })}
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
                <SyncProgress message="Initializing store..." detail="Loading local data..." />
              )}
              <HolonNav
                selectedScope={selectedScope}
                onSelectScope={(scope) => { navigate({ view: 'records', scope, record: null }); }}
                onSelectSegment={(_scope, _seg) => { navigate({ view: 'records', scope: _scope }); }}
                userId={session.userId}
                selectedRecord={selectedRecord}
                onSelectRecord={(rec) => { navigate({ record: rec }); }}
                peersByScope={peersByScope}
              />
            </>
          )}

          {(() => {
            // Helper: is this view visible given the active role's visible_views restriction?
            function isNavViewVisible(view: View): boolean {
              if (!activeTypeDef?.visible_views?.length) return true;
              return activeTypeDef.visible_views.includes(view);
            }
            // Helper: resolve a terminology label for the active persona, falling back to default.
            function term(key: TerminologyKey): string {
              return resolveTerminology(key, activeTypeDef);
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
            const CONFIGURABLE_VIEWS: View[] = ['compose', 'import', 'people', 'members', 'log', 'builder', 'settings'];
            const hiddenCount = activeTypeDef?.visible_views
              ? CONFIGURABLE_VIEWS.filter(v => !activeTypeDef.visible_views!.includes(v)).length
              : 0;
            return (
          <nav style={s.sidebarNav}>
            <div style={s.navGroupLabel}>Actions</div>
            {(['compose', 'import'] as View[]).map((view) => isNavViewVisible(view) && (
              <button
                key={view}
                onClick={() => openRouteAsTab({ view, space: selectedSpace }, { reuseByView: true })}
                style={navItemStyle(view)}
              >
                <span style={s.navIcon}>{NAV_ICONS[view]}</span>
                {view === 'compose' ? `+ ${term('compose')}` : term(view as TerminologyKey)}
              </button>
            ))}
            <div style={s.navGroupLabel}>Collaborate</div>
            {isNavViewVisible('people') && (
              <button
                onClick={() => openRouteAsTab({ view: 'people', space: selectedSpace }, { reuseByView: true })}
                style={navItemStyle('people')}
              >
                <span style={s.navIcon}>{NAV_ICONS.people}</span>
                {term('people')}
              </button>
            )}
            {isNavViewVisible('members') && (
              <button
                onClick={() => openRouteAsTab({ view: 'members', space: selectedSpace }, { reuseByView: true })}
                style={navItemStyle('members')}
              >
                <span style={s.navIcon}>{NAV_ICONS.members}</span>
                {term('members')} &amp; Roles
              </button>
            )}
            <div style={s.navGroupLabel}>System</div>
            {isNavViewVisible('log') && (
              <button
                onClick={() => openRouteAsTab({ view: 'log', space: selectedSpace }, { reuseByView: true })}
                style={navItemStyle('log')}
              >
                <span style={s.navIcon}>{NAV_ICONS.log}</span>
                {term('log')}
              </button>
            )}
            {currentPermissions?.can_build_slices !== false && isNavViewVisible('builder') && (
              <button
                onClick={() => openRouteAsTab({ view: 'builder', space: selectedSpace, builderViewId: null, customPageId: null }, { reuseByView: true })}
                style={navItemStyle('builder')}
              >
                <span style={s.navIcon}>{NAV_ICONS.builder}</span>
                Builder
              </button>
            )}
            {currentPermissions?.can_set_governance !== false && isNavViewVisible('settings') && (
              <button
                onClick={() => openRouteAsTab({ view: 'settings', space: selectedSpace }, { reuseByView: true })}
                style={navItemStyle('settings')}
              >
                <span style={s.navIcon}>{NAV_ICONS.settings}</span>
                Settings
              </button>
            )}
            <div style={s.navGroupLabel}>Testing</div>
            <button
              onClick={() => openRouteAsTab({ view: 'multiuser', space: selectedSpace }, { reuseByView: true })}
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

        <main style={{
          ...s.main,
          background: roleTint ? roleTint.bg : themedBg.bg,
          transition: 'background 0.5s cubic-bezier(.4,0,.2,1)',
        }} key={selectedSpace ?? '__all__'}>
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
            <Suspense fallback={<div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13 }}>Loading…</div>}>
            {activeView === 'records' ? (
              <>
                {selectedScope && isLeafScope ? (
                  <RecordView
                    target={selectedScope}
                    onNavigate={(t) => navigate({ scope: t, record: null })}
                  />
                ) : selectedScope ? (
                  <div style={{
                    flex: 1,
                    minHeight: 0,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column' as const,
                    padding: isMobile ? 0 : '14px 16px 16px',
                  }}>
                    <div style={{
                      flex: 1,
                      minHeight: 0,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column' as const,
                      background: themedBg.bgCard,
                      border: `1px solid ${themedBg.border}`,
                      borderRadius: isMobile ? 0 : 10,
                      overflow: 'hidden',
                      boxShadow: isMobile ? 'none' : `0 1px 2px ${theme.shadow}, 0 4px 16px ${theme.shadow}`,
                    }}>
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
                      ) : activeSliceType === 'record' ? (
                        activeRecordSliceTarget ? (
                          <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? 12 : 20 }}>
                            <RecordView
                              target={activeRecordSliceTarget}
                              onNavigate={(t) => navigate({ record: t })}
                            />
                          </div>
                        ) : (
                          <div style={{
                            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            flexDirection: 'column' as const, gap: 8, color: theme.textMuted,
                          }}>
                            <div style={{ fontSize: 28, opacity: 0.3 }}>{'\u25C9'}</div>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>No record pinned</div>
                          </div>
                        )
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
                      ) : activeSliceType === 'kanban' ? (
                        <KanbanView
                          scope={selectedScope}
                          onSelectRecord={(rec) => navigate({ record: rec })}
                          activeRecord={selectedRecord}
                          session={{ userId: session.userId }}
                          permissions={currentPermissions}
                          sliceReadOnly={(() => {
                            if (!activeUserType) return false;
                            const sig = sliceSigs[selectedScope];
                            if (!sig?.activeSliceId) return false;
                            const sv = savedSlices[sig.activeSliceId];
                            return sv?.readOnlyForTypes?.includes(activeUserType) ?? false;
                          })()}
                        />
                      ) : activeSliceType === 'calendar' ? (
                        <CalendarView
                          scope={selectedScope}
                          onSelectRecord={(rec) => navigate({ record: rec })}
                          activeRecord={selectedRecord}
                          session={{ userId: session.userId }}
                          permissions={currentPermissions}
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
                          <div style={{ fontSize: 28, opacity: 0.3 }}>{'\u25A6'}</div>
                          <div style={{ fontSize: 13, fontWeight: 500 }}>
                            {activeSliceType.charAt(0).toUpperCase() + activeSliceType.slice(1)} slice
                          </div>
                          <div style={{ fontSize: 11, opacity: 0.7 }}>Coming soon</div>
                        </div>
                      )}
                    </div>
                  </div>
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
            ) : activeView === 'people' ? (
              matrixClientRef.current ? (
                <PeopleView
                  matrixClient={matrixClientRef.current as any}
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
                <div style={{
                  flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto',
                  padding: isMobile ? '12px' : '24px 32px',
                }}>
                  <div style={{ maxWidth: 720, margin: '0 auto' }}>
                    <SpaceMembers
                      spaceTarget={selectedSpace}
                      currentUserId={session.userId}
                      onClose={() => {
                        // Close the Members tab if one is open; otherwise
                        // fall back to navigating away to the records view.
                        const st = useTabsStore.getState();
                        const memberTab = st.tabs.find((t) => t.view === 'members');
                        if (memberTab && st.tabs.length > 1) {
                          st.closeTab(memberTab.id);
                          const nextId = useTabsStore.getState().activeTabId;
                          const next = useTabsStore.getState().tabs.find((t) => t.id === nextId);
                          if (next) navigate(routeFromTab(next));
                        } else {
                          navigate({ view: 'records' });
                        }
                      }}
                      matrixClient={matrixClientRef.current}
                      mainRoomId={spaceRoomId}
                    />
                  </div>
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
            ) : null}
            </Suspense>
          </ErrorBoundary>}
        </main>

        {selectedRecord && activeView === 'records' && !(detailsPanelCollapsed && !isMobile) && (
          <RecordPageOrDrawer
            recordTarget={selectedRecord}
            allStates={allStates}
            onClose={() => { navigate({ record: null }); }}
            onNavigate={(t) => { navigate({ record: t }); }}
            onCollapse={!isMobile ? () => setDetailsPanelCollapsed(true) : undefined}
            profileFields={selectedScope ? sliceStore.getConfig(selectedScope).profileFields : undefined}
            isMobile={isMobile}
            tableRecordTargets={tableRecordTargets}
            userId={session.userId}
          />
        )}

        {activeView === 'records' && detailsPanelCollapsed && !isMobile && (
          <aside
            style={{
              width: 28,
              flexShrink: 0,
              borderLeft: `1px solid ${theme.border}`,
              background: theme.bgCard,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              paddingTop: 12,
            }}
            aria-label="Details panel (collapsed)"
          >
            <button
              onClick={() => setDetailsPanelCollapsed(false)}
              title="Expand details panel"
              aria-label="Expand details panel"
              style={{
                background: 'none',
                border: `1px solid ${theme.border}`,
                borderRadius: 4,
                width: 22,
                height: 48,
                color: theme.textSecondary,
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {'\u2039'}
            </button>
          </aside>
        )}
      </div>

      <Modal
        open={!!pendingSpaceSwitch}
        onClose={() => setPendingSpaceSwitch(null)}
        title="Switch spaces?"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              onClick={() => setPendingSpaceSwitch(null)}
              style={{
                padding: '6px 14px',
                background: theme.bgMuted,
                color: theme.text,
                border: `1px solid ${theme.border}`,
                borderRadius: 4,
                fontSize: 12,
                fontFamily: "'Outfit', sans-serif",
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={confirmSpaceSwitch}
              style={{
                padding: '6px 14px',
                background: theme.accent,
                color: '#fff',
                border: `1px solid ${theme.accent}`,
                borderRadius: 4,
                fontSize: 12,
                fontFamily: "'Outfit', sans-serif",
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Switch &amp; wipe cache
            </button>
          </div>
        }
      >
        <div style={{ fontSize: 13, lineHeight: 1.5, color: theme.text }}>
          Are you sure you want to switch spaces? This will wipe your local cache of it.
        </div>
      </Modal>
    </div>
  );
}

/**
 * RecordPageOrDrawer — When a record is selected, check if there's a custom
 * record page view for the record's collection. If yes, render RecordPageView
 * in a drawer. If no, fall back to the default RecordDetailDrawer.
 */
function RecordPageOrDrawer({ recordTarget, allStates, onClose, onNavigate, onCollapse, profileFields, isMobile, tableRecordTargets, userId }: {
  recordTarget: string;
  allStates: EoState[];
  onClose: () => void;
  onNavigate: (target: string) => void;
  onCollapse?: () => void;
  profileFields?: string[];
  isMobile?: boolean;
  tableRecordTargets?: string[];
  userId?: string;
}) {
  const loadView = useBuilderStore((s) => s.loadView);
  const getState = useEoStore((s) => s.getState);
  const activeUserType = useEoStore((s) => s.activeUserType);
  const [layoutType, setLayoutType] = useState<LayoutDisplayType>('drawer');

  // ── Existence check ──────────────────────────────────────────────────────
  // Avoid the "drawer flashes Record not found" bug: if the record doesn't
  // exist in the current store (e.g., stale route param after a scope switch),
  // close once and render nothing instead of showing a useless drawer.
  // 'checking' = initial load, 'exists' = render, 'missing' = auto-closed.
  const [existence, setExistence] = useState<'checking' | 'exists' | 'missing'>('checking');
  useEffect(() => {
    let cancelled = false;
    setExistence('checking');
    getState(recordTarget)
      .then((state) => {
        if (cancelled) return;
        if (state && state.value != null) {
          setExistence('exists');
        } else {
          setExistence('missing');
          onClose();
        }
      })
      .catch(() => {
        if (cancelled) return;
        setExistence('missing');
        onClose();
      });
    return () => { cancelled = true; };
  }, [recordTarget, getState, onClose]);

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

  // Find a record page view whose recordSource.scope matches this record's parent.
  // Prefer a view scoped to the current persona (via visibleToTypes) so that
  // different personas can see different record layouts for the same record.
  // Views restricted to *other* personas are skipped; views with no restriction
  // are used as a fallback when no persona-scoped match exists.
  const recordPageView = useMemo(() => {
    const parts = recordTarget.split('.');
    const possibleScopes: string[] = [];
    for (let i = parts.length - 1; i >= 1; i--) {
      possibleScopes.push(parts.slice(0, i).join('.'));
    }

    const viewStates = allStates.filter(s => s.target.startsWith('views.'));
    type Candidate = { viewId: string; definition: ViewDefinition };
    let personaMatch: Candidate | null = null;
    let generalMatch: Candidate | null = null;
    for (const vs of viewStates) {
      const def = vs.value as ViewDefinition | null;
      if (!def || def.pageType !== 'record' || !def.recordSource?.scope) continue;
      if (!possibleScopes.includes(def.recordSource.scope)) continue;
      const viewId = vs.target.replace(/^views\./, '');
      const restriction = def.visibleToTypes;
      if (!restriction || restriction.length === 0) {
        if (!generalMatch) generalMatch = { viewId, definition: def };
        continue;
      }
      if (activeUserType && restriction.includes(activeUserType)) {
        if (!personaMatch) personaMatch = { viewId, definition: def };
      }
    }
    return personaMatch ?? generalMatch;
  }, [recordTarget, allStates, activeUserType]);

  // Load the record page view into the builder store when found
  useEffect(() => {
    if (recordPageView) {
      loadView(recordPageView.viewId, recordPageView.definition);
    }
  }, [recordPageView, loadView]);

  // Don't render anything while we're still checking, or once we've decided
  // the record is missing (we've already called onClose to clear the route).
  if (existence !== 'exists') return null;

  // If we have a matching record page, render RecordPageView in an inline panel
  if (recordPageView) {
    return (
      <div style={{
        width: isMobile ? '100vw' : 720, maxWidth: isMobile ? '100vw' : '55vw', height: '100%',
        flexShrink: 0, borderLeft: isMobile ? 'none' : '1px solid var(--border, #e0e0e0)',
        background: 'var(--bg, #fff)', display: 'flex', flexDirection: 'column',
        position: 'relative' as const,
        ...(isMobile ? { position: 'fixed' as const, inset: 0, zIndex: 1000 } : {}),
      }}>
        {onCollapse && !isMobile && (
          <button
            onClick={onCollapse}
            title="Collapse panel (keeps record selected)"
            aria-label="Collapse panel"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 2,
              background: 'var(--bg-card, #fff)',
              border: '1px solid var(--border, #e0e0e0)',
              borderRadius: 4,
              width: 24,
              height: 24,
              padding: 0,
              fontSize: 14,
              lineHeight: 1,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {'\u00BB'}
          </button>
        )}
        <Suspense fallback={null}>
          <RecordPageView
            recordTarget={recordTarget}
            onNavigate={onNavigate}
            onBack={onClose}
          />
        </Suspense>
      </div>
    );
  }

  // Fallback to default drawer
  return (
    <RecordDetailDrawer
      target={recordTarget}
      onClose={onClose}
      onNavigate={onNavigate}
      onCollapse={onCollapse}
      profileFields={profileFields}
      isMobile={isMobile}
      layoutType={layoutType}
      tableRecordTargets={tableRecordTargets}
      userId={userId}
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

    // Top bar — taller, cleaner, less dense; column layout so Horizon can sit as a sub-row
    topBar: {
      display: 'flex',
      flexDirection: 'column',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      transition: 'background 0.25s ease',
    },
    topBarRow: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 12px',
      height: 48,
      gap: 8,
    },
    topBarHorizon: {
      borderTop: `0.5px solid ${t.borderLight ?? t.border}`,
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
