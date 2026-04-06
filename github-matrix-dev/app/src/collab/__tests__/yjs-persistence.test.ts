/**
 * Yjs persistence tests — verify load/save roundtrip through IndexedDB (via EoStore).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { EoStore } from '../../db/encrypted-store';
import { loadYjsDoc, saveYjsDocLocal } from '../yjs-persistence';

/**
 * In-memory store for testing — same pattern as fold.test.ts.
 */
function createTestStore(): EoStore {
  const data = new Map<string, any>();
  let seq = 0;

  return {
    async get(key: string) {
      return data.has(key) ? data.get(key) : null;
    },
    async put(key: string, value: any) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
    async iterator(prefix: string) {
      const results: [string, any][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') {
          results.push([key, value]);
        }
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      return results;
    },
    async nextSeq() {
      seq += 1;
      data.set('meta:seq', seq);
      return seq;
    },
    async getCurrentSeq() {
      return seq;
    },
    close() {},
  };
}

describe('yjs-persistence', () => {
  let store: EoStore;
  const TARGET = 'app.tblNotes.rec001';
  const FIELD = 'fldBody';

  beforeEach(() => {
    store = createTestStore();
  });

  it('loads an empty doc when no state exists', async () => {
    const doc = await loadYjsDoc(store, TARGET, FIELD);
    expect(doc).toBeDefined();
    const text = doc.getText('default');
    expect(text.toString()).toBe('');
    doc.destroy();
  });

  it('roundtrips Yjs document state through IndexedDB', async () => {
    // Create a doc with some content
    const doc1 = new Y.Doc();
    const text1 = doc1.getText('default');
    text1.insert(0, 'Hello, collaborative world!');

    // Save to store
    await saveYjsDocLocal(doc1, store, TARGET, FIELD);

    // Load into a new doc
    const doc2 = await loadYjsDoc(store, TARGET, FIELD);
    const text2 = doc2.getText('default');
    expect(text2.toString()).toBe('Hello, collaborative world!');

    doc1.destroy();
    doc2.destroy();
  });

  it('preserves complex document structure', async () => {
    const doc1 = new Y.Doc();
    const text = doc1.getText('default');
    text.insert(0, 'First line\n');
    text.insert(11, 'Second line\n');
    text.insert(23, 'Third line');

    await saveYjsDocLocal(doc1, store, TARGET, FIELD);

    const doc2 = await loadYjsDoc(store, TARGET, FIELD);
    const text2 = doc2.getText('default');
    expect(text2.toString()).toBe('First line\nSecond line\nThird line');

    doc1.destroy();
    doc2.destroy();
  });

  it('stores raw binary in IndexedDB (not DEF operand)', async () => {
    const doc = new Y.Doc();
    doc.getText('default').insert(0, 'test');

    await saveYjsDocLocal(doc, store, TARGET, FIELD);

    // Verify raw value is a Uint8Array, not a DEF operand object
    const raw = await store.get(`yjs:${TARGET}:${FIELD}`);
    expect(raw).toBeInstanceOf(Uint8Array);

    doc.destroy();
  });

  it('merges concurrent edits via CRDT', async () => {
    // Simulate two users editing concurrently
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    const text1 = doc1.getText('default');
    const text2 = doc2.getText('default');

    // User 1 types at the start
    text1.insert(0, 'Hello ');
    // User 2 types at position 0 (concurrent — no sync yet)
    text2.insert(0, 'World');

    // Merge: apply doc1's state to doc2 and vice versa
    const state1 = Y.encodeStateAsUpdate(doc1);
    const state2 = Y.encodeStateAsUpdate(doc2);
    Y.applyUpdate(doc1, state2);
    Y.applyUpdate(doc2, state1);

    // Both docs should converge to the same content
    expect(doc1.getText('default').toString()).toBe(doc2.getText('default').toString());

    // Save and reload — result should still match
    await saveYjsDocLocal(doc1, store, TARGET, FIELD);
    const doc3 = await loadYjsDoc(store, TARGET, FIELD);
    expect(doc3.getText('default').toString()).toBe(doc1.getText('default').toString());

    doc1.destroy();
    doc2.destroy();
    doc3.destroy();
  });
});
