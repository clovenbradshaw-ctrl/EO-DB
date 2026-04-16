import { describe, it, expect } from 'vitest';
import type { EoEvent } from '../../db/types';
import { emptyProjection, applyEvent } from '../projection';
import { computeDerivedEvents, stableDerivedId, DEFAULT_SYN_THRESHOLD, DEFAULT_REPUTATION_THRESHOLD } from '../derived';
import { swarmSite, peerSite, pieceSite, logSite } from '../sites';

const KNOBS = {
  synThreshold: DEFAULT_SYN_THRESHOLD,
  reputationThreshold: DEFAULT_REPUTATION_THRESHOLD,
  now: '2026-01-01T00:00:00.000Z',
  systemAgent: 'system',
  reachableAuthors: new Set<string>(),
};

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
function reset() { nextSeq = 1; }

describe('derived — DEF on piece collapse', () => {
  it('author SEG triggers DEF(author_seg)', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({
      op: 'SEG', target: logSite('A'),
      operand: { segment_id: piece, bounds: { from_seq: 1, to_seq: 2 }, closes_at: 'e', content_hash: 'H' },
      meta: { origin_device_id: 'A' },
    }));
    const out = computeDerivedEvents(p, KNOBS);
    expect(out).toHaveLength(1);
    expect(out[0].op).toBe('DEF');
    expect(out[0].target).toBe(piece);
    expect((out[0].operand as any).resolved_from).toBe('author_seg');
  });

  it('single verified delivery triggers DEF(single_verified_delivery)', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    const peer = peerSite('@a', 'da');
    p = applyEvent(p, ev({
      op: 'CON', target: peer,
      operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'H' },
    }));
    const out = computeDerivedEvents(p, KNOBS);
    const def = out.find((e) => e.op === 'DEF');
    expect(def).toBeTruthy();
    expect((def!.operand as any).hash).toBe('H');
    expect((def!.operand as any).resolved_from).toBe('single_verified_delivery');
  });

  it('does not emit DEF when already defined', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    p = applyEvent(p, ev({ op: 'DEF', target: piece, operand: { hash: 'H', resolved_from: 'author_seg' } }));
    const out = computeDerivedEvents(p, KNOBS);
    expect(out.filter((e) => e.op === 'DEF' && e.target === piece)).toHaveLength(0);
  });
});

describe('derived — SYN on piece when N peers verify', () => {
  it('emits SYN when N verifying deliveries of same hash', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    for (let i = 0; i < 3; i++) {
      const peer = peerSite(`@u${i}`, `d${i}`);
      p = applyEvent(p, ev({
        op: 'CON', target: peer,
        operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'H' },
      }));
    }
    const out = computeDerivedEvents(p, KNOBS);
    const syn = out.find((e) => e.op === 'SYN' && e.target === piece);
    expect(syn).toBeTruthy();
    expect((syn!.operand as any).unanimous_hash).toBe('H');
    expect((syn!.operand as any).contributors).toHaveLength(3);
  });

  it('below threshold → no SYN', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    for (let i = 0; i < 2; i++) {
      const peer = peerSite(`@u${i}`, `d${i}`);
      p = applyEvent(p, ev({
        op: 'CON', target: peer,
        operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'H' },
      }));
    }
    const out = computeDerivedEvents(p, KNOBS);
    expect(out.some((e) => e.op === 'SYN' && e.target === piece)).toBe(false);
  });
});

