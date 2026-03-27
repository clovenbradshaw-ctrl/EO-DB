import { describe, it, expect } from 'vitest';
import { Feed, globMatch } from '../src/db/feed.js';
import type { EoEvent } from '../src/db/types.js';

function makeEvent(overrides: Partial<EoEvent> = {}): EoEvent {
  return {
    seq: 1,
    op: 'DEF',
    target: 'app.tblClients.rec001.fldEmail',
    operand: 'test@test.com',
    agent: '@test:app.aminoimmigration.com',
    ts: '2025-06-01T00:00:00.000Z',
    acquired_ts: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('globMatch', () => {
  it('* matches one segment', () => {
    expect(globMatch('app.*', 'app.tblClients')).toBe(true);
    expect(globMatch('app.*', 'app.tblClients.rec001')).toBe(false);
  });

  it('** matches any depth', () => {
    expect(globMatch('app.**', 'app.tblClients')).toBe(true);
    expect(globMatch('app.**', 'app.tblClients.rec001')).toBe(true);
    expect(globMatch('app.**', 'app.tblClients.rec001.fldEmail')).toBe(true);
  });

  it('exact match works', () => {
    expect(globMatch('app.tblClients.rec001', 'app.tblClients.rec001')).toBe(true);
    expect(globMatch('app.tblClients.rec001', 'app.tblClients.rec002')).toBe(false);
  });

  it('** in middle matches', () => {
    expect(globMatch('app.**.fldEmail', 'app.tblClients.rec001.fldEmail')).toBe(true);
    expect(globMatch('app.**.fldEmail', 'app.rec001.fldEmail')).toBe(true);
  });

  it('empty pattern matches nothing', () => {
    expect(globMatch('', 'app.test')).toBe(false);
  });
});

describe('Feed', () => {
  it('subscribe registers listener and notify calls it', () => {
    const feed = new Feed();
    const received: EoEvent[] = [];
    feed.subscribe('app.**', (e) => received.push(e));

    feed.notify(makeEvent());
    expect(received).toHaveLength(1);
  });

  it('notify does NOT call non-matching subscribers', () => {
    const feed = new Feed();
    const received: EoEvent[] = [];
    feed.subscribe('other.**', (e) => received.push(e));

    feed.notify(makeEvent());
    expect(received).toHaveLength(0);
  });

  it('operator filter: only receives matching ops', () => {
    const feed = new Feed();
    const received: EoEvent[] = [];
    feed.subscribe('app.**', (e) => received.push(e), ['DEF']);

    feed.notify(makeEvent({ op: 'DEF' }));
    feed.notify(makeEvent({ op: 'INS' }));
    expect(received).toHaveLength(1);
    expect(received[0].op).toBe('DEF');
  });

  it('unsubscribe removes listener', () => {
    const feed = new Feed();
    const received: EoEvent[] = [];
    const id = feed.subscribe('app.**', (e) => received.push(e));

    feed.notify(makeEvent());
    expect(received).toHaveLength(1);

    feed.unsubscribe(id);
    feed.notify(makeEvent());
    expect(received).toHaveLength(1); // no new events
  });

  it('multiple subscribers on same pattern all receive events', () => {
    const feed = new Feed();
    const a: EoEvent[] = [];
    const b: EoEvent[] = [];
    feed.subscribe('app.**', (e) => a.push(e));
    feed.subscribe('app.**', (e) => b.push(e));

    feed.notify(makeEvent());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
