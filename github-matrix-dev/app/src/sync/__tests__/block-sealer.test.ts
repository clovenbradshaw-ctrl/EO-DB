/**
 * block-sealer tests — header round-trip and event payload integrity.
 *
 * We exercise the pure-functional pieces (buildBlockBytes,
 * collectTailEvents) without standing up a real Matrix client. The
 * full sealNextBlock pipeline is covered by end-to-end manual checks
 * documented in the plan; here we verify that:
 *   1. A sealed payload round-trips via EodbStreamReader.
 *   2. Header carries blockIndex + priorBlockEventId + schemaVersion.
 *   3. Tail collection filters on EO_EVENT_TYPE and respects the cutoff.
 */

import { describe, it, expect } from 'vitest';
import { buildBlockBytes, collectTailEvents, BLOCK_SCHEMA_VERSION } from '../block-sealer';
import { EodbStreamReader, FRAME_TYPES } from '../../db/eodb';
import { EO_EVENT_TYPE } from '../../matrix/event-bridge';
import type { EoEventInput } from '../../db/types';

function makeEvent(seq: number): EoEventInput {
  return {
    op: 'INS',
    target: `app.tbl.rec${seq}`,
    operand: { value: seq },
    agent: '@u:test',
    ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    acquired_ts: `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`,
    client_event_id: `ev:${seq.toString(16).padStart(8, '0')}`,
  };
}

describe('block-sealer', () => {
  describe('buildBlockBytes', () => {
    it('round-trips events through EodbStreamReader', async () => {
      const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
      const bytes = await buildBlockBytes({
        collectionId: 'col-A',
        blockIndex: 7,
        priorBlockEventId: '$prev',
        schemaVersion: BLOCK_SCHEMA_VERSION,
        events,
      });

      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes); c.close(); },
      });
      const reader = new EodbStreamReader(stream);
      const header = await reader.readHeader();
      expect(header.blockIndex).toBe(7);
      expect(header.priorBlockEventId).toBe('$prev');
      expect(header.schemaVersion).toBe(BLOCK_SCHEMA_VERSION);

      let frame = await reader.readNextFrame();
      const collected: EoEventInput[] = [];
      while (frame) {
        if (frame.type === FRAME_TYPES.LOG_SEGMENT) {
          const { unpack } = await import('msgpackr');
          collected.push(...(unpack(frame.payload) as EoEventInput[]));
        }
        if (frame.type === FRAME_TYPES.TRAILER) break;
        frame = await reader.readNextFrame();
      }
      expect(collected.length).toBe(3);
      expect(collected[0].target).toBe('app.tbl.rec1');
      expect(collected[2].target).toBe('app.tbl.rec3');
    });

    it('produces a valid empty-genesis block', async () => {
      const bytes = await buildBlockBytes({
        collectionId: 'col-A',
        blockIndex: 0,
        priorBlockEventId: null,
        schemaVersion: BLOCK_SCHEMA_VERSION,
        events: [],
      });

      const stream = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(bytes); c.close(); },
      });
      const reader = new EodbStreamReader(stream);
      const header = await reader.readHeader();
      expect(header.blockIndex).toBe(0);
      expect(header.priorBlockEventId).toBeNull();
    });
  });

  describe('collectTailEvents', () => {
    function mockMatrixClient(timeline: Array<{ id: string; type: string; content: any }>) {
      const events = timeline.map((t) => ({
        getId: () => t.id,
        getType: () => t.type,
        getContent: () => t.content,
        getSender: () => '@u:test',
        getTs: () => 1700000000000,
      }));
      const room = {
        getLiveTimeline: () => ({ getEvents: () => events }),
      };
      return { getRoom: (_: string) => room } as any;
    }

    it('returns every EO event when cutoff is null', () => {
      const client = mockMatrixClient([
        { id: '$1', type: EO_EVENT_TYPE, content: { op: 'INS', target: 't1', operand: 1, client_event_id: 'a' } },
        { id: '$2', type: 'm.room.message', content: { body: 'hi' } },
        { id: '$3', type: EO_EVENT_TYPE, content: { op: 'INS', target: 't2', operand: 2, client_event_id: 'b' } },
      ]);
      const out = collectTailEvents(client, '!room', null);
      expect(out.events.length).toBe(2);
      expect(out.matrixEventIds).toEqual(['$1', '$3']);
    });

    it('skips events up to and including cutoff', () => {
      const client = mockMatrixClient([
        { id: '$1', type: EO_EVENT_TYPE, content: { op: 'INS', target: 't1', operand: 1, client_event_id: 'a' } },
        { id: '$2', type: EO_EVENT_TYPE, content: { op: 'INS', target: 't2', operand: 2, client_event_id: 'b' } },
        { id: '$3', type: EO_EVENT_TYPE, content: { op: 'INS', target: 't3', operand: 3, client_event_id: 'c' } },
      ]);
      const out = collectTailEvents(client, '!room', '$2');
      expect(out.events.length).toBe(1);
      expect(out.matrixEventIds).toEqual(['$3']);
    });

    it('returns empty when cutoff is the latest event', () => {
      const client = mockMatrixClient([
        { id: '$1', type: EO_EVENT_TYPE, content: { op: 'INS', target: 't1', operand: 1, client_event_id: 'a' } },
      ]);
      const out = collectTailEvents(client, '!room', '$1');
      expect(out.events.length).toBe(0);
    });
  });
});
