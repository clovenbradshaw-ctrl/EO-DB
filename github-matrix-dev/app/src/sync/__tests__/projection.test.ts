import { describe, it, expect } from 'vitest';
import type { EoEvent } from '../../db/types';
import { emptyProjection, applyEvent, pieceStatus } from '../projection';
import { swarmSite, peerSite, logSite, pieceSite, tailSite } from '../sites';
import { formatAgent } from '../agent';

let nextSeq = 1;
function ev(partial: Partial<EoEvent> & Pick<EoEvent, 'op' | 'target' | 'operand'>): EoEvent {
  return {
    seq: nextSeq++,
    agent: '@sys:local',
    ts: '2026-01-01T00:00:00.000Z',
    acquired_ts: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as EoEvent;
}

function resetSeq() {
  nextSeq = 1;
}

describe('projection — swarm events', () => {
  it('INS joins the swarm, idempotent', () => {
    resetSeq();
    let p = emptyProjection();
    p = applyEvent(p, ev({ op: 'INS', target: swarmSite('!r'), operand: { joined_at: 't' } }));
    expect(p.swarm.joined).toBe(true);
    const before = p;
    p = applyEvent(p, ev({ op: 'INS', target: swarmSite('!r'), operand: { joined_at: 't2' } }));
    expect(p).toBe(before); // reference equality ⇒ no change
  });

  it('CON records peer membership', () => {
    resetSeq();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    p = applyEvent(p, ev({ op: 'CON', target: swarmSite('!r'), operand: { joined: peer, coupling: 'active' } }));
    expect(p.swarm.members.get(peer)?.coupling).toBe('active');
    expect(p.peers.get(peer)?.first_seen_seq).toBeGreaterThanOrEqual(0);
  });

  it('SIG creates piece candidate and peer edge', () => {
    resetSeq();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    p = applyEvent(p, ev({
      op: 'SIG',
      target: swarmSite('!r'),
      operand: { author_device_id: 'AUTHOR', piece_index: 5, expected_hash: 'h1', advertised_by: peer },
    }));
    const pi = p.pieces.get(pieceSite('AUTHOR', 5))!;
    expect(pi.candidates.get('h1')?.advertised_by.has(peer)).toBe(true);
    expect(pieceStatus(pi)).toBe('signaled');
    expect(p.peers.get(peer)?.edges.get(pieceSite('AUTHOR', 5))?.coupling).toBe('advertised');
  });

  it('two SIGs with different hashes produce contested superposition', () => {
    resetSeq();
    let p = emptyProjection();
    const pA = peerSite('@a', 'da');
    const pB = peerSite('@b', 'db');
    p = applyEvent(p, ev({
      op: 'SIG', target: swarmSite('!r'),
      operand: { author_device_id: 'A', piece_index: 0, expected_hash: 'h1', advertised_by: pA },
    }));
    p = applyEvent(p, ev({
      op: 'SIG', target: swarmSite('!r'),
      operand: { author_device_id: 'A', piece_index: 0, expected_hash: 'h2', advertised_by: pB },
    }));
    const pi = p.pieces.get(pieceSite('A', 0))!;
    expect(pi.candidates.size).toBe(2);
    expect(pieceStatus(pi)).toBe('contested');
  });
});

describe('projection — peer events', () => {
  it('EVA appended to history', () => {
    resetSeq();
    let p = emptyProjection();
    const s = peerSite('@a', 'da');
    p = applyEvent(p, ev({ op: 'EVA', target: s, operand: { predicate: 'satisfies_claimed_hash', result: false, evidence: { piece_site: pieceSite('A', 0) } } }));
    expect(p.peers.get(s)?.evas.length).toBe(1);
  });

  it('REC restructures eligibility and until', () => {
    resetSeq();
    let p = emptyProjection();
    const s = peerSite('@a', 'da');
    p = applyEvent(p, ev({
      op: 'REC', target: s,
      operand: { restructured_field: `eligibility_for[${pieceSite('A', 0)}]`, from: 'eligible', to: 'blacklisted_until_1000', until: 1000 },
      meta: { origin_device_id: 'OBSERVER' },
    }));
    const peer = p.peers.get(s)!;
    expect(peer.eligibility.get(`eligibility_for[${pieceSite('A', 0)}]`)).toBe('blacklisted_until_1000');
    expect(peer.eligibilityUntil.get(`eligibility_for[${pieceSite('A', 0)}]`)).toBe(1000);
    expect(peer.recsByObserver.get('OBSERVER')?.length).toBe(1);
  });

  it('CON delivered_verified reflects on piece', () => {
    resetSeq();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({
      op: 'CON', target: peer,
      operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'h1' },
    }));
    const pi = p.pieces.get(piece)!;
    expect(pi.deliveries.get(peer)?.verified).toBe(true);
    expect(pi.deliveries.get(peer)?.observed_hash).toBe('h1');
  });

  it('CON delivered_failed reflects on piece failedDeliveries', () => {
    resetSeq();
    let p = emptyProjection();
    const peer = peerSite('@a', 'da');
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({
      op: 'CON', target: peer,
      operand: { joined: piece, coupling: 'delivered_failed', observed_hash: 'hbad' },
    }));
    expect(p.pieces.get(piece)!.failedDeliveries.has(peer)).toBe(true);
  });
});

