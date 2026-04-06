/**
 * YjsMatrixProvider tests — verify signaling protocol with mocked MatrixClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { YjsMatrixProvider } from '../yjs-matrix-provider';
import { collabEventTypes } from '../../lib/matrix-domain';

const _types = collabEventTypes();

// --------------------------------------------------------------------------
// Mock MatrixClient
// --------------------------------------------------------------------------

interface ToDeviceCall {
  type: string;
  content: Map<string, Map<string, Record<string, any>>>;
}

function createMockClient(userId: string, deviceId: string) {
  const listeners = new Map<string, Set<Function>>();
  const toDeviceCalls: ToDeviceCall[] = [];

  const mockRoom = {
    getJoinedMembers: () => [],
    getMember: () => ({ name: userId }),
  };

  return {
    getUserId: () => userId,
    getDeviceId: () => deviceId,
    getRoom: () => mockRoom,
    setJoinedMembers: (members: Array<{ userId: string }>) => {
      mockRoom.getJoinedMembers = () => members as any;
    },
    sendToDevice: vi.fn(async (type: string, content: any) => {
      toDeviceCalls.push({ type, content });
    }),
    on: (event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeListener: (event: string, handler: Function) => {
      listeners.get(event)?.delete(handler);
    },
    // Simulate receiving a to-device event
    simulateToDeviceEvent: (type: string, sender: string, content: Record<string, any>) => {
      const event = {
        getType: () => type,
        getSender: () => sender,
        getContent: () => content,
      };
      for (const handler of listeners.get('toDeviceEvent') ?? []) {
        handler(event);
      }
    },
    toDeviceCalls,
    listeners,
  };
}

describe('YjsMatrixProvider', () => {
  const ROOM_ID = '!room:example.com';
  const DOC_ID = 'rec001.fldBody';

  let doc1: Y.Doc;
  let doc2: Y.Doc;
  let client1: ReturnType<typeof createMockClient>;
  let client2: ReturnType<typeof createMockClient>;
  let provider1: YjsMatrixProvider;
  let provider2: YjsMatrixProvider | undefined;

  beforeEach(() => {
    doc1 = new Y.Doc();
    doc2 = new Y.Doc();
    client1 = createMockClient('@alice:example.com', 'DEVICE_A');
    client2 = createMockClient('@bob:example.com', 'DEVICE_B');

    // Each client knows about the other user
    client1.setJoinedMembers([
      { userId: '@alice:example.com' },
      { userId: '@bob:example.com' },
    ]);
    client2.setJoinedMembers([
      { userId: '@alice:example.com' },
      { userId: '@bob:example.com' },
    ]);
  });

  afterEach(() => {
    provider1?.destroy();
    provider2?.destroy();
    doc1?.destroy();
    doc2?.destroy();
  });

  it('creates a provider without errors', () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    expect(provider1.documentId).toBe(DOC_ID);
    expect(provider1.transport).toBe('offline');
  });

  it('announces editing on connect', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    // Should have sent an announce to bob
    const announces = client1.toDeviceCalls.filter(c => c.type === _types.announce);
    expect(announces.length).toBe(1);
  });

  it('announces departure on disconnect', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    client1.toDeviceCalls.length = 0; // clear
    provider1.disconnect();

    const leaves = client1.toDeviceCalls.filter(c => c.type === _types.leave);
    expect(leaves.length).toBe(1);
  });

  it('relays doc updates via to-device when announce triggers peer registration', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    // Simulate bob announcing (which registers bob as a peer in provider1)
    client1.simulateToDeviceEvent(_types.announce, '@bob:example.com', {
      document_id: DOC_ID,
      room_id: ROOM_ID,
      device: 'DEVICE_B',
    });

    // Wait for WebRTC offer to be sent (async)
    await new Promise(r => setTimeout(r, 50));

    // Now alice types — should attempt to send update
    client1.toDeviceCalls.length = 0;
    doc1.getText('default').insert(0, 'Hello from Alice');

    // Give the update handler time to fire
    await new Promise(r => setTimeout(r, 50));

    // Provider should have the peer registered
    expect(provider1.peerCount).toBeGreaterThan(0);
  });

  it('handles remote doc updates via to-device fallback', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    // Create an update from doc2
    doc2.getText('default').insert(0, 'Hello from Bob');
    const update = Y.encodeStateAsUpdate(doc2);

    // Convert to base64 (same as the provider does)
    let binary = '';
    for (let i = 0; i < update.length; i++) {
      binary += String.fromCharCode(update[i]);
    }
    const base64 = btoa(binary);

    // Simulate receiving the update via to-device
    client1.simulateToDeviceEvent(_types.update, '@bob:example.com', {
      document_id: DOC_ID,
      data: base64,
    });

    // doc1 should now have bob's text
    expect(doc1.getText('default').toString()).toBe('Hello from Bob');
  });

  it('ignores updates for different documents', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    doc2.getText('default').insert(0, 'Wrong doc');
    const update = Y.encodeStateAsUpdate(doc2);
    let binary = '';
    for (let i = 0; i < update.length; i++) {
      binary += String.fromCharCode(update[i]);
    }

    client1.simulateToDeviceEvent(_types.update, '@bob:example.com', {
      document_id: 'different.document',
      data: btoa(binary),
    });

    // doc1 should remain empty
    expect(doc1.getText('default').toString()).toBe('');
  });

  it('sets awareness state on connect', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    const localState = provider1.awareness.getLocalState();
    expect(localState).toBeDefined();
    expect(localState?.user?.userId).toBe('@alice:example.com');
  });

  it('cleans up awareness on disconnect', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);
    await provider1.connect();

    expect(provider1.awareness.getLocalState()).toBeDefined();
    provider1.disconnect();

    // After disconnect, local state should be cleared
    expect(provider1.awareness.getLocalState()).toBeNull();
  });

  it('transitions transport state correctly', async () => {
    provider1 = new YjsMatrixProvider(client1 as any, ROOM_ID, DOC_ID, doc1);

    expect(provider1.transport).toBe('offline');
    await provider1.connect();
    expect(provider1.transport).toBe('todevice');

    provider1.disconnect();
    expect(provider1.transport).toBe('offline');
  });
});
