/**
 * Tests for Matrix sync modules: event-bridge, snapshot, sync-manager,
 * peer-sync, space-discovery, room-topology.
 *
 * Uses mock Matrix client implementations to test the full sync lifecycle
 * without a real homeserver.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, type EoDb, getCurrentSeq, encode, decode } from '../src/db/level.js';
import { processEvent } from '../src/db/fold.js';
import { readLogSince } from '../src/db/log.js';
import { getState } from '../src/db/state.js';
import { eventHash, storeFingerprint } from '../src/db/hash.js';
import type { EoEventInput, EoEvent } from '../src/db/types.js';
import type {
  IMatrixClient,
  IMatrixEvent,
  IRoom,
  IRoomState,
  ITimeline,
  IRoomMember,
  DeltaSnapshot,
  SpaceConfig,
} from '../src/matrix/types.js';
import { sendEoEvent, matrixEventToEo, EO_EVENT_TYPE, EO_SPACE_CONFIG_TYPE, EO_SNAPSHOT_CLAIM_TYPE } from '../src/matrix/event-bridge.js';
import {
  createDeltaSnapshot,
  SNAPSHOT_FREQUENCY,
  SNAPSHOT_CLAIM_TTL_MS,
  isClaimStale,
  readSnapshotClaim,
  tryClaimSnapshotLease,
  recordSnapshotClaimResult,
} from '../src/matrix/snapshot.js';
import type { SnapshotClaim } from '../src/matrix/types.js';
import { SyncManager } from '../src/matrix/sync-manager.js';
import { PeerSync } from '../src/matrix/peer-sync.js';
import { discoverSpacesFromMatrix } from '../src/matrix/space-discovery.js';
import {
  assignFieldToRoom,
  removeFieldAssignment,
} from '../src/matrix/room-topology.js';
import { rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pack, unpack } from 'msgpackr';

// ─── Test helpers ──────────────────────────────────────────────────────────

const AGENT = '@alice:example.com';
const TS = '2025-06-01T00:00:00.000Z';
const ROOM_ID = '!room:example.com';

let db: EoDb;
let dbPath: string;

function ev(overrides: Partial<EoEventInput> = {}): EoEventInput {
  return {
    op: 'INS',
    target: 'app.tbl.rec1',
    operand: {},
    agent: AGENT,
    ts: TS,
    acquired_ts: TS,
    ...overrides,
  };
}

// ─── Mock Matrix Client ────────────────────────────────────────────────────

function createMockMatrixEvent(content: Record<string, any>, opts?: {
  type?: string;
  sender?: string;
  roomId?: string;
  ts?: number;
  stateKey?: string;
  eventId?: string;
}): IMatrixEvent {
  return {
    getType: () => opts?.type || EO_EVENT_TYPE,
    getContent: () => content,
    getSender: () => opts?.sender || AGENT,
    getRoomId: () => opts?.roomId || ROOM_ID,
    getId: () => opts?.eventId || '$event1',
    getTs: () => opts?.ts || Date.now(),
    getStateKey: () => opts?.stateKey ?? null,
  };
}

function createMockRoom(opts?: {
  roomId?: string;
  events?: IMatrixEvent[];
  stateEvents?: Map<string, Map<string, IMatrixEvent>>;
  members?: IRoomMember[];
  name?: string;
}): IRoom {
  const roomId = opts?.roomId || ROOM_ID;
  const events = opts?.events || [];
  const members = opts?.members || [{ userId: AGENT, name: 'Alice', membership: 'join' }];

  const stateEventsMap = opts?.stateEvents || new Map();
  const state: IRoomState = {
    getStateEvents: (type: string, stateKey: string) => {
      const typeMap = stateEventsMap.get(type);
      if (!typeMap) return null;
      return typeMap.get(stateKey) || null;
    },
    events: stateEventsMap,
  };

  return {
    roomId,
    name: opts?.name || 'Test Room',
    currentState: state,
    getLiveTimeline: () => ({
      getEvents: () => events,
    }),
    getJoinedMembers: () => members,
  };
}

interface MockClientOpts {
  userId?: string;
  deviceId?: string;
  rooms?: IRoom[];
  sentEvents?: Array<{ roomId: string; type: string; content: any }>;
  uploadedContent?: Array<{ data: Uint8Array; name: string }>;
  sentToDevice?: Array<{ type: string; content: any }>;
}

function createMockClient(opts?: MockClientOpts): IMatrixClient & { _sent: any[]; _uploads: any[]; _toDevice: any[]; _listeners: Map<string, Function[]> } {
  const sent: any[] = opts?.sentEvents || [];
  const uploads: any[] = opts?.uploadedContent || [];
  const toDevice: any[] = opts?.sentToDevice || [];
  const rooms = opts?.rooms || [];
  const listeners = new Map<string, Function[]>();

  return {
    _sent: sent,
    _uploads: uploads,
    _toDevice: toDevice,
    _listeners: listeners,

    getUserId: () => opts?.userId || AGENT,
    getDeviceId: () => opts?.deviceId || 'DEVICE1',

    getRoom: (roomId: string) => rooms.find(r => r.roomId === roomId) || null,
    getRooms: () => rooms,

    sendEvent: async (roomId, eventType, content) => {
      sent.push({ roomId, type: eventType, content });
      return { event_id: `$evt_${sent.length}` };
    },
    sendStateEvent: async (roomId, eventType, content, _stateKey) => {
      sent.push({ roomId, type: eventType, content, stateKey: _stateKey });
      // Reflect the write into room state so subsequent reads see it.
      const room = rooms.find(r => r.roomId === roomId);
      if (room) {
        const stateMap = room.currentState.events as Map<string, Map<string, IMatrixEvent>>;
        if (stateMap instanceof Map) {
          let typeMap = stateMap.get(eventType);
          if (!typeMap) { typeMap = new Map(); stateMap.set(eventType, typeMap); }
          typeMap.set(_stateKey, createMockMatrixEvent(content, {
            type: eventType,
            stateKey: _stateKey,
            eventId: `$state_${sent.length}`,
          }));
        }
      }
      return { event_id: `$state_${sent.length}` };
    },
    sendToDevice: async (eventType, contentMap) => {
      toDevice.push({ type: eventType, contentMap });
    },

    uploadContent: async (data, uploadOpts) => {
      uploads.push({ data, name: uploadOpts.name });
      return { content_uri: `mxc://example.com/upload_${uploads.length}` };
    },
    mxcUrlToHttp: (mxcUrl) => mxcUrl ? `https://example.com/_matrix/media/${mxcUrl.replace('mxc://', '')}` : null,

    createRoom: async (createOpts) => ({ room_id: `!new_${Math.random().toString(36).slice(2)}:example.com` }),
    invite: async () => {},
    kick: async () => {},
    setPowerLevel: async () => {},
    getRoomIdForAlias: async () => ({ room_id: ROOM_ID }),

    paginateEventTimeline: async () => false,

    on: (event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      const list = listeners.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    removeListener: (event: string, handler: (...args: any[]) => void) => {
      const list = listeners.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
  };
}

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(async () => {
  dbPath = mkdtempSync(join(tmpdir(), 'eo-matrix-sync-test-'));
  db = createDb(dbPath);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Event Bridge
// ═══════════════════════════════════════════════════════════════════════════

describe('Event Bridge', () => {
  it('sendEoEvent sends event without agent field', async () => {
    const client = createMockClient({ rooms: [createMockRoom()] });
    const event = ev({ client_event_id: 'test-id' });

    await sendEoEvent(client, ROOM_ID, event);

    expect(client._sent).toHaveLength(1);
    const sent = client._sent[0];
    expect(sent.content.op).toBe('INS');
    expect(sent.content.target).toBe('app.tbl.rec1');
    expect(sent.content.client_event_id).toBe('test-id');
    // Agent must NOT be in the content (security invariant)
    expect(sent.content.agent).toBeUndefined();
  });

  it('matrixEventToEo derives agent from sender, not content', () => {
    const matrixEvent = createMockMatrixEvent(
      { op: 'DEF', target: 'a.b', operand: { x: 1 }, ts: TS, agent: '@mallory:evil.com' },
      { sender: '@alice:example.com' },
    );

    const eoEvent = matrixEventToEo(matrixEvent);

    expect(eoEvent.agent).toBe('@alice:example.com');
    expect(eoEvent.op).toBe('DEF');
    expect(eoEvent.target).toBe('a.b');
  });

  it('matrixEventToEo uses Matrix timestamp as fallback', () => {
    const matrixEvent = createMockMatrixEvent(
      { op: 'INS', target: 'a.b', operand: {} },
      { ts: 1717200000000 },
    );

    const eoEvent = matrixEventToEo(matrixEvent);
    expect(eoEvent.ts).toBeDefined();
    expect(eoEvent.acquired_ts).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot
// ═══════════════════════════════════════════════════════════════════════════

describe('Delta Snapshot', () => {
  it('createDeltaSnapshot captures events since last snapshot', async () => {
    // Insert some events
    await processEvent(db, ev({ target: 'snap.a', operand: { v: 1 } }));
    await processEvent(db, ev({ target: 'snap.b', operand: { v: 2 } }));
    await processEvent(db, ev({ target: 'snap.a', op: 'DEF', operand: { v: 3 } }));

    const delta = await createDeltaSnapshot(db, AGENT);

    expect(delta.version).toBe(2);
    expect(delta.type).toBe('delta');
    expect(delta.from_seq).toBe(0);
    expect(delta.to_seq).toBe(3);
    expect(delta.events).toHaveLength(3);
    expect(delta.created_by).toBe(AGENT);
    expect(delta.prev_mxcs).toEqual([]);
  });

  it('delta snapshot only captures events after last snapshot seq', async () => {
    await processEvent(db, ev({ target: 'snap.x', operand: { v: 1 } }));
    await processEvent(db, ev({ target: 'snap.y', operand: { v: 2 } }));

    // Simulate a previous snapshot at seq 1
    await db.put('meta:snapshot_seq', encode(1));

    await processEvent(db, ev({ target: 'snap.z', operand: { v: 3 } }));

    const delta = await createDeltaSnapshot(db, AGENT);

    expect(delta.from_seq).toBe(1);
    expect(delta.to_seq).toBe(3);
    expect(delta.events).toHaveLength(2); // only events after seq 1
  });

  it('delta snapshot carries prev_mxcs from store', async () => {
    const prevMxcs = ['mxc://a/1', 'mxc://a/2', 'mxc://a/3'];
    await db.put('meta:snapshot_prev_mxcs', encode(prevMxcs));

    await processEvent(db, ev({ target: 'snap.p', operand: {} }));

    const delta = await createDeltaSnapshot(db, AGENT);
    expect(delta.prev_mxcs).toEqual(prevMxcs);
  });

  it('snapshot frequency constant is 256', () => {
    expect(SNAPSHOT_FREQUENCY).toBe(256);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot Claim Lease
// ═══════════════════════════════════════════════════════════════════════════

describe('Snapshot Claim Lease', () => {
  const MY_DEVICE = 'DEVICE_A';
  const MY_USER = '@alice:example.com';
  const OTHER_DEVICE = 'DEVICE_B';
  const OTHER_USER = '@bob:example.com';

  function claimStateMap(claim: SnapshotClaim | null): Map<string, Map<string, IMatrixEvent>> {
    const map = new Map<string, Map<string, IMatrixEvent>>();
    if (claim) {
      const inner = new Map<string, IMatrixEvent>();
      inner.set('', createMockMatrixEvent(claim as any, {
        type: EO_SNAPSHOT_CLAIM_TYPE,
        stateKey: '',
      }));
      map.set(EO_SNAPSHOT_CLAIM_TYPE, inner);
    }
    return map;
  }

  it('isClaimStale returns false for terminal claims regardless of age', () => {
    const old: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - 10 * 60 * 1000,
      target_seq: 100,
      status: 'success',
    };
    expect(isClaimStale(old)).toBe(false);
  });

  it('isClaimStale returns true for pending claim older than TTL', () => {
    const stale: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - (SNAPSHOT_CLAIM_TTL_MS + 1000),
      target_seq: 100,
      status: 'pending',
    };
    expect(isClaimStale(stale)).toBe(true);
  });

  it('isClaimStale returns false for fresh pending claim', () => {
    const fresh: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - 30_000,
      target_seq: 100,
      status: 'pending',
    };
    expect(isClaimStale(fresh)).toBe(false);
  });

  it('tryClaimSnapshotLease wins on empty room', async () => {
    const room = createMockRoom({ stateEvents: claimStateMap(null) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    const won = await tryClaimSnapshotLease(client, ROOM_ID, 500, MY_DEVICE, MY_USER);
    expect(won).toBe(true);
    // pending claim written with our device_id
    const stateWrite = client._sent.find((e: any) => e.type === EO_SNAPSHOT_CLAIM_TYPE);
    expect(stateWrite).toBeTruthy();
    expect(stateWrite.content.device_id).toBe(MY_DEVICE);
    expect(stateWrite.content.status).toBe('pending');
    expect(stateWrite.content.target_seq).toBe(500);
    expect(stateWrite.stateKey).toBe('');
  });

  it('tryClaimSnapshotLease bails on fresh peer pending claim', async () => {
    const peerClaim: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - 30_000,
      target_seq: 500,
      status: 'pending',
    };
    const room = createMockRoom({ stateEvents: claimStateMap(peerClaim) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    const won = await tryClaimSnapshotLease(client, ROOM_ID, 500, MY_DEVICE, MY_USER);
    expect(won).toBe(false);
    // no claim write performed
    expect(client._sent.filter((e: any) => e.type === EO_SNAPSHOT_CLAIM_TYPE)).toHaveLength(0);
  });

  it('tryClaimSnapshotLease steals stale peer pending claim', async () => {
    const stale: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - (SNAPSHOT_CLAIM_TTL_MS + 60_000),
      target_seq: 400,
      status: 'pending',
    };
    const room = createMockRoom({ stateEvents: claimStateMap(stale) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    const won = await tryClaimSnapshotLease(client, ROOM_ID, 500, MY_DEVICE, MY_USER);
    expect(won).toBe(true);
  });

  it('tryClaimSnapshotLease claims when peer terminal success', async () => {
    const done: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - 10_000,
      target_seq: 400,
      status: 'success',
      completed_at: Date.now() - 5_000,
      completed_seq: 400,
      completed_mxc: 'mxc://example.com/prev',
    };
    const room = createMockRoom({ stateEvents: claimStateMap(done) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    const won = await tryClaimSnapshotLease(client, ROOM_ID, 700, MY_DEVICE, MY_USER);
    expect(won).toBe(true);
  });

  it('recordSnapshotClaimResult writes terminal success state', async () => {
    const mine: SnapshotClaim = {
      device_id: MY_DEVICE,
      user_id: MY_USER,
      claimed_at: Date.now() - 1_000,
      target_seq: 500,
      status: 'pending',
    };
    const room = createMockRoom({ stateEvents: claimStateMap(mine) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    await recordSnapshotClaimResult(client, ROOM_ID, MY_DEVICE, MY_USER, {
      status: 'success',
      target_seq: 500,
      completed_seq: 500,
      completed_mxc: 'mxc://example.com/new',
    });
    const write = client._sent.find((e: any) => e.type === EO_SNAPSHOT_CLAIM_TYPE);
    expect(write).toBeTruthy();
    expect(write.content.status).toBe('success');
    expect(write.content.completed_mxc).toBe('mxc://example.com/new');
    expect(write.content.completed_seq).toBe(500);
    expect(write.content.device_id).toBe(MY_DEVICE);
  });

  it('recordSnapshotClaimResult does not clobber a stolen claim', async () => {
    const stolen: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: Date.now() - 1_000,
      target_seq: 500,
      status: 'pending',
    };
    const room = createMockRoom({ stateEvents: claimStateMap(stolen) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    await recordSnapshotClaimResult(client, ROOM_ID, MY_DEVICE, MY_USER, {
      status: 'success',
      target_seq: 500,
      completed_seq: 500,
      completed_mxc: 'mxc://example.com/new',
    });
    expect(client._sent.filter((e: any) => e.type === EO_SNAPSHOT_CLAIM_TYPE)).toHaveLength(0);
  });

  it('readSnapshotClaim returns null when unset', () => {
    const room = createMockRoom({ stateEvents: claimStateMap(null) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    expect(readSnapshotClaim(client, ROOM_ID)).toBeNull();
  });

  it('readSnapshotClaim returns the current claim', () => {
    const peer: SnapshotClaim = {
      device_id: OTHER_DEVICE,
      user_id: OTHER_USER,
      claimed_at: 1234567890,
      target_seq: 100,
      status: 'pending',
    };
    const room = createMockRoom({ stateEvents: claimStateMap(peer) });
    const client = createMockClient({ rooms: [room], deviceId: MY_DEVICE, userId: MY_USER });
    const got = readSnapshotClaim(client, ROOM_ID);
    expect(got).toEqual(peer);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SyncManager
// ═══════════════════════════════════════════════════════════════════════════

describe('SyncManager', () => {
  it('processLocalEvent folds locally and sends to Matrix', async () => {
    const room = createMockRoom();
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);
    await sm.initialize();

    const seq = await sm.processLocalEvent({
      op: 'INS',
      target: 'sync.rec1',
      operand: { name: 'Test' },
    });

    expect(seq).toBe(1);

    // Event was folded locally
    const state = await getState(db, 'sync.rec1');
    expect(state).not.toBeNull();
    expect(state!.value).toEqual({ name: 'Test' });

    // Event is buffered in the SendBuffer; flush to trigger the Matrix upload
    await sm.flushSendBufferNow();

    // Event was sent to Matrix (via batched snapshot upload)
    expect(client._sent.length).toBeGreaterThanOrEqual(1);
  });

  it('processLocalEvent queues event when send fails', async () => {
    const room = createMockRoom();
    const client = createMockClient({ rooms: [room] });

    // Make sendEvent fail
    client.sendEvent = async () => { throw new Error('offline'); };

    const sm = new SyncManager(client, ROOM_ID, db);
    await sm.initialize();

    const seq = await sm.processLocalEvent({
      op: 'INS',
      target: 'sync.offline',
      operand: { v: 1 },
    });

    expect(seq).toBe(1);

    // Event was still folded locally
    const state = await getState(db, 'sync.offline');
    expect(state).not.toBeNull();

    // Event is buffered; flush triggers the upload which should fail
    await sm.flushSendBufferNow();

    // Send failed, so events remain buffered in the SendBuffer for retry
    const status = sm.getSendBufferStatus();
    expect(status.buffered).toBeGreaterThanOrEqual(1);
  });

  it('processLocalEvent generates deterministic client_event_id', async () => {
    const room = createMockRoom();
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);
    await sm.initialize();

    await sm.processLocalEvent({
      op: 'INS',
      target: 'sync.hash',
      operand: { name: 'Deterministic' },
    });

    const log = await readLogSince(db, 0);
    const event = log.find(e => e.target === 'sync.hash');
    expect(event?.client_event_id).toMatch(/^ev:[0-9a-f]{64}$/);
  });

  it('initialize replays timeline events into fold', async () => {
    // Pre-populate timeline events
    const timelineEvents = [
      createMockMatrixEvent(
        { op: 'INS', target: 'replay.a', operand: { v: 1 }, ts: TS, client_event_id: 'replay-1' },
        { sender: AGENT },
      ),
      createMockMatrixEvent(
        { op: 'INS', target: 'replay.b', operand: { v: 2 }, ts: TS, client_event_id: 'replay-2' },
        { sender: '@bob:example.com' },
      ),
    ];

    const room = createMockRoom({ events: timelineEvents });
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);
    await sm.initialize();

    // Events should have been replayed through fold
    const stateA = await getState(db, 'replay.a');
    const stateB = await getState(db, 'replay.b');
    expect(stateA).not.toBeNull();
    expect(stateB).not.toBeNull();
    expect(stateA!.value).toEqual({ v: 1 });
    expect(stateB!.value).toEqual({ v: 2 });
  });

  it('addRooms and removeRoom manage multi-room topology', async () => {
    const room = createMockRoom();
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);

    sm.addRooms(['!restricted:example.com', '!governance:example.com']);
    expect(sm.getRoomIds()).toEqual([
      ROOM_ID,
      '!restricted:example.com',
      '!governance:example.com',
    ]);

    sm.removeRoom('!restricted:example.com');
    expect(sm.getRoomIds()).toEqual([ROOM_ID, '!governance:example.com']);
  });

  it('addRooms deduplicates and ignores main room ID', async () => {
    const room = createMockRoom();
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);

    sm.addRooms([ROOM_ID, '!other:ex.com', '!other:ex.com']);
    expect(sm.getRoomIds()).toEqual([ROOM_ID, '!other:ex.com']);
  });

  it('destroy removes timeline listener and marks destroyed', async () => {
    const room = createMockRoom();
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);
    await sm.initialize();

    expect(client._listeners.get('Room.timeline')?.length).toBe(1);

    sm.destroy();
    expect(client._listeners.get('Room.timeline')?.length).toBe(0);
  });

  it('getRoomData returns room snapshot', async () => {
    const stateEvents = new Map<string, Map<string, IMatrixEvent>>();
    const room = createMockRoom({ stateEvents });
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);

    const data = sm.getRoomData();
    expect(data).not.toBeNull();
    expect(data!.roomId).toBe(ROOM_ID);
    expect(data!.memberCount).toBe(1);
  });

  it('incoming events skip space-prefixed targets', async () => {
    const timelineEvents = [
      createMockMatrixEvent(
        { op: 'DEF', target: 'space.config', operand: { name: 'test' }, ts: TS },
        { sender: AGENT },
      ),
    ];
    const room = createMockRoom({ events: timelineEvents });
    const client = createMockClient({ rooms: [room] });
    const sm = new SyncManager(client, ROOM_ID, db);
    await sm.initialize();

    const state = await getState(db, 'space.config');
    expect(state).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Space Discovery
// ═══════════════════════════════════════════════════════════════════════════

describe('Space Discovery', () => {
  it('discovers spaces from room state events', () => {
    const spaceConfig: SpaceConfig = {
      name: 'Amino',
      rooms: { main: '!main:example.com' },
      field_assignments: [],
      space_settings: {},
    };

    const stateEvents = new Map<string, Map<string, IMatrixEvent>>();
    stateEvents.set(EO_SPACE_CONFIG_TYPE, new Map([
      ['', createMockMatrixEvent(spaceConfig as any, {
        type: EO_SPACE_CONFIG_TYPE,
        stateKey: '',
      })],
    ]));
    stateEvents.set('m.room.create', new Map([
      ['', createMockMatrixEvent(
        { creator: AGENT },
        { type: 'm.room.create', stateKey: '', ts: 1000 },
      )],
    ]));
    stateEvents.set('m.room.power_levels', new Map([
      ['', createMockMatrixEvent(
        { users: { [AGENT]: 100 } },
        { type: 'm.room.power_levels', stateKey: '' },
      )],
    ]));

    const room = createMockRoom({ stateEvents });
    const client = createMockClient({ rooms: [room] });

    const spaces = discoverSpacesFromMatrix(client);

    expect(spaces).toHaveLength(1);
    expect(spaces[0].spaceTarget).toBe('space_amino');
    expect(spaces[0].displayName).toBe('Amino');
    expect(spaces[0].mainRoomId).toBe('!main:example.com');
    expect(spaces[0].ownerUserId).toBe(AGENT);
    expect(spaces[0].memberCount).toBe(1);
  });

  it('deduplicates spaces by spaceTarget', () => {
    const config1: SpaceConfig = {
      name: 'TestSpace',
      rooms: { main: '!main1:ex.com' },
      field_assignments: [],
      space_settings: {},
    };
    const config2: SpaceConfig = {
      name: 'TestSpace',
      rooms: { main: '!main2:ex.com' },
      field_assignments: [],
      space_settings: {},
    };

    const makeRoom = (config: SpaceConfig, roomId: string) => {
      const se = new Map<string, Map<string, IMatrixEvent>>();
      se.set(EO_SPACE_CONFIG_TYPE, new Map([
        ['', createMockMatrixEvent(config as any, { type: EO_SPACE_CONFIG_TYPE, stateKey: '' })],
      ]));
      return createMockRoom({ roomId, stateEvents: se });
    };

    const client = createMockClient({
      rooms: [makeRoom(config1, '!r1:ex.com'), makeRoom(config2, '!r2:ex.com')],
    });

    const spaces = discoverSpacesFromMatrix(client);
    expect(spaces).toHaveLength(1);
    expect(spaces[0].mainRoomId).toBe('!main1:ex.com'); // first wins
  });

  it('skips rooms without space config', () => {
    const room = createMockRoom(); // no state events
    const client = createMockClient({ rooms: [room] });

    const spaces = discoverSpacesFromMatrix(client);
    expect(spaces).toHaveLength(0);
  });

  it('sorts spaces by lastActivity descending', () => {
    const makeSpace = (name: string, roomId: string, ts: number) => {
      const se = new Map<string, Map<string, IMatrixEvent>>();
      se.set(EO_SPACE_CONFIG_TYPE, new Map([
        ['', createMockMatrixEvent(
          { name, rooms: { main: roomId }, field_assignments: [], space_settings: {} },
          { type: EO_SPACE_CONFIG_TYPE, stateKey: '' },
        )],
      ]));
      return createMockRoom({
        roomId,
        stateEvents: se,
        events: [createMockMatrixEvent({}, { ts })],
      });
    };

    const client = createMockClient({
      rooms: [
        makeSpace('Old', '!old:ex.com', 1000),
        makeSpace('New', '!new:ex.com', 3000),
        makeSpace('Mid', '!mid:ex.com', 2000),
      ],
    });

    const spaces = discoverSpacesFromMatrix(client);
    expect(spaces.map(s => s.displayName)).toEqual(['New', 'Mid', 'Old']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Room Topology (Field Assignments)
// ═══════════════════════════════════════════════════════════════════════════

describe('Room Topology — Field Assignments', () => {
  it('assignFieldToRoom adds a new field', () => {
    const result = assignFieldToRoom([], 'fldSSN', 'restricted');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ field: 'fldSSN', room: 'restricted', locked_to: undefined });
  });

  it('assignFieldToRoom updates existing field', () => {
    const existing = [{ field: 'fldSSN', room: 'main' as const }];
    const result = assignFieldToRoom(existing, 'fldSSN', 'restricted');
    expect(result).toHaveLength(1);
    expect(result[0].room).toBe('restricted');
  });

  it('removeFieldAssignment removes a field', () => {
    const existing = [
      { field: 'fldSSN', room: 'restricted' as const },
      { field: 'fldName', room: 'main' as const },
    ];
    const result = removeFieldAssignment(existing, 'fldSSN');
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('fldName');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Store Fingerprint (peer sync foundation)
// ═══════════════════════════════════════════════════════════════════════════

describe('Store Fingerprint', () => {
  it('identical states produce identical fingerprints', () => {
    const entries = [
      { target: 'a.b', last_seq: 1, hash: 'abc' },
      { target: 'c.d', last_seq: 2, hash: 'def' },
    ];
    const f1 = storeFingerprint(entries);
    const f2 = storeFingerprint([...entries]);
    expect(f1).toBe(f2);
  });

  it('different states produce different fingerprints', () => {
    const e1 = [{ target: 'a.b', last_seq: 1, hash: 'abc' }];
    const e2 = [{ target: 'a.b', last_seq: 2, hash: 'xyz' }];
    expect(storeFingerprint(e1)).not.toBe(storeFingerprint(e2));
  });

  it('same hash with different last_seq produces same fingerprint (hash takes precedence)', () => {
    const e1 = [{ target: 'a.b', last_seq: 1, hash: 'abc' }];
    const e2 = [{ target: 'a.b', last_seq: 2, hash: 'abc' }];
    // By design: fingerprint uses hash when available, so last_seq differences
    // with same transformation hash are considered equivalent state.
    expect(storeFingerprint(e1)).toBe(storeFingerprint(e2));
  });

  it('order-independent (sorted internally)', () => {
    const e1 = [
      { target: 'b', last_seq: 2, hash: 'y' },
      { target: 'a', last_seq: 1, hash: 'x' },
    ];
    const e2 = [
      { target: 'a', last_seq: 1, hash: 'x' },
      { target: 'b', last_seq: 2, hash: 'y' },
    ];
    expect(storeFingerprint(e1)).toBe(storeFingerprint(e2));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deduplication across sync paths
// ═══════════════════════════════════════════════════════════════════════════

describe('Cross-path Deduplication', () => {
  it('same event from local fold and incoming Matrix event deduplicates', async () => {
    // Simulate local fold
    const event: EoEventInput = ev({ target: 'dedup.a', operand: { v: 1 } });
    const seq1 = await processEvent(db, event);

    // Simulate the same event arriving from Matrix (different acquired_ts)
    const incoming: EoEventInput = {
      ...event,
      acquired_ts: '2025-06-01T00:01:00.000Z',
    };
    const seq2 = await processEvent(db, incoming);

    expect(seq1).toBe(seq2);

    const log = await readLogSince(db, 0);
    expect(log.filter(e => e.target === 'dedup.a')).toHaveLength(1);
  });
});
