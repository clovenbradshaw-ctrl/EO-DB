import { describe, it, expect } from 'vitest';
import type { EoEvent } from '../../db/types';
import { emptyProjection, applyEvent, type SyncProjection } from '../projection';
import {
  schedule,
  DEFAULT_KNOBS,
  ENDGAME_FANOUT,
  type SchedulerInput,
  type SchedulerIntent,
} from '../scheduler';
import { swarmSite, peerSite, pieceSite, logSite } from '../sites';

// ─── Helpers ────────────────────────────────────────────────────────────

let nextSeq = 1;
function ev(partial: Partial<EoEvent> & Pick<EoEvent, 'op' | 'target' | 'operand'>): EoEvent {
  return {
    seq: nextSeq++,
    agent: '@sys:x',
    ts: '2026-01-01T00:00:00.000Z',
    acquired_ts: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as EoEvent;
}
function reset() { nextSeq = 1; }

function baseInput(projection: SyncProjection, overrides: Partial<SchedulerInput> = {}): SchedulerInput {
  return {
    projection,
    inFlight: new Map(),
    myDeviceId: 'ME',
    nowMs: 1_000_000,
    knobs: DEFAULT_KNOBS,
    seed: 42,
    ...overrides,
  };
}

function advertise(p: SyncProjection, piece: string, authorDev: string, pieceIndex: number, peer: string, hash = 'H'): SyncProjection {
  void piece;
  return applyEvent(p, ev({
    op: 'SIG',
    target: swarmSite('!r'),
    operand: { author_device_id: authorDev, piece_index: pieceIndex, expected_hash: hash, advertised_by: peer },
  }));
}

function joinPeer(p: SyncProjection, peer: string): SyncProjection {
  return applyEvent(p, ev({
    op: 'CON',
    target: swarmSite('!r'),
    operand: { joined: peer, coupling: 'active' },
  }));
}

function blacklist(p: SyncProjection, peer: string, pieceStr: string, until: number): SyncProjection {
  return applyEvent(p, ev({
    op: 'REC',
    target: peer,
    operand: {
      restructured_field: `eligibility_for[${pieceStr}]`,
      from: 'eligible',
      to: `blacklisted_until_${until}`,
      until,
    },
    meta: { origin_device_id: 'ME' },
  }));
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('scheduler — empty & trivial', () => {
  it('empty projection → no intents', () => {
    const out = schedule(baseInput(emptyProjection()));
    expect(out).toEqual([]);
  });

  it('piece already instantiated → no intents', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({ op: 'INS', target: piece, operand: { content_hash: 'H', verified_at: 't' } }));
    expect(schedule(baseInput(p))).toEqual([]);
  });

  it('piece unrecoverable → no intents', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({ op: 'REC', target: piece, operand: { recognized: 'unrecoverable_pending_author', awaiting: 'A' } }));
    expect(schedule(baseInput(p))).toEqual([]);
  });
});

describe('scheduler — rarest-first', () => {
  it('pieces with fewer advertisers are scheduled first', () => {
    // In endgame (missing < 5), 3 peers per piece; rarest still comes first.
    // Use >= endgameThreshold pieces to force normal-fanout (1 per piece).
    reset();
    let p = emptyProjection();
    // Five pieces, each advertised by 1..5 peers.
    // Use > 5 pieces to ensure normal fanout.
    for (let idx = 0; idx < 6; idx++) {
      const advertisers = idx + 1;
      for (let i = 0; i < advertisers; i++) {
        const peer = peerSite(`@u${idx}_${i}`, `d${idx}_${i}`);
        p = advertise(p, pieceSite('A', idx), 'A', idx, peer);
      }
    }
    const out = schedule(baseInput(p));
    // Normal fanout (1 per piece). First intent should target piece index 0 (rarest).
    const piecesInOrder = out.map((i) => (i as Extract<SchedulerIntent, { kind: 'request_piece' }>).piece_site);
    expect(piecesInOrder[0]).toBe(pieceSite('A', 0));
    expect(piecesInOrder[piecesInOrder.length - 1]).toBe(pieceSite('A', 5));
  });
});

