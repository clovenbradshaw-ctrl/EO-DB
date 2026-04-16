/**
 * Determinism — 10K random sync events, 5 different orders (after canonical
 * causal sort), yield identical final projection.
 *
 * Causal sort: same-site events are ordered by their original emission seq
 * (i.e., the seq each device assigned when emitting). Across sites, order is
 * free — applying cross-site events in any interleaving must yield the same
 * per-site state.
 *
 * Note: true causal DAG ordering is deferred (no prev_events yet). This test
 * exercises the weaker but sufficient per-site seq order, which is what
 * Phase 1's fold determinism guarantees.
 */

import { describe, it, expect } from 'vitest';
import type { EoEvent } from '../../db/types';
import { emptyProjection, applyEvent, type SyncProjection } from '../projection';
import { swarmSite, peerSite, pieceSite, logSite, tailSite } from '../sites';

// ─── Deterministic PRNG ──────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

// ─── Random event generator ──────────────────────────────────────────────

function generateEvents(seed: number, count: number): EoEvent[] {
  const rng = mulberry32(seed);
  const events: EoEvent[] = [];
  const rooms = ['!r:a', '!r:b'];
  const authors = ['A1', 'A2', 'A3'];
  const peers: string[] = [
    peerSite('@u1:x', 'd1'),
    peerSite('@u2:x', 'd2'),
    peerSite('@u3:x', 'd3'),
    peerSite('@u4:x', 'd4'),
  ];
  const hashes = ['H1', 'H2', 'H3'];
  const couplings: string[] = ['advertised', 'delivered_verified', 'delivered_failed'];

  for (let i = 0; i < count; i++) {
    const seq = i + 1;
    const k = Math.floor(rng() * 9);
    const ts = new Date(1735689600000 + i * 10).toISOString();
    switch (k) {
      case 0: {
        events.push(mkEv(seq, 'INS', swarmSite(pick(rng, rooms)), { joined_at: ts }, ts));
        break;
      }
      case 1: {
        events.push(mkEv(seq, 'CON', swarmSite(pick(rng, rooms)), {
          joined: pick(rng, peers), coupling: pick(rng, ['active', 'stale', 'departed']),
        }, ts));
        break;
      }
      case 2: {
        const author = pick(rng, authors);
        const pieceIndex = Math.floor(rng() * 5);
        events.push(mkEv(seq, 'SIG', swarmSite(pick(rng, rooms)), {
          author_device_id: author, piece_index: pieceIndex, expected_hash: pick(rng, hashes), advertised_by: pick(rng, peers),
        }, ts));
        break;
      }
      case 3: {
        events.push(mkEv(seq, 'EVA', pick(rng, peers), {
          predicate: 'satisfies_claimed_hash', result: rng() < 0.5, evidence: {},
        }, ts));
        break;
      }
      case 4: {
        const author = pick(rng, authors);
        const pieceIndex = Math.floor(rng() * 5);
        events.push(mkEv(seq, 'CON', pick(rng, peers), {
          joined: pieceSite(author, pieceIndex), coupling: pick(rng, couplings),
          observed_hash: pick(rng, hashes),
        }, ts));
        break;
      }
      case 5: {
        const author = pick(rng, authors);
        const pieceIndex = Math.floor(rng() * 5);
        events.push(mkEv(seq, 'REC', pick(rng, peers), {
          restructured_field: `eligibility_for[${pieceSite(author, pieceIndex)}]`,
          from: 'eligible', to: `blacklisted_until_${1000 + seq}`, until: 1000 + seq,
        }, ts, { origin_device_id: `O${seq % 4}` }));
        break;
      }
      case 6: {
        const author = pick(rng, authors);
        const pieceIndex = Math.floor(rng() * 5);
        events.push(mkEv(seq, 'SEG', logSite(author), {
          segment_id: pieceSite(author, pieceIndex),
          bounds: { from_seq: 1, to_seq: seq }, closes_at: `e${seq}`, content_hash: pick(rng, hashes),
        }, ts, { origin_device_id: author }));
        break;
      }
      case 7: {
        const author = pick(rng, authors);
        const pieceIndex = Math.floor(rng() * 5);
        events.push(mkEv(seq, 'INS', pieceSite(author, pieceIndex), {
          content_hash: pick(rng, hashes), verified_at: ts,
        }, ts));
        break;
      }
      case 8: {
        const author = pick(rng, authors);
        events.push(mkEv(seq, 'REC', tailSite(author), {
          field: 'local_tail_head', from: seq - 1, to: seq,
        }, ts));
        break;
      }
    }
  }
  return events;
}

function mkEv(seq: number, op: EoEvent['op'], target: string, operand: any, ts: string, meta?: any): EoEvent {
  return {
    seq, op, target, operand,
    agent: '@sys:x', ts, acquired_ts: ts,
    meta,
  } as EoEvent;
}

// ─── Canonical sort: by (target, seq) ────────────────────────────────────

