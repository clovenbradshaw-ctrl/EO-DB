/**
 * Phase 5 — integration tests for the end-to-end wiring.
 *
 * These tests drive the worker core through the client façade and a
 * set of mock transports (no Matrix or WebRTC) to exercise the full
 * command round-trip. Coverage targets:
 *
 *   - Two-protocol exclusion: only one of {legacy, operator} sync may
 *     be claimed per room at a time.
 *   - Hash divergence (⊨EVA rejects bad bytes → ↬REC blacklists the
 *     peer → ⊢DEF later materializes from a good peer's delivery).
 *   - Bridge verifies bulk frames (good hash produces a regular pass-
 *     through; bad bytes are re-emitted with the invalid sentinel).
 *   - Feature-flag helper respects env + localStorage.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimRoomProtocol,
  releaseRoomProtocol,
  getActiveProtocol,
  isOperatorSyncEnabled,
  TwoProtocolConflictError,
  _resetProtocolGuardForTests,
} from '../network-sync-system';
import {
  NetworkSyncWorkerCore,
  dropDuplicateEmits,
} from '../network-sync-worker-core';
import {
  createNetworkSyncClient,
  createInProcessWorkerLike,
} from '../network-sync-client';
import {
  createNetworkSyncBridge,
  encodeBulkBody,
  INVALID_HASH_SENTINEL,
  type BridgeMatrixTransport,
  type BridgeRtcTransport,
  type BridgeStore,
} from '../network-sync-bridge';
import type {
  BulkMessage,
  ControlMessage,
  WorkerCommand,
  PeerId,
} from '../network-sync-protocol';
import type { EoEvent } from '../../db/types';
import { swarmSite, peerSite, pieceSite } from '../sites';

// ─── Two-protocol guard ────────────────────────────────────────────────

describe('two-protocol guard', () => {
  beforeEach(() => _resetProtocolGuardForTests());

  it('claims are idempotent for the same protocol', () => {
    claimRoomProtocol('!r1', 'operator');
    claimRoomProtocol('!r1', 'operator');
    expect(getActiveProtocol('!r1')).toBe('operator');
  });

  it('claiming the other protocol on the same room throws', () => {
    claimRoomProtocol('!r1', 'legacy');
    expect(() => claimRoomProtocol('!r1', 'operator')).toThrow(TwoProtocolConflictError);
  });

  it('release unlocks the room', () => {
    claimRoomProtocol('!r1', 'operator');
    releaseRoomProtocol('!r1', 'operator');
    expect(getActiveProtocol('!r1')).toBeNull();
    claimRoomProtocol('!r1', 'legacy');
    expect(getActiveProtocol('!r1')).toBe('legacy');
  });

  it('release ignores mismatched owners', () => {
    claimRoomProtocol('!r1', 'operator');
    releaseRoomProtocol('!r1', 'legacy');
    expect(getActiveProtocol('!r1')).toBe('operator');
  });
});

describe('isOperatorSyncEnabled', () => {
  const mockStorage = (() => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
      clear: () => map.clear(),
      get length() { return map.size; },
      key: () => null,
    } as Storage;
  })();

  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage = mockStorage;
    mockStorage.clear();
  });

  it('enabled when env flag is "2"', () => {
    expect(isOperatorSyncEnabled('2')).toBe(true);
  });

  it('enabled when localStorage override is "operator"', () => {
    mockStorage.setItem('eo.sync.mode', 'operator');
    expect(isOperatorSyncEnabled(undefined)).toBe(true);
  });

  it('disabled when neither is set', () => {
    expect(isOperatorSyncEnabled(undefined)).toBe(false);
  });
});

// ─── End-to-end: hash divergence ───────────────────────────────────────

interface MockHarness {
  core: NetworkSyncWorkerCore;
  client: ReturnType<typeof createNetworkSyncClient>;
  matrix: BridgeMatrixTransport;
  rtc: BridgeRtcTransport;
  store: BridgeStore;
  sentControl: Array<{ peer: PeerId; msg: ControlMessage }>;
  sentBulk: Array<{ peer: PeerId; msg: BulkMessage }>;
  emitted: EoEvent[];
  stop: () => void;
}

function makeHarness(now: () => number): MockHarness {
  const core = new NetworkSyncWorkerCore();
  const workerLike = createInProcessWorkerLike((msg) => dropDuplicateEmits(core.handle(msg)));
  const client = createNetworkSyncClient(workerLike, { now });

  const sentControl: MockHarness['sentControl'] = [];
  const sentBulk: MockHarness['sentBulk'] = [];
  const emitted: EoEvent[] = [];

  const matrix: BridgeMatrixTransport = {
    async sendControlToPeer(peer, msg) {
      sentControl.push({ peer, msg });
    },
    async sendBulkToPeer(peer, msg) {
      sentBulk.push({ peer, msg });
    },
    async emitEoEvent(event) {
      emitted.push(event);
      // Simulate the round-trip: the emitted event is folded locally.
      client.reportFoldedEvent(event, now());
    },
  };
  const rtc: BridgeRtcTransport = {
    isOpen: () => false,
    open: async () => { /* noop */ },
    close: async () => { /* noop */ },
    sendBulk: async () => { /* noop */ },
  };
  const store: BridgeStore = {
    async readPieceEvents() {
      return null;
    },
  };
  createNetworkSyncBridge({ client, matrix, rtc, store, now });
  return { core, client, matrix, rtc, store, sentControl, sentBulk, emitted, stop: () => workerLike.terminate() };
}