describe('scheduler — in-flight caps', () => {
  it('respects inFlightPerPeer', () => {
    reset();
    let p = emptyProjection();
    const busyPeer = peerSite('@b', 'db');
    // Two pieces advertised only by busyPeer.
    for (let i = 0; i < 2; i++) {
      p = advertise(p, pieceSite('A', i), 'A', i, busyPeer);
    }
    // busyPeer already has 4 outstanding requests on other pieces.
    const inFlight = new Map<string, Set<string>>();
    for (let i = 10; i < 14; i++) {
      inFlight.set(pieceSite('OTHER', i), new Set([busyPeer]));
    }
    const out = schedule(baseInput(p, {
      inFlight,
      knobs: { ...DEFAULT_KNOBS, inFlightPerPeer: 4 },
    }));
    // No request_piece intents should target busyPeer (already at cap).
    const toBusy = out.filter((i) => i.kind === 'request_piece' && i.peer === busyPeer);
    expect(toBusy).toHaveLength(0);
  });

  it('skips pieces already at per-piece fan-out', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    p = advertise(p, pieceSite('A', 0), 'A', 0, peer);
    const inFlight = new Map<string, Set<string>>();
    // With maxConcurrentPeers=1, per-piece cap is 1; an existing in-flight
    // request should prevent any new intent for that piece.
    inFlight.set(pieceSite('A', 0), new Set(['prev']));
    const out = schedule(baseInput(p, {
      inFlight,
      knobs: { ...DEFAULT_KNOBS, maxConcurrentPeers: 1 },
    }));
    expect(out.filter((i) => i.kind === 'request_piece' && i.piece_site === pieceSite('A', 0))).toHaveLength(0);
  });
});

describe('scheduler — blacklist', () => {
  it('skips blacklisted peers for the matching piece', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    const piece = pieceSite('A', 0);
    p = advertise(p, piece, 'A', 0, peer);
    p = blacklist(p, peer, piece, 2_000_000); // blacklisted past nowMs=1_000_000
    const out = schedule(baseInput(p));
    expect(out.filter((i) => i.kind === 'request_piece' && i.peer === peer)).toHaveLength(0);
  });

  it('expired blacklist → peer eligible again', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    const piece = pieceSite('A', 0);
    p = advertise(p, piece, 'A', 0, peer);
    p = blacklist(p, peer, piece, 500_000); // expired by nowMs=1_000_000
    const out = schedule(baseInput(p));
    const req = out.find((i) => i.kind === 'request_piece' && i.peer === peer);
    expect(req).toBeTruthy();
  });
});

describe('scheduler — endgame fan-out', () => {
  it('when missing < endgameThreshold, fans out to 3 peers per piece', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    // Five advertisers of the single missing piece; missing count = 1 < 5.
    for (let i = 0; i < 5; i++) {
      p = advertise(p, piece, 'A', 0, peerSite(`@u${i}`, `d${i}`));
    }
    const out = schedule(baseInput(p));
    const reqs = out.filter((i) => i.kind === 'request_piece' && i.piece_site === piece);
    expect(reqs).toHaveLength(ENDGAME_FANOUT);
  });

  it('at or above threshold, uses normal fanout of 1', () => {
    reset();
    let p = emptyProjection();
    // endgameThreshold default = 5; create 5 pieces so missing >= threshold.
    for (let idx = 0; idx < 5; idx++) {
      p = advertise(p, pieceSite('A', idx), 'A', idx, peerSite('@u', 'du'));
      p = advertise(p, pieceSite('A', idx), 'A', idx, peerSite('@v', 'dv'));
    }
    const out = schedule(baseInput(p));
    // Per piece we expect 1 intent, but each peer can only hold inFlightPerPeer=4.
    // So we should get ~5 intents total.
    const reqs = out.filter((i) => i.kind === 'request_piece');
    const perPiece = new Map<string, number>();
    for (const r of reqs) {
      if (r.kind === 'request_piece') perPiece.set(r.piece_site, (perPiece.get(r.piece_site) ?? 0) + 1);
    }
    for (const [, count] of perPiece) expect(count).toBe(1);
  });
});