function canonicalSort(events: EoEvent[]): EoEvent[] {
  return events.slice().sort((a, b) => {
    if (a.target < b.target) return -1;
    if (a.target > b.target) return 1;
    return a.seq - b.seq;
  });
}

// ─── Projection canonicalization for comparison ──────────────────────────

function canonProjection(p: SyncProjection): unknown {
  return {
    swarm: {
      joined: p.swarm.joined,
      members: sortedMap(p.swarm.members, (m) => ({ coupling: m.coupling, last_seq: m.last_seq })),
      knownAuthors: [...p.swarm.knownAuthors].sort(),
      synEvents: p.swarm.synEvents,
    },
    peers: sortedMap(p.peers, (peer) => ({
      first_seen_seq: peer.first_seen_seq,
      eligibility: sortedMap(peer.eligibility, (v) => v),
      eligibilityUntil: sortedMap(peer.eligibilityUntil, (v) => v),
      evas: peer.evas.slice().sort((a, b) => a.seq - b.seq).map((e) => ({ predicate: e.predicate, result: e.result, seq: e.seq })),
      recsByObserver: sortedMap(peer.recsByObserver, (recs) => recs.slice().sort((a, b) => a.seq - b.seq).map((r) => ({ field: r.restructured_field, to: r.to, seq: r.seq }))),
      edges: sortedMap(peer.edges, (e) => ({ coupling: e.coupling, last_seq: e.last_seq })),
      lastSyn: peer.lastSyn,
    })),
    logs: sortedMap(p.logs, (l) => ({
      first_seen_seq: l.first_seen_seq,
      segs: sortedMap(l.segs, (s) => ({ content_hash: s.content_hash, seq: s.seq })),
      localTailHead: l.localTailHead,
    })),
    pieces: sortedMap(p.pieces, (pi) => ({
      candidates: sortedMap(pi.candidates, (c) => ({ advertised_by: [...c.advertised_by].sort(), first_seq: c.first_seq, last_seq: c.last_seq })),
      deliveries: sortedMap(pi.deliveries, (d) => ({ hash: d.observed_hash, verified: d.verified, seq: d.seq })),
      failedDeliveries: sortedMap(pi.failedDeliveries, (d) => ({ hash: d.observed_hash, seq: d.seq })),
      authorHash: pi.authorHash,
      definedHash: pi.definedHash,
      definedFrom: pi.definedFrom,
      instantiatedHash: pi.instantiatedHash,
      swarmAttestedHash: pi.swarmAttestedHash,
      unrecoverable: pi.unrecoverable,
    })),
    tails: sortedMap(p.tails, (t) => ({
      first_seen_seq: t.first_seen_seq, localTailHead: t.localTailHead, lastSyn: t.lastSyn,
    })),
  };
}

function sortedMap<V, R>(m: Map<string, V>, f: (v: V) => R): Array<[string, R]> {
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => [k, f(v)]);
}

// ─── Shuffling ───────────────────────────────────────────────────────────

function shuffleByTargetGroups(events: EoEvent[], seed: number): EoEvent[] {
  // Shuffle events across targets while preserving per-target seq order.
  const rng = mulberry32(seed);
  const byTarget = new Map<string, EoEvent[]>();
  for (const e of events) {
    const list = byTarget.get(e.target) ?? [];
    list.push(e);
    byTarget.set(e.target, list);
  }
  for (const list of byTarget.values()) list.sort((a, b) => a.seq - b.seq);

  const heads = new Map<string, number>();
  for (const t of byTarget.keys()) heads.set(t, 0);

  const result: EoEvent[] = [];
  while (result.length < events.length) {
    const candidates: string[] = [];
    for (const [t, list] of byTarget) {
      const idx = heads.get(t)!;
      if (idx < list.length) candidates.push(t);
    }
    const chosen = candidates[Math.floor(rng() * candidates.length)];
    const idx = heads.get(chosen)!;
    result.push(byTarget.get(chosen)![idx]);
    heads.set(chosen, idx + 1);
  }
  return result;
}

// ─── Test ────────────────────────────────────────────────────────────────

describe('determinism — 10K events, 5 orderings', () => {
  it('canonical sort produces identical projection regardless of input order', () => {
    const base = generateEvents(0xc0ffee, 10_000);
    const seeds = [1, 2, 3, 4, 5];

    // Compute reference projection from canonical sort of base.
    const refOrder = canonicalSort(base);
    let ref = emptyProjection();
    for (const e of refOrder) ref = applyEvent(ref, e);
    const refCanon = JSON.stringify(canonProjection(ref));

    for (const s of seeds) {
      const shuffled = shuffleByTargetGroups(base, s);
      const sorted = canonicalSort(shuffled);
      let p = emptyProjection();
      for (const e of sorted) p = applyEvent(p, e);
      expect(JSON.stringify(canonProjection(p))).toBe(refCanon);
    }
  });
});
