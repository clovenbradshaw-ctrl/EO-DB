/**
 * Sync store — tracks connected peers, storage locations, and sync status.
 *
 * Provides the state backing for the Data Sync Dashboard.
 */

import { create } from 'zustand';
import { pressureMonitor } from '../perf/pressure-monitor';

export interface PeerInfo {
  userId: string;
  deviceId: string;
  lastSeq: number;
  lastSeen: string;       // ISO 8601
  status: 'online' | 'offline' | 'syncing';
  storageType: 'indexeddb' | 'leveldb';
  homeserver: string;
}

export interface StorageLocation {
  id: string;
  label: string;
  type: 'indexeddb' | 'matrix-media' | 'leveldb' | 'backup';
  path: string;             // display path or description
  encrypted: boolean;
  sizeEstimate?: string;    // human-readable size
  lastWrite?: string;       // ISO 8601
}

export interface SyncPair {
  sourceId: string;
  targetId: string;
  status: 'synced' | 'behind' | 'ahead' | 'conflict' | 'offline';
  sourceSeq: number;
  targetSeq: number;
  lag: number;              // targetSeq - sourceSeq (negative = behind)
  lastSync?: string;        // ISO 8601
}

interface SyncStoreState {
  /** This device's peer info */
  localPeer: PeerInfo | null;
  /** All known peers (including self) */
  peers: PeerInfo[];
  /** Known storage locations */
  storageLocations: StorageLocation[];
  /** Sync relationships between peers */
  syncPairs: SyncPair[];
  /** Matrix room used for sync */
  syncRoomId: string | null;
  /** Offline queue depth */
  offlineQueueSize: number;
  /** Last snapshot seq */
  lastSnapshotSeq: number;
  /** Last snapshot mxc URI */
  lastSnapshotMxc: string | null;

  /** Initialize from session + store state */
  initialize: (opts: {
    userId: string;
    deviceId: string;
    homeserver: string;
    localSeq: number;
    offlineQueueSize: number;
    lastSnapshotSeq: number;
    lastSnapshotMxc: string | null;
    syncRoomId: string | null;
  }) => void;

  /** Update local seq */
  updateLocalSeq: (seq: number) => void;

  /** Add or update a peer */
  upsertPeer: (peer: PeerInfo) => void;

  /** Remove a peer */
  removePeer: (userId: string, deviceId: string) => void;

  /** Update a sync pair */
  updateSyncPair: (pair: SyncPair) => void;

  /** Update offline queue size */
  setOfflineQueueSize: (size: number) => void;

  /** Update last snapshot seq and optional mxc URI */
  setLastSnapshotSeq: (seq: number, mxc?: string) => void;

  /** Reset all state (called on space switch) */
  reset: () => void;
}

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  localPeer: null,
  peers: [],
  storageLocations: [],
  syncPairs: [],
  syncRoomId: null,
  offlineQueueSize: 0,
  lastSnapshotSeq: 0,
  lastSnapshotMxc: null,

  initialize({ userId, deviceId, homeserver, localSeq, offlineQueueSize, lastSnapshotSeq, lastSnapshotMxc, syncRoomId }) {
    const localPeer: PeerInfo = {
      userId,
      deviceId,
      lastSeq: localSeq,
      lastSeen: new Date().toISOString(),
      status: navigator.onLine ? 'online' : 'offline',
      storageType: 'indexeddb',
      homeserver,
    };

    const storageLocations: StorageLocation[] = [
      {
        id: 'local-idb',
        label: 'Local Device (IndexedDB)',
        type: 'indexeddb',
        path: `indexeddb://eo-db/kv`,
        encrypted: true,
        lastWrite: new Date().toISOString(),
      },
      {
        id: 'matrix-room',
        label: 'Matrix Room (E2EE)',
        type: 'matrix-media',
        path: syncRoomId || '(not configured)',
        encrypted: true,
      },
      {
        id: 'matrix-snapshots',
        label: 'Matrix Media (Snapshots)',
        type: 'matrix-media',
        path: `${homeserver}/_matrix/media/`,
        encrypted: true,
        sizeEstimate: lastSnapshotSeq > 0 ? `snapshot @ seq ${lastSnapshotSeq}` : 'No snapshots yet',
      },
    ];

    set({
      localPeer,
      peers: [localPeer],
      storageLocations,
      syncRoomId,
      offlineQueueSize,
      lastSnapshotSeq,
      lastSnapshotMxc,
    });
  },

  updateLocalSeq(seq: number) {
    set((s) => {
      const localPeer = s.localPeer ? { ...s.localPeer, lastSeq: seq, lastSeen: new Date().toISOString() } : null;
      const peers = s.peers.map((p) =>
        p.userId === s.localPeer?.userId && p.deviceId === s.localPeer?.deviceId
          ? { ...p, lastSeq: seq, lastSeen: new Date().toISOString() }
          : p,
      );
      const storageLocations = s.storageLocations.map((loc) =>
        loc.id === 'local-idb' ? { ...loc, lastWrite: new Date().toISOString() } : loc,
      );
      return { localPeer, peers, storageLocations };
    });
  },

  upsertPeer(peer: PeerInfo) {
    set((s) => {
      const idx = s.peers.findIndex((p) => p.userId === peer.userId && p.deviceId === peer.deviceId);
      if (idx >= 0) {
        const peers = [...s.peers];
        peers[idx] = peer;
        return { peers };
      }
      return { peers: [...s.peers, peer] };
    });
  },

  removePeer(userId: string, deviceId: string) {
    set((s) => ({
      peers: s.peers.filter((p) => !(p.userId === userId && p.deviceId === deviceId)),
    }));
  },

  updateSyncPair(pair: SyncPair) {
    set((s) => {
      const idx = s.syncPairs.findIndex(
        (sp) => sp.sourceId === pair.sourceId && sp.targetId === pair.targetId,
      );
      let syncPairs: SyncPair[];
      if (idx >= 0) {
        syncPairs = [...s.syncPairs];
        syncPairs[idx] = pair;
      } else {
        syncPairs = [...s.syncPairs, pair];
      }
      // Feed |lag| to PressureMonitor (Phase 1 observe-only).
      let maxLag = 0;
      for (const sp of syncPairs) {
        const mag = Math.abs(sp.lag);
        if (mag > maxLag) maxLag = mag;
      }
      pressureMonitor.reportSyncLag(maxLag);
      return { syncPairs };
    });
  },

  setOfflineQueueSize(size: number) {
    set({ offlineQueueSize: size });
  },

  setLastSnapshotSeq(seq: number, mxc?: string) {
    set((s) => ({
      lastSnapshotSeq: seq,
      lastSnapshotMxc: mxc ?? s.lastSnapshotMxc,
      storageLocations: s.storageLocations.map((loc) =>
        loc.id === 'matrix-snapshots'
          ? { ...loc, sizeEstimate: `snapshot @ seq ${seq}` }
          : loc,
      ),
    }));
  },

  reset() {
    set({
      localPeer: null,
      peers: [],
      storageLocations: [],
      syncPairs: [],
      syncRoomId: null,
      offlineQueueSize: 0,
      lastSnapshotSeq: 0,
      lastSnapshotMxc: null,
    });
  },
}));