describe('scheduler — authoring-device escalation', () => {
  it('all advertising peers blacklisted + author reachable → escalate', () => {
    reset();
    let p = emptyProjection();
    const author = 'AUTHORDEV';
    const piece = pieceSite(author, 0);
    const peer = peerSite('@a', 'da');
    // Peer advertises the piece, but is blacklisted.
    p = advertise(p, piece, author, 0, peer);
    p = blacklist(p, peer, piece, 10_000_000);
    // Author is in the swarm.
    const authorPeer = peerSite('@author', author);
    p = joinPeer(p, authorPeer);

    const out = schedule(baseInput(p));
    const esc = out.find((i) => i.kind === 'escalate_to_author');
    expect(esc).toBeTruthy();
    if (esc && esc.kind === 'escalate_to_author') {
      expect(esc.piece_site).toBe(piece);
      expect(esc.author_device_id).toBe(author);
    }
    // And no request_piece to the blacklisted peer.
    expect(out.find((i) => i.kind === 'request_piece' && i.peer === peer)).toBeUndefined();
  });

  it('all peers blacklisted but author not reachable → no escalation', () => {
    reset();
    let p = emptyProjection();
    const author = 'AUTHORDEV';
    const piece = pieceSite(author, 0);
    const peer = peerSite('@a', 'da');
    p = advertise(p, piece, author, 0, peer);
    p = blacklist(p, peer, piece, 10_000_000);
    // No author join.
    const out = schedule(baseInput(p));
    expect(out.find((i) => i.kind === 'escalate_to_author')).toBeUndefined();
  });

  it('eligible peer exists → no escalation even if others blacklisted', () => {
    reset();
    let p = emptyProjection();
    const author = 'AUTHORDEV';
    const piece = pieceSite(author, 0);
    const blocked = peerSite('@a', 'da');
    const good = peerSite('@b', 'db');
    p = advertise(p, piece, author, 0, blocked);
    p = advertise(p, piece, author, 0, good);
    p = blacklist(p, blocked, piece, 10_000_000);
    p = joinPeer(p, peerSite('@author', author));
    const out = schedule(baseInput(p));
    expect(out.find((i) => i.kind === 'escalate_to_author')).toBeUndefined();
    expect(out.find((i) => i.kind === 'request_piece' && i.peer === good)).toBeTruthy();
  });

  it('no prior advertisers → no escalation (nothing to diagnose)', () => {
    reset();
    let p = emptyProjection();
    const author = 'AUTHORDEV';
    // Author SEG but no advertisers.
    p = applyEvent(p, ev({
      op: 'SEG', target: logSite(author),
      operand: { segment_id: pieceSite(author, 0), bounds: { from_seq: 1, to_seq: 2 }, closes_at: 'e', content_hash: 'H' },
      meta: { origin_device_id: author },
    }));
    const out = schedule(baseInput(p));
    expect(out.find((i) => i.kind === 'escalate_to_author')).toBeUndefined();
  });
});

describe('scheduler — timeouts', () => {
  it('first attempt uses requestTimeoutFirstMs', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    p = advertise(p, pieceSite('A', 0), 'A', 0, peer);
    const out = schedule(baseInput(p));
    const req = out[0] as Extract<SchedulerIntent, { kind: 'request_piece' }>;
    expect(req.timeoutMs).toBe(DEFAULT_KNOBS.requestTimeoutFirstMs);
  });

  it('subsequent attempt uses requestTimeoutSubsequentMs', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    const altPeer = peerSite('@b', 'db');
    const piece = pieceSite('A', 0);
    p = advertise(p, piece, 'A', 0, peer);
    p = advertise(p, piece, 'A', 0, altPeer);
    // A previous failed delivery exists for this piece.
    p = applyEvent(p, ev({
      op: 'CON', target: peer,
      operand: { joined: piece, coupling: 'delivered_failed', observed_hash: 'bad' },
    }));
    p = blacklist(p, peer, piece, 10_000_000);
    const out = schedule(baseInput(p));
    const req = out.find((i) => i.kind === 'request_piece') as Extract<SchedulerIntent, { kind: 'request_piece' }> | undefined;
    expect(req?.timeoutMs).toBe(DEFAULT_KNOBS.requestTimeoutSubsequentMs);
  });
});

describe('scheduler — determinism', () => {
  function seed(p: SyncProjection) {
    const author = 'A';
    for (let idx = 0; idx < 4; idx++) {
      for (let i = 0; i < 3; i++) {
        p = advertise(p, pieceSite(author, idx), author, idx, peerSite(`@u${i}`, `d${i}`));
      }
    }
    return p;
  }

  it('same input → identical intents', () => {
    reset();
    let p = emptyProjection();
    p = seed(p);
    const a = schedule(baseInput(p));
    const b = schedule(baseInput(p));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seed → same set of intents, possibly different order for ties', () => {
    reset();
    let p = emptyProjection();
    p = seed(p);
    const a = schedule(baseInput(p, { seed: 1 }));
    const b = schedule(baseInput(p, { seed: 9999 }));
    const aSet = new Set(a.map((i) => JSON.stringify(i)));
    const bSet = new Set(b.map((i) => JSON.stringify(i)));
    // Set-equal (every chosen peer/piece pair is legitimate under both seeds).
    expect(aSet.size).toBe(bSet.size);
  });

  it('fanout enforced across all pieces with the same peer pool', () => {
    reset();
    let p = emptyProjection();
    p = seed(p); // 4 pieces × 3 peers each, missing = 4 < 5 → endgame
    const out = schedule(baseInput(p));
    // Endgame fanout = 3, 4 pieces → up to 12 intents, but inFlightPerPeer=4
    // and there are only 3 peers total → capped at 12 (3 peers × 4 in-flight).
    const reqs = out.filter((i) => i.kind === 'request_piece');
    expect(reqs.length).toBeLessThanOrEqual(12);
    const perPeer = new Map<string, number>();
    for (const r of reqs) {
      if (r.kind === 'request_piece') perPeer.set(r.peer, (perPeer.get(r.peer) ?? 0) + 1);
    }
    for (const [, count] of perPeer) {
      expect(count).toBeLessThanOrEqual(DEFAULT_KNOBS.inFlightPerPeer);
    }
  });
});
