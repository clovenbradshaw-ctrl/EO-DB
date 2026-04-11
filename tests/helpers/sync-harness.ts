/**
 * Two/three peer sync convergence harness.
 *
 * Wires multiple real SyncManager + PeerSync instances together through a
 * shared in-memory "homeserver" (shared room timeline, shared room state,
 * shared media blob store, shared to-device bus) so tests can drive the
 * whole replication pipeline and assert convergence as a black box.
 *
 * The mock factories mirror tests/matrix-sync.test.ts:70-210 with the
 * following generalizations:
 *   - every peer's mock Room reads from one shared timeline + state map
 *   - sendEvent / sendStateEvent / sendToDevice / uploadContent are routed
 *     through shared buses so writes from peer A are observed by peer B
 *   - uploadContent stores bytes in a Map keyed by generated mxc URIs, and
 *     a stub global fetch resolves those URIs back to the bytes (required
 *     for snapshot.ts restoreFromDeltaChain)
 *   - goOffline/goOnline flip per-peer flags that cause sendEvent /
 *     uploadContent / sendToDevice to throw an ECONNRESET-shaped error so
 *     isTransientError() treats it as retryable
 *
 * There are no production-code changes: everything here uses public
 * exports from src/matrix/ and src/db/.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

import {
  createDb,
  getCurrentSeq,
  decode,
  type EoDb,
} from '../../src/db/level.js';
import { storeFingerprint } from '../../src/db/hash.js';
import type { EoEventInput, EoState } from '../../src/db/types.js';

import { SyncManager } from '../../src/matrix/sync-manager.js';
import { PeerSync } from '../../src/matrix/peer-sync.js';
import type {
  IMatrixClient,
  IMatrixEvent,
  IRoom,
  IRoomState,
  IRoomMember,
  ITimeline,
} from '../../src/matrix/types.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface HarnessPeerOpts {
  userId: string;
  deviceId: string;
}

export type HarnessClient = IMatrixClient & {
  _sent: Array<{ roomId: string; type: string; content: any; stateKey?: string }>;
  _uploads: Array<{ data: Uint8Array; name: string }>;
  _toDevice: Array<{ type: string; contentMap: Map<string, Map<string, any>> }>;
  _listeners: Map<string, Array<(...args: any[]) => void>>;
};

export interface PeerStateSnapshot {
  seq: number;
  fingerprint: string;
  state: Map<string, EoState>;
}

export interface HarnessPeer {
  userId: string;
  deviceId: string;
  client: HarnessClient;
  db: EoDb;
  dbPath: string;
  sync: SyncManager;
  peerSync: PeerSync;

  /** Flip this peer into a "network error" mode — sendEvent/upload/toDevice throw. */
  goOffline(): void;
  /** Restore normal network behaviour. */
  goOnline(): void;

  /** Write a single event through processLocalEvent. */
  write(
    event: Pick<EoEventInput, 'op' | 'target' | 'operand'> & Partial<EoEventInput>,
  ): Promise<number>;

  currentSeq(): Promise<number>;
  fingerprint(): Promise<string>;
  snapshotPeer(): Promise<PeerStateSnapshot>;

  /** Await any in-flight to-device handler work on this peer. */
  drainInFlight(): Promise<void>;

  destroy(): Promise<void>;
}

export interface Harness {
  roomId: string;
  peers: HarnessPeer[];

  /** Add a new peer mid-run (used by "new peer bootstrap" scenarios). */
  addPeer(opts: HarnessPeerOpts): Promise<HarnessPeer>;

  /** Drop the next N timeline deliveries destined for `toPeer` (storage still records them). */
  dropNextTimelineDeliveries(toPeer: HarnessPeer, n: number): void;
  /** Drop the next N to-device deliveries destined for `toPeer`. */
  dropNextToDeviceDeliveries(toPeer: HarnessPeer, n: number): void;

  /** Force-flush every peer's SendBuffer and drain microtasks. */
  flushAll(): Promise<void>;

  /**
   * Drive the peer-sync exchange until every peer's store fingerprint matches,
   * or throw if they do not converge within `iterations` rounds.
   */
  waitForConvergence(opts?: { iterations?: number }): Promise<void>;

  /**
   * Drive peer-sync for a few rounds and then return — does NOT assert
   * convergence. Useful for tests that verify value-level equality without
   * requiring strict fingerprint equality (e.g., concurrent writes to the
   * same target where state.hash is order-dependent).
   */
  settle(opts?: { rounds?: number }): Promise<void>;

  destroy(): Promise<void>;
}