describe('hash divergence — EVA fails → REC blacklists → DEF materializes', () => {
  it('routes bad bytes through REC and prefers the good peer afterward', async () => {
    let t = 1_000_000;
    const now = () => t;
    const h = makeHarness(now);

    const room = '!r:srv';
    const AD = 'AD1';
    const good = peerSite('@a:srv', 'good');
    const bad = peerSite('@b:srv', 'bad');
    const piece = pieceSite(AD, 0);

    // Feed seed events through the client so the bridge-driven round-
    // trip (emit_eo_event → mock matrix → reportFoldedEvent) is active
    // for every resulting worker emit.
    const client = h.client;
    const seed: EoEvent[] = [
      ev('INS', `swarm:${room}`, { joined_at: 'x' }),
      ev('CON', `swarm:${room}`, { joined: good, coupling: 'active' }),
      ev('CON', `swarm:${room}`, { joined: bad, coupling: 'active' }),
      ev('SIG', `swarm:${room}`, { author_device_id: AD, piece_index: 0, expected_hash: 'H', advertised_by: good }),
      ev('SIG', `swarm:${room}`, { author_device_id: AD, piece_index: 0, expected_hash: 'H', advertised_by: bad }),
    ];
    await client.start({
      roomId: room,
      myDeviceId: 'ME',
      myUserId: '@me:srv',
      seedEvents: seed,
      nowMs: t,
      seed: 1,
    });

    // Bad peer delivers INVALID bytes → worker emits EVA+REC which the
    // bridge round-trips through the mock matrix back into the worker.
    t += 100;
    client.reportInboundBulk({
      kind: 'piece_bytes',
      req_id: 'q-bad',
      piece_site: piece,
      content_hash: INVALID_HASH_SENTINEL,
      events_msgpack: new Uint8Array(0),
    }, bad, t);

    // Assert REC(peer:bad) blacklisted eligibility_for[piece].
    const snap = h.core.snapshot();
    const badPeer = snap.projection.peers.get(bad);
    expect(badPeer).toBeTruthy();
    const elig = badPeer!.eligibility.get(`eligibility_for[${piece}]`);
    expect(elig?.toString().startsWith('blacklisted_until_')).toBe(true);

    // Good peer delivers correct bytes → DEF(piece) materializes via
    // single_verified_delivery (only one peer's verified, no conflict).
    t += 100;
    client.reportInboundBulk({
      kind: 'piece_bytes',
      req_id: 'q-good',
      piece_site: piece,
      content_hash: 'H',
      events_msgpack: new Uint8Array(0),
    }, good, t);

    const post = h.core.snapshot();
    const piecep = post.projection.pieces.get(piece);
    expect(piecep).toBeTruthy();
    expect(piecep!.definedHash).toBe('H');
    expect(piecep!.definedFrom).toBe('single_verified_delivery');

    // And the bridge should have sent the request_piece_bytes control
    // query during scheduling (at minimum, to one of the peers).
    expect(h.sentControl.length).toBeGreaterThanOrEqual(1);

    h.stop();
  });
});

// ─── Bridge: bulk verification ─────────────────────────────────────────

