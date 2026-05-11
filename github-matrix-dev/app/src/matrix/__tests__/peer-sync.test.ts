/**
 * PeerSync hooks — chainSeg (V8) + bulkApply (V3) from
 * HELIX-AUDIT-2026-05-11.md.
 *
 * V8: `start()` awaits the host-provided chainSeg before announcing
 *     presence. Verifies the SEG always runs once per space mount even
 *     when the UI shell forgets to trigger hydrateBlocksIfStale.
 *
 * V3: Incoming SYNC_EVENTS batches go through bulkApply (the chunked,
 *     worker-pooled fold path) when wired, instead of the per-event
 *     processEvent loop that used to pin the main thread on large
 *     gap-fill batches.
 *
 * The tests do not exercise encryption — peerSync supports a legacy
 * `unencrypted` payload path that we use here, keeping the mocks small.
 */

import { describe, it, expect, vi } from 'vitest';
import { PeerSync } from '../peer-sync';
import { peerSyncEventTypes } from '../../lib/matrix-domain';
import type { EoStore, IteratorOpts } from '../../db/encrypted-store';
import type { EoEventInput } from '../../db/types';

const SYNC_EVENTS_TYPE = peerSyncEventTypes().events;

function makeStubStore(): EoStore {
  const data = new Map<string, unknown>();
  return {
    async get(k: string) { return data.has(k) ? data.get(k) : null; },
    async put(k: string, v: unknown) { data.set(k, v); },
    async del(k: string) { data.delete(k); },
    async iterator(prefix: string, _opts?: IteratorOpts) {
      const out: [string, unknown][] = [];
      for (const [k, v] of data) if (k.startsWith(prefix)) out.push([k, v]);
      return out;
    },
    async getCurrentSeq() { return 0; },
    async close() { /* noop */ },
  } as unknown as EoStore;
}

interface MockListenerBag {
  toDeviceEvent: ((event: any) => void) | null;
}

function makeStubClient(opts: { joinedMembers?: Array<{ userId: string }> } = {}) {
  const listeners: MockListenerBag = { toDeviceEvent: null };
  const sendToDevice = vi.fn(async () => undefined);
  const removeListener = vi.fn();
  return {
    listeners,
    sendToDevice,
    removeListener,
    on(kind: string, listener: (event: any) => void) {
      if (kind === 'toDeviceEvent') listeners.toDeviceEvent = listener;
    },
    getRoom() {
      return {
        getJoinedMembers: () => opts.joinedMembers ?? [],
      };
    },
    getUserId: () => '@me:t',
    getDeviceId: () => 'dev-me',
  } as any;
}

function makeIncomingEventsMessage(events: EoEventInput[]) {
  return {
    getType: () => SYNC_EVENTS_TYPE,
    getContent: () => ({ events, room_id: '!room:t' }),
    getSender: () => '@peer:t',
  };
}

describe('PeerSync hooks', () => {
  describe('chainSeg (V8)', () => {
    it('start() awaits chainSeg before announcing presence', async () => {
      const order: string[] = [];
      const client = makeStubClient({
        joinedMembers: [{ userId: '@peer:t' }],
      });
      client.sendToDevice = vi.fn(async () => { order.push('sendToDevice'); });

      let resolveSeg: () => void = () => {};
      const segPromise = new Promise<void>((r) => { resolveSeg = r; });
      const chainSeg = vi.fn(async () => {
        order.push('chainSeg-start');
        await segPromise;
        order.push('chainSeg-end');
      });

      const ps = new PeerSync(
        client,
        '!room:t',
        makeStubStore(),
        undefined,
        undefined,
        undefined,
        chainSeg,
      );

      const startPromise = ps.start();

      // Let microtasks run so chainSeg is invoked. announceToPeers
      // should NOT have fired yet — it's gated behind the SEG.
      await Promise.resolve();
      await Promise.resolve();
      expect(chainSeg).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['chainSeg-start']);
      expect(client.sendToDevice).not.toHaveBeenCalled();

      // Resolve the SEG; announce must follow.
      resolveSeg();
      await startPromise;
      expect(order[0]).toBe('chainSeg-start');
      expect(order[1]).toBe('chainSeg-end');
      expect(order.slice(2).every((e) => e === 'sendToDevice')).toBe(true);
      expect(client.sendToDevice).toHaveBeenCalled();

      ps.stop();
    });

    it('start() proceeds even if chainSeg rejects', async () => {
      const client = makeStubClient({ joinedMembers: [{ userId: '@peer:t' }] });
      const chainSeg = vi.fn(async () => { throw new Error('homeserver down'); });

      const ps = new PeerSync(
        client,
        '!room:t',
        makeStubStore(),
        undefined,
        undefined,
        undefined,
        chainSeg,
      );

      await expect(ps.start()).resolves.toBeUndefined();
      expect(chainSeg).toHaveBeenCalledTimes(1);
      // Announce still fires — peer-sync is not blocked by a failed SEG.
      expect(client.sendToDevice).toHaveBeenCalled();

      ps.stop();
    });

    it('omitting chainSeg keeps behavior identical to pre-V8', async () => {
      const client = makeStubClient({ joinedMembers: [{ userId: '@peer:t' }] });
      const ps = new PeerSync(client, '!room:t', makeStubStore());

      await ps.start();
      expect(client.sendToDevice).toHaveBeenCalled();

      ps.stop();
    });
  });

  describe('bulkApply (V3)', () => {
    it('routes incoming SYNC_EVENTS through bulkApply when wired', async () => {
      const client = makeStubClient();
      const bulkApply = vi.fn(async (_events: EoEventInput[]) => undefined);

      const ps = new PeerSync(
        client,
        '!room:t',
        makeStubStore(),
        undefined,
        undefined,
        bulkApply,
      );
      await ps.start();

      const events: EoEventInput[] = [
        { op: 'INS', target: 't.r1', operand: 1, agent: '@p:t', ts: '2026-01-01T00:00:00Z', acquired_ts: '2026-01-01T00:00:00Z', client_event_id: 'ev:1' },
        { op: 'INS', target: 't.r2', operand: 2, agent: '@p:t', ts: '2026-01-01T00:00:00Z', acquired_ts: '2026-01-01T00:00:00Z', client_event_id: 'ev:2' },
      ];

      // Push a fake to-device message through the registered handler.
      client.listeners.toDeviceEvent!(makeIncomingEventsMessage(events));
      // Wait for the serialization chain to settle.
      await ps.drainHandlers();

      expect(bulkApply).toHaveBeenCalledTimes(1);
      const handed = bulkApply.mock.calls[0][0];
      expect(handed.map((e) => e.client_event_id)).toEqual(['ev:1', 'ev:2']);

      ps.stop();
    });

    it('setBulkApply swaps the hook after construction', async () => {
      const client = makeStubClient();
      const ps = new PeerSync(client, '!room:t', makeStubStore());
      await ps.start();

      const lateBulkApply = vi.fn(async () => undefined);
      ps.setBulkApply(lateBulkApply);

      const events: EoEventInput[] = [
        { op: 'INS', target: 't.r1', operand: 1, agent: '@p:t', ts: '2026-01-01T00:00:00Z', acquired_ts: '2026-01-01T00:00:00Z', client_event_id: 'ev:late' },
      ];
      client.listeners.toDeviceEvent!(makeIncomingEventsMessage(events));
      await ps.drainHandlers();

      expect(lateBulkApply).toHaveBeenCalledTimes(1);
      ps.stop();
    });
  });
});
