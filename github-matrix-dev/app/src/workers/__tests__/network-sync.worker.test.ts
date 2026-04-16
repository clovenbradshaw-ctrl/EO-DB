/**
 * Phase 4 — network-sync worker tests.
 *
 * Each test drives the `NetworkSyncWorkerCore` directly (the Web Worker
 * wrapper is a thin `postMessage` adapter — it has no logic worth
 * mocking). A separate test covers the in-process client facade to
 * confirm the `WorkerLike` contract round-trips commands correctly.
 *
 * Operator invariants being verified:
 *   - ⊢DEF(piece) emitted when the projection reaches a stable
 *     resolution path (author SEG).
 *   - ⊨EVA(peer) emitted after bulk verification, result mirroring
 *     hash match.
 *   - ↬REC(peer) rewrites eligibility when verification fails — this
 *     is not a retry; it restructures the peer's category for that
 *     piece.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { EoEvent } from '../../db/types';
import { NetworkSyncWorkerCore, dropDuplicateEmits } from '../../sync/network-sync-worker-core';
import type {
  WorkerCommand,
  WorkerInbound,
  ControlMessage,
  BulkMessage,
  PeerId,
} from '../../sync/network-sync-protocol';
import {
  createNetworkSyncClient,
  createInProcessWorkerLike,
} from '../../sync/network-sync-client';
import { swarmSite, peerSite, pieceSite, logSite } from '../../sync/sites';

// ─── Helpers ────────────────────────────────────────────────────────────

const ROOM = '!r:srv';
const ME_USER = '@me:srv';
const ME_DEVICE = 'ME';

let nextSeq = 1;
function ev(partial: Partial<EoEvent> & Pick<EoEvent, 'op' | 'target' | 'operand'>): EoEvent {
  return {
    seq: nextSeq++,
    agent: '@a:srv|AD1',
    ts: '2026-01-01T00:00:00.000Z',
    acquired_ts: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as EoEvent;
}
function resetSeq() {
  nextSeq = 1;
}

function defaultStart(): WorkerInbound {
  return {
    kind: 'start',
    init: {
      roomId: ROOM,
      myDeviceId: ME_DEVICE,
      myUserId: ME_USER,
      seedEvents: [],
      nowMs: 1_000_000,
      seed: 42,
    },
  };
}

function emits(cmds: WorkerCommand[]): EoEvent[] {
  return cmds.filter((c) => c.kind === 'emit_eo_event').map((c) => (c as { event: EoEvent }).event);
}

function controls(cmds: WorkerCommand[]): Array<{ peer: PeerId; msg: ControlMessage }> {
  return cmds
    .filter((c) => c.kind === 'send_control')
    .map((c) => ({ peer: (c as { peer: PeerId }).peer, msg: (c as { msg: ControlMessage }).msg }));
}

function bulks(cmds: WorkerCommand[]): Array<{ peer: PeerId; msg: BulkMessage }> {
  return cmds
    .filter((c) => c.kind === 'send_bulk')
    .map((c) => ({ peer: (c as { peer: PeerId }).peer, msg: (c as { msg: BulkMessage }).msg }));
}

// ─── Core — lifecycle + round-trip ──────────────────────────────────────

describe('network-sync worker — lifecycle', () => {
  beforeEach(() => resetSeq());

  it('start emits no commands on an empty projection', () => {
    const core = new NetworkSyncWorkerCore();
    const out = core.handle(defaultStart());
    expect(out).toEqual([]);
  });

  it('stop after start closes any open DCs', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    core.handle({ kind: 'peer_join', peer: peerSite('@a:srv', 'da'), nowMs: 1_000_100 });
    // bring DC state to open
    core.handle({ kind: 'dc_state', peer: peerSite('@a:srv', 'da'), state: 'open', nowMs: 1_000_200 });
    const out = core.handle({ kind: 'stop' });
    expect(out.some((c) => c.kind === 'close_dc')).toBe(true);
  });

  it('round-trip: folded SIG produces a request_piece_bytes control command', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    // A peer is known in the swarm, actively joined.
    const peer = peerSite('@a:srv', 'da');
    core.handle({
      kind: 'folded_event',
      event: ev({
        op: 'CON',
        target: swarmSite(ROOM),
        operand: { joined: peer, coupling: 'active' },
      }),
      nowMs: 1_000_100,
    });
    // A piece is advertised by that peer.
    const piece = pieceSite('AD1', 0);
    const out = core.handle({
      kind: 'folded_event',
      event: ev({
        op: 'SIG',
        target: swarmSite(ROOM),
        operand: { author_device_id: 'AD1', piece_index: 0, expected_hash: 'H', advertised_by: peer },
      }),
      nowMs: 1_000_200,
    });
    const ctrls = controls(out);
    expect(ctrls).toHaveLength(1);
    expect(ctrls[0].peer).toBe(peer);
    expect(ctrls[0].msg.kind).toBe('request_piece_bytes');
    const m = ctrls[0].msg as Extract<ControlMessage, { kind: 'request_piece_bytes' }>;
    expect(m.piece_site).toBe(piece);
    expect(m.expected_hash).toBe('H');
  });
});

// ─── Core — ⊢DEF emission ───────────────────────────────────────────────

describe('network-sync worker — DEF emission', () => {
  beforeEach(() => resetSeq());

  it('author SEG produces a DEF(author_seg) emit_eo_event', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const piece = pieceSite('AD1', 0);
    const out = core.handle({
      kind: 'folded_event',
      event: ev({
        op: 'SEG',
        target: logSite('AD1'),
        operand: {
          segment_id: piece,
          bounds: { from_seq: 1, to_seq: 2 },
          closes_at: 'e',
          content_hash: 'H',
        },
        meta: { origin_device_id: 'AD1' },
      }),
      nowMs: 1_000_100,
    });
    const defs = emits(out).filter((e) => e.op === 'DEF');
    expect(defs).toHaveLength(1);
    expect(defs[0].target).toBe(piece);
    expect((defs[0].operand as { resolved_from?: string }).resolved_from).toBe('author_seg');
  });

  it('derived DEF is not re-emitted on subsequent ticks', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const piece = pieceSite('AD1', 0);
    core.handle({
      kind: 'folded_event',
      event: ev({
        op: 'SEG',
        target: logSite('AD1'),
        operand: { segment_id: piece, bounds: { from_seq: 1, to_seq: 2 }, closes_at: 'e', content_hash: 'H' },
        meta: { origin_device_id: 'AD1' },
      }),
      nowMs: 1_000_100,
    });
    const second = core.handle({ kind: 'tick', nowMs: 1_000_200 });
    const defs = emits(second).filter((e) => e.op === 'DEF');
    expect(defs).toHaveLength(0);
  });

  it('three independent verifying deliveries produce a piece SYN', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const piece = pieceSite('AD1', 0);
    const peers = ['d1', 'd2', 'd3'].map((d) => peerSite(`@u:srv`, d));
    const allCommands: WorkerCommand[] = [];
    for (const peer of peers) {
      const out = core.handle({
        kind: 'folded_event',
        event: ev({
          op: 'CON',
          target: peer,
          operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'H' },
        }),
        nowMs: 1_000_100,
      });
      allCommands.push(...out);
    }
    const syns = emits(allCommands).filter((e) => e.op === 'SYN' && e.target === piece);
    expect(syns.length).toBeGreaterThanOrEqual(1);
    expect((syns[0].operand as { unanimous_hash?: string }).unanimous_hash).toBe('H');
  });
});

// ─── Core — ⊨EVA / ↬REC on bulk verification ────────────────────────────

describe('network-sync worker — bulk verification path (EVA → REC)', () => {
  beforeEach(() => resetSeq());

  function pieceAdvertised(core: NetworkSyncWorkerCore, peer: PeerId, piece: string, hash: string) {
    core.handle({
      kind: 'folded_event',
      event: ev({
        op: 'CON',
        target: swarmSite(ROOM),
        operand: { joined: peer, coupling: 'active' },
      }),
      nowMs: 1_000_100,
    });
    core.handle({
      kind: 'folded_event',
      event: ev({
        op: 'SIG',
        target: swarmSite(ROOM),
        operand: {
          author_device_id: 'AD1',
          piece_index: 0,
          expected_hash: hash,
          advertised_by: peer,
        },
      }),
      nowMs: 1_000_200,
    });
  }

  it('good bytes → CON(delivered_verified) + EVA(result=true); no REC', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const peer = peerSite('@a:srv', 'da');
    const piece = pieceSite('AD1', 0);
    pieceAdvertised(core, peer, piece, 'HOK');

    const out = core.handle({
      kind: 'inbound_bulk',
      msg: {
        kind: 'piece_bytes',
        req_id: 'r1',
        piece_site: piece,
        content_hash: 'HOK',
        events_msgpack: new Uint8Array(0),
      },
      fromPeer: peer,
      nowMs: 1_000_300,
    });
    const events = emits(out);
    const con = events.find((e) => e.op === 'CON' && e.target === peer);
    const eva = events.find((e) => e.op === 'EVA' && e.target === peer);
    const rec = events.find((e) => e.op === 'REC' && e.target === peer);
    expect(con).toBeTruthy();
    expect((con!.operand as { coupling?: string }).coupling).toBe('delivered_verified');
    expect(eva).toBeTruthy();
    expect((eva!.operand as { result?: boolean }).result).toBe(true);
    expect(rec).toBeUndefined();
  });

  it('bad bytes → CON(delivered_failed) + EVA(result=false) + REC(blacklisted)', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const peer = peerSite('@a:srv', 'da');
    const piece = pieceSite('AD1', 0);
    pieceAdvertised(core, peer, piece, 'HOK');

    const out = core.handle({
      kind: 'inbound_bulk',
      msg: {
        kind: 'piece_bytes',
        req_id: 'r1',
        piece_site: piece,
        content_hash: '__INVALID__',
        events_msgpack: new Uint8Array(0),
      },
      fromPeer: peer,
      nowMs: 1_000_300,
    });
    const events = emits(out);
    const con = events.find((e) => e.op === 'CON' && e.target === peer);
    const eva = events.find((e) => e.op === 'EVA' && e.target === peer);
    const rec = events.find((e) => e.op === 'REC' && e.target === peer);
    expect(con).toBeTruthy();
    expect((con!.operand as { coupling?: string }).coupling).toBe('delivered_failed');
    expect(eva).toBeTruthy();
    expect((eva!.operand as { result?: boolean }).result).toBe(false);
    expect(rec).toBeTruthy();
    const recOp = rec!.operand as { restructured_field?: string; from?: string; to?: string; until?: number };
    expect(recOp.restructured_field).toBe(`eligibility_for[${piece}]`);
    expect(recOp.from).toBe('eligible');
    expect(recOp.to?.startsWith('blacklisted_until_')).toBe(true);
    expect(typeof recOp.until).toBe('number');
  });
});

// ─── Core — serving path (inbound control → read → send) ────────────────

describe('network-sync worker — serving path', () => {
  beforeEach(() => resetSeq());

  it('inbound request_piece_bytes triggers a read_piece_events command', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const peer = peerSite('@a:srv', 'da');
    const piece = pieceSite('AD1', 0);
    const out = core.handle({
      kind: 'inbound_control',
      msg: { kind: 'request_piece_bytes', req_id: 'Q1', piece_site: piece, expected_hash: 'H' },
      fromPeer: peer,
      nowMs: 1_000_300,
    });
    const reads = out.filter((c) => c.kind === 'read_piece_events');
    expect(reads).toHaveLength(1);
    expect((reads[0] as { pieceSite: string }).pieceSite).toBe(piece);
  });

  it('piece_events_response produces a send_bulk', () => {
    const core = new NetworkSyncWorkerCore();
    core.handle(defaultStart());
    const peer = peerSite('@a:srv', 'da');
    const piece = pieceSite('AD1', 0);
    const ctrlOut = core.handle({
      kind: 'inbound_control',
      msg: { kind: 'request_piece_bytes', req_id: 'Q1', piece_site: piece, expected_hash: 'H' },
      fromPeer: peer,
      nowMs: 1_000_300,
    });
    const reqId = (ctrlOut.find((c) => c.kind === 'read_piece_events') as { reqId: string }).reqId;
    const out = core.handle({
      kind: 'piece_events_response',
      reqId,
      events: [{ op: 'INS', target: 't', operand: {}, ts: 'x', acquired_ts: 'x' }],
      nowMs: 1_000_400,
    });
    const b = bulks(out);
    expect(b).toHaveLength(1);
    expect(b[0].peer).toBe(peer);
    expect(b[0].msg.kind).toBe('piece_bytes');
    expect((b[0].msg as Extract<BulkMessage, { kind: 'piece_bytes' }>).piece_site).toBe(piece);
  });

  it('rate limiter: a flood of requests from one peer drops past the burst', () => {
    const core = new NetworkSyncWorkerCore({
      servingCapacity: 2,
      servingRefillPerMs: 0,
    });
    core.handle(defaultStart());
    const peer = peerSite('@a:srv', 'da');
    const piece = pieceSite('AD1', 0);
    let reads = 0;
    for (let i = 0; i < 5; i++) {
      const out = core.handle({
        kind: 'inbound_control',
        msg: { kind: 'request_piece_bytes', req_id: `Q${i}`, piece_site: piece, expected_hash: 'H' },
        fromPeer: peer,
        nowMs: 1_000_300 + i,
      });
      reads += out.filter((c) => c.kind === 'read_piece_events').length;
    }
    expect(reads).toBe(2);
  });
});

// ─── Client façade round-trip ───────────────────────────────────────────

describe('network-sync client façade — in-process WorkerLike', () => {
  it('delivers inbound messages and emits commands to the handler', async () => {
    const core = new NetworkSyncWorkerCore();
    const workerLike = createInProcessWorkerLike((msg) =>
      dropDuplicateEmits(core.handle(msg)),
    );
    const client = createNetworkSyncClient(workerLike, { now: () => 1_000_000 });
    const seen: WorkerCommand[] = [];
    client.onCommand((c) => seen.push(c));

    await client.start({
      roomId: ROOM,
      myDeviceId: ME_DEVICE,
      myUserId: ME_USER,
      seedEvents: [],
      nowMs: 1_000_000,
      seed: 42,
    });

    const peer = peerSite('@a:srv', 'da');
    client.reportFoldedEvent(
      ev({
        op: 'CON',
        target: swarmSite(ROOM),
        operand: { joined: peer, coupling: 'active' },
      }),
      1_000_100,
    );
    client.reportFoldedEvent(
      ev({
        op: 'SIG',
        target: swarmSite(ROOM),
        operand: {
          author_device_id: 'AD1',
          piece_index: 0,
          expected_hash: 'HZ',
          advertised_by: peer,
        },
      }),
      1_000_200,
    );
    const ctrls = controls(seen);
    expect(ctrls).toHaveLength(1);
    const m = ctrls[0].msg as Extract<ControlMessage, { kind: 'request_piece_bytes' }>;
    expect(m.expected_hash).toBe('HZ');

    await client.stop();
  });
});
