/**
 * Sync Convergence — two-peer integration scenarios.
 *
 * Goal: confirm that two (or three) EO-DB peers running the full replication
 * pipeline (SyncManager + SendBuffer + snapshot + PeerSync) actually stay in
 * sync under realistic conditions. Uses the harness at
 * tests/helpers/sync-harness.ts, which wires real SyncManager instances to a
 * shared in-memory homeserver (shared timeline, state, media blobs,
 * to-device bus).
 *
 * Convergence assertion: every peer's store fingerprint
 * (src/db/hash.ts:storeFingerprint) matches. This is the same function
 * PeerSync.computeFingerprint() uses, so if the test fingerprint matches
 * peer-sync also considers the peers converged. `currentSeq` equality is
 * checked too — a peer that re-folded an event would show a higher seq.
 *
 * Scenarios using disjoint target namespaces per peer are expected to reach
 * strict fingerprint equality. The "concurrent same-target DEF" scenario
 * tests value-level equality only, because the projected state hash chain
 * (chainHash) is order-dependent and two peers applying the same events in
 * different orders end up with different state.hash values even when their
 * .value fields merge commutatively.
 */

import {
  describe,
  it,
  expect,
  afterEach,
  beforeAll,
} from 'vitest';

import {
  createHarness,
  snapshotPeer,
  stateValuesEqual,
  type Harness,
} from './helpers/sync-harness.js';

import { getState } from '../src/db/state.js';
import { readLogSince } from '../src/db/log.js';
import { SNAPSHOT_FREQUENCY } from '../src/matrix/snapshot.js';
import { EO_SNAPSHOT_STATE_TYPE } from '../src/matrix/event-bridge.js';

// ─── Test scaffolding ──────────────────────────────────────────────────────

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.destroy();
    harness = null;
  }
});

beforeAll(() => {
  // Silence the sync-manager's info/warn logging during tests.
  // (The harness triggers a lot of "replayed 0 events" etc.)
  const noop = () => {};
  (console as any).info = noop;
});

async function twoPeer(): Promise<Harness> {
  return createHarness({
    peers: [
      { userId: '@alice:example.com', deviceId: 'DEVICE_A' },
      { userId: '@bob:example.com', deviceId: 'DEVICE_B' },
    ],
  });
}

async function threePeer(): Promise<Harness> {
  return createHarness({
    peers: [
      { userId: '@alice:example.com', deviceId: 'DEVICE_A' },
      { userId: '@bob:example.com', deviceId: 'DEVICE_B' },
      { userId: '@carol:example.com', deviceId: 'DEVICE_C' },
    ],
  });
}