describe('projection — log SEG authority rule', () => {
  it('accepts SEG from author device, via meta', () => {
    resetSeq();
    let p = emptyProjection();
    const author = 'AUTHOR_DEV';
    const site = logSite(author);
    const piece = pieceSite(author, 7);
    p = applyEvent(p, ev({
      op: 'SEG', target: site,
      operand: { segment_id: piece, bounds: { from_seq: 1, to_seq: 10 }, closes_at: 'ev-x', content_hash: 'AUTH_H' },
      meta: { origin_device_id: author },
    }));
    expect(p.logs.get(author)?.segs.get(piece)?.content_hash).toBe('AUTH_H');
    expect(p.pieces.get(piece)?.authorHash).toBe('AUTH_H');
  });

  it('accepts SEG from author device via compound agent', () => {
    resetSeq();
    let p = emptyProjection();
    const author = 'AUTHOR_DEV';
    const site = logSite(author);
    const piece = pieceSite(author, 7);
    p = applyEvent(p, ev({
      op: 'SEG', target: site,
      operand: { segment_id: piece, bounds: { from_seq: 1, to_seq: 10 }, closes_at: 'ev-x', content_hash: 'AUTH_H' },
      agent: formatAgent('@user', author),
    }));
    expect(p.logs.get(author)?.segs.get(piece)?.content_hash).toBe('AUTH_H');
  });

  it('drops SEG from non-author device', () => {
    resetSeq();
    let p = emptyProjection();
    const author = 'AUTHOR_DEV';
    const site = logSite(author);
    const piece = pieceSite(author, 7);
    p = applyEvent(p, ev({
      op: 'SEG', target: site,
      operand: { segment_id: piece, bounds: { from_seq: 1, to_seq: 10 }, closes_at: 'ev-x', content_hash: 'FAKE' },
      meta: { origin_device_id: 'IMPOSTER' },
    }));
    expect(p.logs.get(author)?.segs.size ?? 0).toBe(0);
    expect(p.pieces.get(piece)?.authorHash ?? null).toBe(null);
  });

  it('drops SEG whose segment_id has mismatched author', () => {
    resetSeq();
    let p = emptyProjection();
    const author = 'AUTHOR_DEV';
    const site = logSite(author);
    const otherPiece = pieceSite('OTHER', 0);
    p = applyEvent(p, ev({
      op: 'SEG', target: site,
      operand: { segment_id: otherPiece, bounds: { from_seq: 1, to_seq: 10 }, closes_at: 'ev-x', content_hash: 'H' },
      meta: { origin_device_id: author },
    }));
    expect(p.logs.get(author)?.segs.size ?? 0).toBe(0);
  });
});