describe('derived — REC on piece unrecoverable', () => {
  it('emits REC when all deliveries fail and author unreachable', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('AUTHOR', 0);
    const peer = peerSite('@a', 'da');
    p = applyEvent(p, ev({
      op: 'CON', target: peer,
      operand: { joined: piece, coupling: 'delivered_failed', observed_hash: 'bad' },
    }));
    const out = computeDerivedEvents(p, KNOBS); // AUTHOR not in reachableAuthors
    const rec = out.find((e) => e.op === 'REC' && e.target === piece);
    expect(rec).toBeTruthy();
    expect((rec!.operand as any).recognized).toBe('unrecoverable_pending_author');
  });

  it('no REC when author is reachable', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('AUTHOR', 0);
    const peer = peerSite('@a', 'da');
    p = applyEvent(p, ev({
      op: 'CON', target: peer,
      operand: { joined: piece, coupling: 'delivered_failed', observed_hash: 'bad' },
    }));
    const out = computeDerivedEvents(p, { ...KNOBS, reachableAuthors: new Set(['AUTHOR']) });
    expect(out.some((e) => e.op === 'REC' && e.target === piece)).toBe(false);
  });

  it('no REC when at least one delivery verifies', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('AUTHOR', 0);
    p = applyEvent(p, ev({
      op: 'CON', target: peerSite('@a', 'da'),
      operand: { joined: piece, coupling: 'delivered_failed', observed_hash: 'bad' },
    }));
    p = applyEvent(p, ev({
      op: 'CON', target: peerSite('@b', 'db'),
      operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'H' },
    }));
    const out = computeDerivedEvents(p, KNOBS);
    expect(out.some((e) => e.op === 'REC' && e.target === piece)).toBe(false);
  });
});

describe('derived — SYN on peer (cross-device reputation)', () => {
  it('emits SYN when reputationThreshold observers emit similar RECs', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@q', 'dq');
    const field = 'eligibility_for[piece:A/v1/0]';
    for (const observer of ['O1', 'O2', 'O3']) {
      p = applyEvent(p, ev({
        op: 'REC', target: peer,
        operand: { restructured_field: field, from: 'eligible', to: 'blacklisted_until_100', until: 100 },
        meta: { origin_device_id: observer },
      }));
    }
    const out = computeDerivedEvents(p, KNOBS);
    const syn = out.find((e) => e.op === 'SYN' && e.target === peer);
    expect(syn).toBeTruthy();
    expect((syn!.operand as any).contributors).toEqual(['O1', 'O2', 'O3']);
    expect((syn!.operand as any).kind).toBe('cross_device_unreliability');
  });

  it('below threshold → no peer SYN', () => {
    reset();
    let p = emptyProjection();
    const peer = peerSite('@q', 'dq');
    const field = 'eligibility_for[piece:A/v1/0]';
    for (const observer of ['O1', 'O2']) {
      p = applyEvent(p, ev({
        op: 'REC', target: peer,
        operand: { restructured_field: field, from: 'eligible', to: 'blacklisted_until_100' },
        meta: { origin_device_id: observer },
      }));
    }
    const out = computeDerivedEvents(p, KNOBS);
    expect(out.some((e) => e.op === 'SYN' && e.target === peer)).toBe(false);
  });
});

describe('derived — stable client_event_id for idempotency', () => {
  it('stableDerivedId is deterministic and order-independent', () => {
    const a = stableDerivedId('DEF', 'piece:A/v1/0', ['x', 'y', 'z']);
    const b = stableDerivedId('DEF', 'piece:A/v1/0', ['z', 'y', 'x']);
    expect(a).toBe(b);
  });

  it('distinct inputs produce distinct ids', () => {
    const a = stableDerivedId('DEF', 'piece:A/v1/0', ['H1']);
    const b = stableDerivedId('DEF', 'piece:A/v1/0', ['H2']);
    expect(a).not.toBe(b);
  });

  it('re-derivation on identical projection yields identical ids (no duplicates by id)', () => {
    reset();
    let p = emptyProjection();
    const piece = pieceSite('A', 0);
    for (let i = 0; i < 3; i++) {
      p = applyEvent(p, ev({
        op: 'CON', target: peerSite(`@u${i}`, `d${i}`),
        operand: { joined: piece, coupling: 'delivered_verified', observed_hash: 'H' },
      }));
    }
    const first = computeDerivedEvents(p, KNOBS);
    const second = computeDerivedEvents(p, KNOBS);
    const firstIds = new Set(first.map((e) => e.client_event_id));
    const secondIds = new Set(second.map((e) => e.client_event_id));
    expect(secondIds).toEqual(firstIds);
  });
});