// A deterministic seeded PRNG so the property-style test is reproducible.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Sync Convergence — two-peer integration', () => {
  // ─────────────────────────────────────────────────────────────────────────
  describe('Cold start convergence', () => {
    it('A writes N, B writes M to disjoint targets; fingerprints match', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      for (let i = 0; i < 5; i++) {
        await a.write({ op: 'INS', target: `alice.rec${i}`, operand: { v: i } });
      }
      for (let i = 0; i < 4; i++) {
        await b.write({ op: 'INS', target: `bob.rec${i}`, operand: { v: i * 10 } });
      }

      await harness.waitForConvergence();

      const snapA = await a.snapshotPeer();
      const snapB = await b.snapshotPeer();
      expect(snapA.fingerprint).toBe(snapB.fingerprint);
    });

    it('projected state for every target is identical after convergence', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      await a.write({ op: 'INS', target: 'shared.a', operand: { name: 'Alice' } });
      await b.write({ op: 'INS', target: 'shared.b', operand: { name: 'Bob' } });
      await a.write({ op: 'DEF', target: 'shared.a', operand: { role: 'admin' } });
      await b.write({ op: 'DEF', target: 'shared.b', operand: { role: 'editor' } });

      await harness.waitForConvergence();

      const sa = await a.snapshotPeer();
      const sb = await b.snapshotPeer();
      expect(stateValuesEqual(sa.state, sb.state)).toBe(true);
    });

    it('currentSeq matches on both peers (no double-folding of received events)', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      for (let i = 0; i < 3; i++) {
        await a.write({ op: 'INS', target: `a.t${i}`, operand: { v: i } });
        await b.write({ op: 'INS', target: `b.t${i}`, operand: { v: i } });
      }

      await harness.waitForConvergence();

      expect(await a.currentSeq()).toBe(6);
      expect(await b.currentSeq()).toBe(6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Offline write + reconnect', () => {
    it('A writes while offline; after goOnline, B observes all A writes', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      a.goOffline();
      await a.write({ op: 'INS', target: 'offline.a1', operand: { v: 1 } });
      await a.write({ op: 'INS', target: 'offline.a2', operand: { v: 2 } });
      await a.write({ op: 'INS', target: 'offline.a3', operand: { v: 3 } });

      // While offline, B should still be able to drive convergence after
      // A reconnects — verify nothing leaked to B yet.
      const preBState = await getState(b.db, 'offline.a1');
      expect(preBState).toBeNull();

      a.goOnline();
      await harness.waitForConvergence();

      expect((await getState(b.db, 'offline.a1'))?.value).toEqual({ v: 1 });
      expect((await getState(b.db, 'offline.a2'))?.value).toEqual({ v: 2 });
      expect((await getState(b.db, 'offline.a3'))?.value).toEqual({ v: 3 });

      const snapA = await a.snapshotPeer();
      const snapB = await b.snapshotPeer();
      expect(snapA.fingerprint).toBe(snapB.fingerprint);
    });

    it('SendBuffer-style transient failure is survivable end-to-end', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      // Fold locally, then go offline before flushing.
      await a.write({ op: 'INS', target: 'resilient.x', operand: { v: 1 } });
      a.goOffline();
      try {
        await a.sync.flushSendBufferNow();
      } catch {}

      // More writes while offline.
      await a.write({ op: 'DEF', target: 'resilient.x', operand: { extra: true } });

      // Recover.
      a.goOnline();
      await harness.waitForConvergence();

      const snapA = await a.snapshotPeer();
      const snapB = await b.snapshotPeer();
      expect(snapA.fingerprint).toBe(snapB.fingerprint);
      expect((await getState(b.db, 'resilient.x'))?.value).toEqual({ v: 1, extra: true });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Concurrent writes', () => {
    it('concurrent INS into disjoint targets converges to identical state', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      await Promise.all([
        a.write({ op: 'INS', target: 'concur.a', operand: { owner: 'alice' } }),
        b.write({ op: 'INS', target: 'concur.b', operand: { owner: 'bob' } }),
      ]);

      await harness.waitForConvergence();

      const sa = await a.snapshotPeer();
      const sb = await b.snapshotPeer();
      expect(sa.fingerprint).toBe(sb.fingerprint);
      expect(sa.state.get('concur.a')?.value).toEqual({ owner: 'alice' });
      expect(sa.state.get('concur.b')?.value).toEqual({ owner: 'bob' });
    });

    it('concurrent DEF on same target with disjoint keys — values merge commutatively', async () => {
      // Documented limitation: state.hash is order-dependent, so strict
      // fingerprint equality is NOT expected when two peers apply the same
      // events in different orders. But the projected .value MUST converge
      // because mergeOperand is commutative for disjoint keys. Use settle()
      // to drive peer-sync without asserting fingerprint equality.
      harness = await twoPeer();
      const [a, b] = harness.peers;

      // Seed the target so both peers are writing DEFs, not first-time INS.
      await a.write({ op: 'INS', target: 'merge.target', operand: {} });
      await harness.waitForConvergence();

      await Promise.all([
        a.write({ op: 'DEF', target: 'merge.target', operand: { name: 'Alice' } }),
        b.write({ op: 'DEF', target: 'merge.target', operand: { email: 'bob@x' } }),
      ]);

      await harness.settle({ rounds: 4 });

      const sa = await a.snapshotPeer();
      const sb = await b.snapshotPeer();
      const vA = sa.state.get('merge.target')?.value ?? {};
      const vB = sb.state.get('merge.target')?.value ?? {};

      // Order-independent value comparison
      expect(vA.name).toBe('Alice');
      expect(vA.email).toBe('bob@x');
      expect(vB.name).toBe('Alice');
      expect(vB.email).toBe('bob@x');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('New peer bootstrap from snapshot', () => {
    it('C joins after A has written events, hydrates via restoreFromDeltaChain', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      for (let i = 0; i < 8; i++) {
        await a.write({ op: 'INS', target: `boot.a${i}`, operand: { v: i } });
      }
      await a.sync.saveSnapshot();
      await harness.waitForConvergence();

      // Add Carol mid-run.
      const c = await harness.addPeer({
        userId: '@carol:example.com',
        deviceId: 'DEVICE_C',
      });

      await harness.waitForConvergence();

      const snapA = await a.snapshotPeer();
      const snapB = await b.snapshotPeer();
      const snapC = await snapshotPeer(c.db);

      expect(snapC.fingerprint).toBe(snapA.fingerprint);
      expect(snapC.fingerprint).toBe(snapB.fingerprint);
      expect(snapC.state.size).toBe(8);
    });

    it('a fresh peer hydrates via snapshot state event + media store', async () => {
      harness = await twoPeer();
      const [a] = harness.peers;

      for (let i = 0; i < 4; i++) {
        await a.write({ op: 'INS', target: `hydrate.t${i}`, operand: { v: i } });
      }
      await a.sync.saveSnapshot();

      // Room state must carry the snapshot pointer so the new peer can discover it.
      // (The harness's sendStateEvent writes into the shared state map.)
      const snapA = await a.snapshotPeer();

      const c = await harness.addPeer({
        userId: '@carol:example.com',
        deviceId: 'DEVICE_C',
      });

      await harness.waitForConvergence();
      const snapC = await snapshotPeer(c.db);
      expect(snapC.fingerprint).toBe(snapA.fingerprint);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Long partition + rejoin via peer-sync', () => {
    it('partitioned writes produce divergent fingerprints at equal seq', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      // Partition: A and B both offline so they cannot exchange via to-device.
      a.goOffline();
      b.goOffline();

      await a.write({ op: 'INS', target: 'part.a1', operand: { v: 'a' } });
      await b.write({ op: 'INS', target: 'part.b1', operand: { v: 'b' } });

      const seqA = await a.currentSeq();
      const seqB = await b.currentSeq();
      const fpA = await a.fingerprint();
      const fpB = await b.fingerprint();

      expect(seqA).toBe(1);
      expect(seqB).toBe(1);
      expect(fpA).not.toBe(fpB);
    });

    it('hello/offer/request/events exchange closes the gap both ways', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      a.goOffline();
      b.goOffline();

      for (let i = 0; i < 3; i++) {
        await a.write({ op: 'INS', target: `part2.a${i}`, operand: { v: i } });
      }
      for (let i = 0; i < 3; i++) {
        await b.write({ op: 'INS', target: `part2.b${i}`, operand: { v: i } });
      }

      a.goOnline();
      b.goOnline();
      await harness.waitForConvergence();

      const snapA = await a.snapshotPeer();
      const snapB = await b.snapshotPeer();
      expect(snapA.fingerprint).toBe(snapB.fingerprint);
      expect(snapA.state.size).toBe(6);
      expect(snapB.state.size).toBe(6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Dropped timeline deliveries', () => {
    it('dropping every timeline delivery still converges via peer-sync gap fill', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      // Drop everything on the timeline — the only way B learns of A's
      // writes is via peer-sync's to-device exchange.
      harness.dropNextTimelineDeliveries(b, 1000);

      for (let i = 0; i < 5; i++) {
        await a.write({ op: 'INS', target: `drop.rec${i}`, operand: { v: i } });
      }

      await harness.waitForConvergence();

      const snapA = await a.snapshotPeer();
      const snapB = await b.snapshotPeer();
      expect(snapA.fingerprint).toBe(snapB.fingerprint);
      expect(snapB.state.size).toBeGreaterThanOrEqual(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Snapshot claim lease mutual exclusion', () => {
    it('concurrent saveSnapshot from A and B produces a single room state pointer', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      await a.write({ op: 'INS', target: 'claim.seed', operand: { v: 1 } });
      await b.write({ op: 'INS', target: 'claim.other', operand: { v: 2 } });
      await harness.waitForConvergence();

      await Promise.all([
        a.sync.saveSnapshot().catch(() => {}),
        b.sync.saveSnapshot().catch(() => {}),
      ]);

      // The shared room state must end up with exactly one snapshot-state
      // pointer (the winning peer's). We read via peer A's client which
      // reflects the shared state map.
      const room = a.client.getRoom(harness.roomId)!;
      const stateEvent = room.currentState.getStateEvents(
        EO_SNAPSHOT_STATE_TYPE,
        '',
      );
      expect(stateEvent).not.toBeNull();
      const content = stateEvent!.getContent();
      expect(typeof content.mxc).toBe('string');
      expect(content.mxc).toMatch(/^mxc:\/\/harness\//);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Cross-path dedup', () => {
    it('same event delivered via timeline and via peer-sync gets one seq', async () => {
      harness = await twoPeer();
      const [a, b] = harness.peers;

      await a.write({ op: 'INS', target: 'dedup.once', operand: { v: 1 } });
      await harness.waitForConvergence();

      const seqB = await b.currentSeq();
      const logB = await readLogSince(b.db, 0);
      const matchingB = logB.filter((e) => e.target === 'dedup.once');

      expect(seqB).toBe(1);
      expect(matchingB).toHaveLength(1);

      // Re-trigger peer-sync — the same event should not be folded a second
      // time thanks to client_event_id idem cache.
      await a.peerSync.start();
      await b.peerSync.start();
      await harness.waitForConvergence();

      const seqBAfter = await b.currentSeq();
      expect(seqBAfter).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('Fingerprint convergence invariant (property-style)', () => {
    for (const seed of [1, 7, 42, 101, 256, 777, 1024, 2048]) {
      it(`random interleaving seed=${seed} converges`, async () => {
        harness = await twoPeer();
        const [a, b] = harness.peers;
        const rand = mulberry32(seed);

        const TOTAL = 12;
        for (let i = 0; i < TOTAL; i++) {
          const peer = rand() < 0.5 ? a : b;
          const ns = peer === a ? 'alice' : 'bob';
          const op: 'INS' | 'DEF' = rand() < 0.6 ? 'INS' : 'DEF';
          const target = `${ns}.rec${i}`;
          if (op === 'INS') {
            await peer.write({
              op,
              target,
              operand: { v: Math.floor(rand() * 1000) },
            });
          } else {
            // DEF needs the target to already exist; write an INS first.
            await peer.write({ op: 'INS', target, operand: {} });
            await peer.write({
              op: 'DEF',
              target,
              operand: { tag: `t${Math.floor(rand() * 100)}` },
            });
          }
        }

        await harness.waitForConvergence();
        const snapA = await a.snapshotPeer();
        const snapB = await b.snapshotPeer();
        expect(snapA.fingerprint).toBe(snapB.fingerprint);
        expect(snapA.seq).toBe(snapB.seq);
      });
    }
  });
});

// Suppress TS unused-import warning if threePeer is unused in a given build.
void threePeer;