// ─── Shared bus state ──────────────────────────────────────────────────────

interface SharedState {
  roomId: string;
  /** Canonical room timeline — one ordered list, every peer's mock Room reads from it. */
  timeline: IMatrixEvent[];
  /** Canonical room state map (type → stateKey → IMatrixEvent). */
  state: Map<string, Map<string, IMatrixEvent>>;
  /** Media blob store keyed by mxc URI. */
  media: Map<string, Uint8Array>;
  /** Monotonic counter for generated mxc URIs and event IDs. */
  nextId: { n: number };
  /** Registered peers — used for dispatching timeline + to-device deliveries. */
  peers: HarnessPeer[];
  /** Per-peer drop counters for timeline deliveries. */
  timelineDropCount: Map<string, number>;
  /** Per-peer drop counters for to-device deliveries. */
  toDeviceDropCount: Map<string, number>;
  /**
   * Per-target-device delivery chain. To-device messages fan out through this
   * chain so a second batch cannot overlap a still-processing first batch.
   * peer-sync's handleToDeviceEvent is sync-registered and fire-and-forget,
   * so we approximate "handler finished" with a post-dispatch drain.
   */
  toDeviceChains: Map<string, Promise<void>>;
}

function newSharedState(roomId: string): SharedState {
  return {
    roomId,
    timeline: [],
    state: new Map(),
    media: new Map(),
    nextId: { n: 0 },
    peers: [],
    timelineDropCount: new Map(),
    toDeviceDropCount: new Map(),
    toDeviceChains: new Map(),
  };
}

function makeMatrixEvent(opts: {
  type: string;
  content: Record<string, any>;
  sender: string;
  roomId: string;
  eventId: string;
  ts?: number;
  stateKey?: string | null;
}): IMatrixEvent {
  const ts = opts.ts ?? Date.now();
  return {
    getType: () => opts.type,
    getContent: () => opts.content,
    getSender: () => opts.sender,
    getRoomId: () => opts.roomId,
    getId: () => opts.eventId,
    getTs: () => ts,
    getStateKey: () => opts.stateKey ?? null,
  };
}

// ─── Microtask draining ────────────────────────────────────────────────────

/** Yield to the event loop so any pending microtasks + setImmediate callbacks run. */
async function drain(rounds: number = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ─── Stub fetch ────────────────────────────────────────────────────────────

let sharedForFetch: SharedState | null = null;
let originalFetch: typeof fetch | undefined;
let fetchStubbed = false;

function installFetchStub(shared: SharedState): void {
  sharedForFetch = shared;
  if (fetchStubbed) return;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, _init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const prefix = 'http://harness.local/';
    if (!url.startsWith(prefix) || !sharedForFetch) {
      throw new Error(`harness fetch stub: unexpected URL ${url}`);
    }
    const mxc = url.slice(prefix.length);
    const bytes = sharedForFetch.media.get(mxc);
    if (!bytes) {
      return new Response(null, { status: 404, statusText: 'Not Found' });
    }
    return new Response(bytes as any, { status: 200, statusText: 'OK' });
  }) as any;
  fetchStubbed = true;
}

function uninstallFetchStub(): void {
  if (!fetchStubbed) return;
  if (originalFetch) globalThis.fetch = originalFetch;
  fetchStubbed = false;
  sharedForFetch = null;
}

// ─── Mock Room factory ─────────────────────────────────────────────────────

function buildSharedRoom(shared: SharedState): IRoom {
  const state: IRoomState = {
    getStateEvents: (type: string, stateKey: string) => {
      const typeMap = shared.state.get(type);
      if (!typeMap) return null;
      return typeMap.get(stateKey) || null;
    },
    events: shared.state,
  };

  const timeline: ITimeline = {
    getEvents: () => shared.timeline.slice(),
  };

  return {
    roomId: shared.roomId,
    name: 'Harness Room',
    currentState: state,
    getLiveTimeline: () => timeline,
    getJoinedMembers: () =>
      shared.peers.map<IRoomMember>((p) => ({
        userId: p.userId,
        name: p.userId,
        membership: 'join',
      })),
  };
}

// ─── Mock client factory ───────────────────────────────────────────────────

function transientError(): Error {
  const err: any = new Error('ECONNRESET: harness peer is offline');
  err.code = 'ECONNREFUSED';
  err.name = 'TypeError';
  err.httpStatus = 0;
  return err;
}

interface ClientCtx {
  shared: SharedState;
  userId: string;
  deviceId: string;
  /** Mutable flag set by goOffline/goOnline. */
  offline: { value: boolean };
}

