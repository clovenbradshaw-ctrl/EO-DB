/**
 * One-shot orchestrator for the EO-native sync worker.
 *
 * `startNetworkSyncSystem` wires together the Worker, the
 * `NetworkSyncClient`, the concrete transports, and the bridge —
 * returning a single handle the host (`Layout.tsx`) can dispose.
 *
 * Also holds the *single-active-protocol* guard required by spec
 * invariant §5: for any given room, only one of the legacy PeerSync
 * and the new operator-native sync may be running at a time.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from './../db/encrypted-store';
import type { EoEvent } from './../db/types';
import type { WebRTCPeer } from './../matrix/webrtc-peer';
import { createNetworkSyncClient } from './network-sync-client';
import type { NetworkSyncClient, WorkerLike } from './network-sync-client';
import { createNetworkSyncBridge } from './network-sync-bridge';
import type { NetworkSyncBridge } from './network-sync-bridge';
import {
  createMatrixTransport,
  createRtcTransport,
  createStoreAdapter,
  wireInbound,
} from './network-sync-wiring';
import { readLogSince } from './../db/log';
import { peerSite } from './sites';

// ─── Guard: one protocol per room at a time ─────────────────────────────

type Protocol = 'legacy' | 'operator';
const activeProtocolByRoom = new Map<string, Protocol>();

export class TwoProtocolConflictError extends Error {
  constructor(public readonly roomId: string, public readonly active: Protocol) {
    super(
      `Room ${roomId} already has ${active} sync active — refusing to start a second protocol.`,
    );
    this.name = 'TwoProtocolConflictError';
  }
}

/** Register a protocol as active for a room. Throws if another is already active. */
export function claimRoomProtocol(roomId: string, protocol: Protocol): void {
  const existing = activeProtocolByRoom.get(roomId);
  if (existing && existing !== protocol) {
    throw new TwoProtocolConflictError(roomId, existing);
  }
  activeProtocolByRoom.set(roomId, protocol);
}

/** Release a room's protocol claim (call on teardown). */
export function releaseRoomProtocol(roomId: string, protocol: Protocol): void {
  const existing = activeProtocolByRoom.get(roomId);
  if (existing === protocol) activeProtocolByRoom.delete(roomId);
}

/** Query helper — exposed for tests and the feature-flag check. */
export function getActiveProtocol(roomId: string): Protocol | null {
  return activeProtocolByRoom.get(roomId) ?? null;
}

// ─── Feature-flag helpers ───────────────────────────────────────────────

/**
 * Returns true if the operator-native sync mode is enabled for this
 * session, either via build-time env (`VITE_NETWORK_SYNC_WORKER === '2'`)
 * or a user-override localStorage flag (`eo.sync.mode === 'operator'`).
 */
export function isOperatorSyncEnabled(envValue?: string): boolean {
  if (envValue === '2') return true;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('eo.sync.mode') === 'operator') {
      return true;
    }
  } catch {
    // localStorage may throw in SSR / sandboxed contexts — ignore.
  }
  return false;
}

// ─── System handle ──────────────────────────────────────────────────────

export interface NetworkSyncSystemDeps {
  matrix: MatrixClient;
  roomId: string;
  store: EoStore;
  webrtcPeer: WebRTCPeer;
  userId: string;
  deviceId: string;
  /** Initiates an RTC DC on `open_dc`. */
  connectRtc?: (peerUserId: string, peerDeviceId: string) => Promise<void>;
  /** Disconnects on `close_dc`. */
  disconnectRtc?: (peerUserId: string, peerDeviceId: string) => Promise<void>;
  /** Optional callback after a folded event is fed into the worker. */
  onFoldEvent?: (event: EoEvent) => void;
  /**
   * Worker factory — injectable so tests can stub the Worker with an
   * in-process driver. Production uses `new Worker(...)`.
   */
  createWorker: () => WorkerLike;
  /** Deterministic seed for the scheduler (default: random). */
  seed?: number;
  /** Epoch ms function (default: Date.now). */
  now?: () => number;
}

export interface NetworkSyncSystem {
  client: NetworkSyncClient;
  bridge: NetworkSyncBridge;
  /** Stop worker, disconnect inbound listeners, release protocol claim. */
  stop(): Promise<void>;
}

export async function startNetworkSyncSystem(deps: NetworkSyncSystemDeps): Promise<NetworkSyncSystem> {
  claimRoomProtocol(deps.roomId, 'operator');

  const now = deps.now ?? (() => Date.now());
  const worker = deps.createWorker();
  const client = createNetworkSyncClient(worker, { now });

  const onFoldEvent = (event: EoEvent) => {
    client.reportFoldedEvent(event);
    deps.onFoldEvent?.(event);
  };

  const matrixTransport = createMatrixTransport({
    client: deps.matrix,
    roomId: deps.roomId,
    store: deps.store,
    onLocallyFolded: onFoldEvent,
  });

  const connectRtc = deps.connectRtc ?? ((u, d) => deps.webrtcPeer.connect(u, d, 0));
  const disconnectRtc = deps.disconnectRtc ?? ((u, d) => deps.webrtcPeer.disconnect(u, d));
  const rtcTransport = createRtcTransport({
    peer: deps.webrtcPeer,
    connect: connectRtc,
    disconnect: disconnectRtc,
  });
  const storeAdapter = createStoreAdapter({ store: deps.store });

  const bridge = createNetworkSyncBridge({
    matrix: matrixTransport,
    rtc: rtcTransport,
    store: storeAdapter,
    client,
    now,
  });

  const unsubInbound = wireInbound({
    client,
    matrix: deps.matrix,
    peer: deps.webrtcPeer,
    roomId: deps.roomId,
  });

  // Seed the worker's projection with everything already in the local
  // log — the projection is a pure function of the log (§invariant 1).
  const seedEvents = await readLogSince(deps.store, 0);

  await client.start({
    roomId: deps.roomId,
    myDeviceId: deps.deviceId,
    myUserId: deps.userId,
    seedEvents,
    nowMs: now(),
    seed: deps.seed ?? Math.floor(Math.random() * 0xffffffff),
  });

  // Record self in the swarm via a synthetic CON — lets the worker find
  // this device's own peer_site through the projection. The main thread
  // will fold this through the normal path, so we route via Matrix.
  await matrixTransport.emitEoEvent(buildSelfJoin(deps));

  return {
    client,
    bridge,
    async stop() {
      unsubInbound();
      bridge.dispose();
      await client.stop();
      releaseRoomProtocol(deps.roomId, 'operator');
    },
  };
}

function buildSelfJoin(deps: NetworkSyncSystemDeps): EoEvent {
  const selfPeer = peerSite(deps.userId, deps.deviceId);
  const nowIso = new Date((deps.now ?? (() => Date.now()))()).toISOString();
  return {
    seq: -1,
    op: 'CON',
    target: `swarm:${deps.roomId}`,
    operand: { joined: selfPeer, coupling: 'active' },
    agent: `${deps.userId}|${deps.deviceId}`,
    ts: nowIso,
    acquired_ts: nowIso,
    level: 2,
    meta: { origin_device_id: deps.deviceId, origin_user_id: deps.userId },
  } as EoEvent;
}

// ─── Reset for tests ────────────────────────────────────────────────────

/** Clear the activeProtocolByRoom map. Tests only. */
export function _resetProtocolGuardForTests(): void {
  activeProtocolByRoom.clear();
}