describe('bridge — bulk verification (⊨EVA runs in the bridge)', () => {
  it('good bytes pass through unchanged to the client', async () => {
    let t = 1_000_000;
    const now = () => t;

    const events = [{ op: 'INS', target: 't', operand: { v: 1 } }];
    const encoded = await encodeBulkBody(events);

    const core = new NetworkSyncWorkerCore();
    const workerLike = createInProcessWorkerLike((msg) => dropDuplicateEmits(core.handle(msg)));
    const client = createNetworkSyncClient(workerLike, { now });
    let reportedGood = false;
    client.onCommand(() => { /* noop */ });
    const origReport = client.reportInboundBulk;
    // Spy on inbound bulk by wrapping.
    client.reportInboundBulk = ((msg, fromPeer, nowMs) => {
      if (msg.kind === 'piece_bytes' && msg.content_hash === encoded.content_hash) reportedGood = true;
      return origReport.call(client, msg, fromPeer, nowMs);
    }) as typeof client.reportInboundBulk;

    const matrix: BridgeMatrixTransport = {
      sendControlToPeer: async () => { /* noop */ },
      sendBulkToPeer: async () => { /* noop */ },
      emitEoEvent: async () => { /* noop */ },
    };
    const rtc: BridgeRtcTransport = { isOpen: () => false, open: async () => { /* noop */ }, close: async () => { /* noop */ }, sendBulk: async () => { /* noop */ } };
    const store: BridgeStore = { readPieceEvents: async () => null };
    const bridge = createNetworkSyncBridge({ client, matrix, rtc, store, now });

    await bridge.handleInboundBulk({
      kind: 'piece_bytes',
      req_id: 'r1',
      piece_site: pieceSite('AD1', 0),
      content_hash: encoded.content_hash,
      events_msgpack: encoded.bytes,
    }, peerSite('@x:srv', 'd'));

    expect(reportedGood).toBe(true);
    workerLike.terminate();
  });

  it('bad bytes produce INVALID_HASH_SENTINEL frame to the worker', async () => {
    let t = 1_000_000;
    const now = () => t;

    const core = new NetworkSyncWorkerCore();
    const workerLike = createInProcessWorkerLike((msg) => dropDuplicateEmits(core.handle(msg)));
    const client = createNetworkSyncClient(workerLike, { now });
    let sentinelSeen = false;
    const origReport = client.reportInboundBulk;
    client.reportInboundBulk = ((msg, fromPeer, nowMs) => {
      if (msg.kind === 'piece_bytes' && msg.content_hash === INVALID_HASH_SENTINEL) sentinelSeen = true;
      return origReport.call(client, msg, fromPeer, nowMs);
    }) as typeof client.reportInboundBulk;

    const matrix: BridgeMatrixTransport = {
      sendControlToPeer: async () => { /* noop */ },
      sendBulkToPeer: async () => { /* noop */ },
      emitEoEvent: async () => { /* noop */ },
    };
    const rtc: BridgeRtcTransport = { isOpen: () => false, open: async () => { /* noop */ }, close: async () => { /* noop */ }, sendBulk: async () => { /* noop */ } };
    const store: BridgeStore = { readPieceEvents: async () => null };
    const bridge = createNetworkSyncBridge({ client, matrix, rtc, store, now });

    // Encode a truthful blob, then lie about the hash.
    const encoded = await encodeBulkBody([{ op: 'INS', target: 't', operand: { v: 1 } }]);
    await bridge.handleInboundBulk({
      kind: 'piece_bytes',
      req_id: 'r1',
      piece_site: pieceSite('AD1', 0),
      content_hash: 'NOTTHEHASH',
      events_msgpack: encoded.bytes,
    }, peerSite('@x:srv', 'd'));

    expect(sentinelSeen).toBe(true);
    workerLike.terminate();
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────

let nextSeq = 1;
function ev(op: string, target: string, operand: Record<string, unknown>, meta?: Record<string, unknown>): EoEvent {
  return {
    seq: nextSeq++,
    op: op as EoEvent['op'],
    target,
    operand,
    agent: '@sys:srv|SYS',
    ts: '2026-01-01T00:00:00.000Z',
    acquired_ts: '2026-01-01T00:00:00.000Z',
    meta,
  } as EoEvent;
}
beforeEach(() => { nextSeq = 1; });

// Touch swarmSite so the import isn't dropped by tree-shaking; the event
// helper above takes target strings directly.
void swarmSite;