function buildSharedClient(ctx: ClientCtx): HarnessClient {
  const sent: HarnessClient['_sent'] = [];
  const uploads: HarnessClient['_uploads'] = [];
  const toDevice: HarnessClient['_toDevice'] = [];
  const listeners = new Map<string, Array<(...args: any[]) => void>>();

  const room = buildSharedRoom(ctx.shared);

  const client: HarnessClient = {
    _sent: sent,
    _uploads: uploads,
    _toDevice: toDevice,
    _listeners: listeners,

    getUserId: () => ctx.userId,
    getDeviceId: () => ctx.deviceId,

    getRoom: (roomId: string) =>
      roomId === ctx.shared.roomId ? room : null,
    getRooms: () => [room],

    sendEvent: async (roomId: string, eventType: string, content: Record<string, any>) => {
      if (ctx.offline.value) throw transientError();
      sent.push({ roomId, type: eventType, content });
      const eventId = `$harness_${++ctx.shared.nextId.n}`;
      const ev = makeMatrixEvent({
        type: eventType,
        content,
        sender: ctx.userId,
        roomId,
        eventId,
      });
      ctx.shared.timeline.push(ev);
      // Deliver to every other peer's Room.timeline listener (asynchronously)
      queueMicrotask(() => {
        for (const other of ctx.shared.peers) {
          if (other.userId === ctx.userId && other.deviceId === ctx.deviceId) continue;
          const drop = ctx.shared.timelineDropCount.get(other.deviceId) ?? 0;
          if (drop > 0) {
            ctx.shared.timelineDropCount.set(other.deviceId, drop - 1);
            continue;
          }
          const ls = other.client._listeners.get('Room.timeline');
          if (!ls) continue;
          for (const fn of ls) fn(ev);
        }
      });
      return { event_id: eventId };
    },

    sendStateEvent: async (
      roomId: string,
      eventType: string,
      content: Record<string, any>,
      stateKey: string,
    ) => {
      if (ctx.offline.value) throw transientError();
      sent.push({ roomId, type: eventType, content, stateKey });
      let typeMap = ctx.shared.state.get(eventType);
      if (!typeMap) {
        typeMap = new Map();
        ctx.shared.state.set(eventType, typeMap);
      }
      const eventId = `$state_${++ctx.shared.nextId.n}`;
      typeMap.set(
        stateKey,
        makeMatrixEvent({
          type: eventType,
          content,
          sender: ctx.userId,
          roomId,
          eventId,
          stateKey,
        }),
      );
      return { event_id: eventId };
    },

    sendToDevice: async (
      eventType: string,
      contentMap: Map<string, Map<string, Record<string, any>>>,
    ) => {
      if (ctx.offline.value) throw transientError();
      toDevice.push({ type: eventType, contentMap });
      // Fan out to target peers' toDeviceEvent listeners.
      // Deliveries to the SAME target device are serialized via a per-device
      // promise chain — this prevents two peer-sync event batches from racing
      // inside processIncomingPeerEvents (which writes idem keys in a loop
      // without an outer mutex in production).
      for (const [targetUserId, deviceMap] of contentMap) {
        for (const [targetDeviceId, content] of deviceMap) {
          for (const other of ctx.shared.peers) {
            if (other.userId !== targetUserId) continue;
            if (targetDeviceId !== '*' && other.deviceId !== targetDeviceId) continue;
            if (other.userId === ctx.userId && other.deviceId === ctx.deviceId) continue;

            const drop = ctx.shared.toDeviceDropCount.get(other.deviceId) ?? 0;
            if (drop > 0) {
              ctx.shared.toDeviceDropCount.set(other.deviceId, drop - 1);
              continue;
            }

            const ev = makeMatrixEvent({
              type: eventType,
              content,
              sender: ctx.userId,
              roomId: ctx.shared.roomId,
              eventId: `$td_${++ctx.shared.nextId.n}`,
            });

            const key = other.deviceId;
            const prev = ctx.shared.toDeviceChains.get(key) ?? Promise.resolve();
            const next = prev.then(async () => {
              const ls = other.client._listeners.get('toDeviceEvent');
              if (!ls) return;
              for (const fn of ls) fn(ev);
              // peer-sync's handler is fire-and-forget (sync wrapper around
              // an async method). Spin a few microtask rounds so the async
              // chain — idem check → fold → idem write — has time to finish
              // before the next delivery begins.
              for (let i = 0; i < 12; i++) {
                await new Promise<void>((resolve) => setImmediate(resolve));
              }
            });
            ctx.shared.toDeviceChains.set(key, next);
          }
        }
      }
    },

    uploadContent: async (
      data: Uint8Array,
      opts: { name: string; type: string },
    ) => {
      if (ctx.offline.value) throw transientError();
      uploads.push({ data, name: opts.name });
      const n = ++ctx.shared.nextId.n;
      const mxc = `mxc://harness/${n}`;
      ctx.shared.media.set(mxc, new Uint8Array(data));
      return { content_uri: mxc };
    },

    mxcUrlToHttp: (mxcUrl: string) =>
      mxcUrl ? `http://harness.local/${mxcUrl}` : null,

    createRoom: async () => ({ room_id: ctx.shared.roomId }),
    invite: async () => {},
    kick: async () => {},
    setPowerLevel: async () => {},
    getRoomIdForAlias: async () => ({ room_id: ctx.shared.roomId }),

    paginateEventTimeline: async () => false,

    on: (event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      const list = listeners.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    removeListener: (event: string, handler: (...args: any[]) => void) => {
      const list = listeners.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
  };

  return client;
}

// ─── Peer snapshot helpers ─────────────────────────────────────────────────

export async function snapshotPeer(db: EoDb): Promise<PeerStateSnapshot> {
  const entries: Array<{ target: string; last_seq: number; hash?: string }> = [];
  const values = new Map<string, EoState>();

  for await (const [key, value] of (db as any).iterator({
    gte: 'state:',
    lte: 'state:\xff',
  })) {
    const s = decode(value as Buffer) as EoState;
    const target = (key as string).slice('state:'.length);
    entries.push({ target, last_seq: s.last_seq, hash: s.hash });
    values.set(target, s);
  }

  return {
    seq: await getCurrentSeq(db),
    fingerprint: storeFingerprint(entries),
    state: values,
  };
}

/** Deep-compare two PeerStateSnapshot.state maps by value (not hash or seq). */
export function stateValuesEqual(
  a: Map<string, EoState>,
  b: Map<string, EoState>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [target, sa] of a) {
    const sb = b.get(target);
    if (!sb) return false;
    if (JSON.stringify(sa.value) !== JSON.stringify(sb.value)) return false;
  }
  return true;
}

// ─── Peer factory ──────────────────────────────────────────────────────────

async function buildPeer(
  shared: SharedState,
  opts: HarnessPeerOpts,
): Promise<HarnessPeer> {
  const dbPath = mkdtempSync(join(tmpdir(), 'eo-sync-harness-'));
  const db = createDb(dbPath);
  await db.open();

  const offline = { value: false };
  const client = buildSharedClient({
    shared,
    userId: opts.userId,
    deviceId: opts.deviceId,
    offline,
  });

  const sync = new SyncManager(client, shared.roomId, db);
  const peerSync = new PeerSync(client, shared.roomId, db);

  // Production PeerSync now serializes to-device handler invocations on an
  // internal handlerChain — see src/matrix/peer-sync.ts. The harness just
  // awaits peerSync.drainHandlers() to quiesce in-flight work.

  const peer: HarnessPeer = {
    userId: opts.userId,
    deviceId: opts.deviceId,
    client,
    db,
    dbPath,
    sync,
    peerSync,

    goOffline: () => {
      offline.value = true;
    },
    goOnline: () => {
      offline.value = false;
    },

    write: async (event) => {
      return sync.processLocalEvent({
        op: event.op,
        target: event.target,
        operand: event.operand ?? {},
      });
    },

    currentSeq: () => getCurrentSeq(db),
    fingerprint: async () => (await snapshotPeer(db)).fingerprint,
    snapshotPeer: () => snapshotPeer(db),

    drainInFlight: async () => {
      await peerSync.drainHandlers();
    },

    destroy: async () => {
      try {
        peer.peerSync.stop();
      } catch {}
      try {
        await peerSync.drainHandlers();
      } catch {}
      try {
        peer.sync.destroy();
      } catch {}
      try {
        await db.close();
      } catch {}
      try {
        rmSync(dbPath, { recursive: true, force: true });
      } catch {}
    },
  };

  return peer;
}

// ─── Harness factory ───────────────────────────────────────────────────────

export async function createHarness(opts: {
  roomId?: string;
  peers: HarnessPeerOpts[];
}): Promise<Harness> {
  const roomId = opts.roomId ?? '!harness:example.com';
  const shared = newSharedState(roomId);
  installFetchStub(shared);

  const peers: HarnessPeer[] = [];

  for (const po of opts.peers) {
    const peer = await buildPeer(shared, po);
    peers.push(peer);
    shared.peers.push(peer);
  }

  // Initialize every peer's SyncManager + PeerSync after all peers are
  // registered so getJoinedMembers() reports the full room on every peer.
  for (const p of peers) {
    await p.sync.initialize();
  }
  for (const p of peers) {
    await p.peerSync.start();
  }
  await drain();

  const harness: Harness = {
    roomId,
    peers,

    addPeer: async (po: HarnessPeerOpts) => {
      const peer = await buildPeer(shared, po);
      peers.push(peer);
      shared.peers.push(peer);
      await peer.sync.initialize();
      await peer.peerSync.start();
      // Re-announce from existing peers so the new one gets fingerprints to compare against.
      for (const other of peers) {
        if (other === peer) continue;
        await other.peerSync.start();
      }
      await drain();
      return peer;
    },

    dropNextTimelineDeliveries: (toPeer, n) => {
      const prev = shared.timelineDropCount.get(toPeer.deviceId) ?? 0;
      shared.timelineDropCount.set(toPeer.deviceId, prev + n);
    },

    dropNextToDeviceDeliveries: (toPeer, n) => {
      const prev = shared.toDeviceDropCount.get(toPeer.deviceId) ?? 0;
      shared.toDeviceDropCount.set(toPeer.deviceId, prev + n);
    },

    flushAll: async () => {
      for (const p of peers) {
        try {
          await p.sync.flushSendBufferNow();
        } catch {}
      }
      await drain();
    },

    settle: async ({ rounds = 3 } = {}) => {
      for (let i = 0; i < rounds; i++) {
        for (const p of peers) {
          try {
            await p.sync.flushSendBufferNow();
          } catch {}
        }
        for (let j = 0; j < 4; j++) {
          await drain(2);
          const chains = Array.from(shared.toDeviceChains.values());
          if (chains.length > 0) await Promise.all(chains);
          for (const p of peers) await p.drainInFlight();
        }
        for (const p of peers) {
          try {
            await p.peerSync.start();
          } catch {}
        }
        for (let j = 0; j < 4; j++) {
          await drain(2);
          const chains = Array.from(shared.toDeviceChains.values());
          if (chains.length > 0) await Promise.all(chains);
          for (const p of peers) await p.drainInFlight();
        }
      }
    },

    waitForConvergence: async ({ iterations = 10 } = {}) => {
      const drainAll = async () => {
        // Await every in-flight to-device delivery chain and every in-flight
        // handler invocation so the previous peer-sync exchange fully
        // finishes before we start the next one.
        for (let i = 0; i < 4; i++) {
          await drain(2);
          const chains = Array.from(shared.toDeviceChains.values());
          if (chains.length > 0) await Promise.all(chains);
          for (const p of peers) await p.drainInFlight();
        }
      };

      for (let i = 0; i < iterations; i++) {
        // 1. Force-flush local buffers so any pending events land in the log
        //    and become visible to peer-sync readLogSince.
        for (const p of peers) {
          try {
            await p.sync.flushSendBufferNow();
          } catch {}
        }
        await drainAll();

        // 2. Re-announce hello from every peer so they learn each other's seq
        //    and fingerprint. Each announce fans out to offer → request →
        //    events via the to-device bus. The bus serializes deliveries per
        //    target device so two batches can't race inside the receiver.
        for (const p of peers) {
          try {
            await p.peerSync.start();
          } catch {}
        }
        await drainAll();

        // 3. Check convergence via store fingerprint.
        const fps = await Promise.all(peers.map((p) => p.fingerprint()));
        if (fps.every((fp) => fp === fps[0])) return;
      }
      const fps = await Promise.all(peers.map((p) => p.fingerprint()));
      const seqs = await Promise.all(peers.map((p) => p.currentSeq()));
      throw new Error(
        `peers did not converge after ${iterations} rounds — ` +
          `seqs=[${seqs.join(', ')}] fingerprints=[${fps.map((fp) => fp.slice(0, 12)).join(', ')}]`,
      );
    },

    destroy: async () => {
      // Drain everything that might still be in flight before closing dbs.
      for (let i = 0; i < 6; i++) {
        await drain(2);
        const chains = Array.from(shared.toDeviceChains.values());
        if (chains.length > 0) await Promise.all(chains);
        for (const p of peers) await p.drainInFlight();
      }
      for (const p of peers) {
        await p.destroy();
      }
      shared.peers = [];
      shared.toDeviceChains.clear();
      uninstallFetchStub();
    },
  };

  return harness;
}

// Re-export so tests can mute unused-import warnings in strict TS mode.
export { vi };