describe('projection — piece status transitions', () => {
  it('absent → signaled (SIG) → contested (second SIG)', () => {
    resetSeq();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    expect(pieceStatus(p.pieces.get(piece) ?? { piece_site: piece, author_device_id: 'A', piece_index: 0, candidates: new Map(), deliveries: new Map(), failedDeliveries: new Map(), authorHash: null, definedHash: null, definedFrom: null, instantiatedHash: null, swarmAttestedHash: null, unrecoverable: false, last_seq: -1 } as any)).toBe('absent');
    p = applyEvent(p, ev({ op: 'SIG', target: swarmSite('!r'), operand: { author_device_id: 'A', piece_index: 0, expected_hash: 'h', advertised_by: peerSite('@a', 'da') } }));
    expect(pieceStatus(p.pieces.get(piece)!)).toBe('signaled');
    p = applyEvent(p, ev({ op: 'SIG', target: swarmSite('!r'), operand: { author_device_id: 'A', piece_index: 0, expected_hash: 'h2', advertised_by: peerSite('@b', 'db') } }));
    expect(pieceStatus(p.pieces.get(piece)!)).toBe('contested');
  });

  it('INS on piece sets instantiated', () => {
    resetSeq();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({ op: 'INS', target: piece, operand: { content_hash: 'H', verified_at: 't' } }));
    expect(pieceStatus(p.pieces.get(piece)!)).toBe('instantiated');
  });

  it('SYN on piece sets swarm_attested', () => {
    resetSeq();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({ op: 'SYN', target: piece, operand: { contributors: [], unanimous_hash: 'H', threshold: 3 } }));
    expect(pieceStatus(p.pieces.get(piece)!)).toBe('swarm_attested');
  });

  it('REC(unrecoverable) sets unrecoverable', () => {
    resetSeq();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({ op: 'REC', target: piece, operand: { recognized: 'unrecoverable_pending_author', awaiting: 'A' } }));
    expect(pieceStatus(p.pieces.get(piece)!)).toBe('unrecoverable');
  });
});

describe('projection — multi-valued holding of concurrent conflicting events', () => {
  it('preserves both EVAs on same peer field', () => {
    resetSeq();
    let p = emptyProjection();
    const s = peerSite('@a', 'da');
    p = applyEvent(p, ev({ op: 'EVA', target: s, operand: { predicate: 'satisfies_claimed_hash', result: true, evidence: {} } }));
    p = applyEvent(p, ev({ op: 'EVA', target: s, operand: { predicate: 'satisfies_claimed_hash', result: false, evidence: {} } }));
    expect(p.peers.get(s)?.evas.length).toBe(2);
  });

  it('preserves RECs from distinct observers', () => {
    resetSeq();
    let p = emptyProjection();
    const s = peerSite('@a', 'da');
    const field = 'eligibility_for[piece:A/v1/0]';
    p = applyEvent(p, ev({ op: 'REC', target: s, operand: { restructured_field: field, from: 'eligible', to: 'blacklisted_until_1' }, meta: { origin_device_id: 'D1' } }));
    p = applyEvent(p, ev({ op: 'REC', target: s, operand: { restructured_field: field, from: 'eligible', to: 'blacklisted_until_2' }, meta: { origin_device_id: 'D2' } }));
    expect(p.peers.get(s)?.recsByObserver.size).toBe(2);
  });
});

describe('projection — immutability', () => {
  it('applyEvent returns a new projection instance when state changes', () => {
    resetSeq();
    const p0 = emptyProjection();
    const p1 = applyEvent(p0, ev({ op: 'INS', target: swarmSite('!r'), operand: {} }));
    expect(p1).not.toBe(p0);
    expect(p0.swarm.joined).toBe(false);
    expect(p1.swarm.joined).toBe(true);
  });

  it('ignores non-sync events', () => {
    resetSeq();
    const p0 = emptyProjection();
    const p1 = applyEvent(p0, ev({ op: 'INS', target: 'card:user1', operand: { name: 'alice' } }));
    expect(p1).toBe(p0);
  });

  it('ignores unrecognized (op, family) combinations', () => {
    resetSeq();
    const p0 = emptyProjection();
    const p1 = applyEvent(p0, ev({ op: 'SEG', target: swarmSite('!r'), operand: {} }));
    expect(p1).toBe(p0);
  });
});

describe('projection — tail events', () => {
  it('REC advances local_tail_head monotonically', () => {
    resetSeq();
    let p = emptyProjection();
    const author = 'A';
    p = applyEvent(p, ev({ op: 'INS', target: tailSite(author), operand: { first_seen_at: 't' } }));
    p = applyEvent(p, ev({ op: 'REC', target: tailSite(author), operand: { field: 'local_tail_head', from: 0, to: 10 } }));
    p = applyEvent(p, ev({ op: 'REC', target: tailSite(author), operand: { field: 'local_tail_head', from: 10, to: 5 } }));
    expect(p.tails.get(author)?.localTailHead).toBe(10);
  });

  it('SYN records multi-sourced unanimity', () => {
    resetSeq();
    let p = emptyProjection();
    const author = 'A';
    p = applyEvent(p, ev({ op: 'SYN', target: tailSite(author), operand: { kind: 'multi_sourced_unanimous', contributors: [peerSite('@x', 'dx')], head: 42 } }));
    expect(p.tails.get(author)?.lastSyn?.head).toBe(42);
  });
});
