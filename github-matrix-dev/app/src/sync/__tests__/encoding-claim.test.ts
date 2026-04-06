/**
 * Encoding claim tests — decision logic, claim protocol with tiebreaking,
 * encoding pipeline, and hydration flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shouldEncode,
  claimEncoding,
  performEncoding,
  hydrate,
  type EncodingClaim,
  type EncodingComplete,
  type EncodingMatrixClient,
  type EncodingFilenClient,
} from '../encoding-claim';
import type { EoStore } from '../../db/encrypted-store';
import { CardBuffer, fnv1a, type Card } from '../../db/card-encoder';

// ─── Test helpers ────────────────────────────────────────────────────────

function createTestStore(): EoStore {
  const data = new Map<string, any>();
  let seq = 100;
  return {
    async get(key: string) { return data.has(key) ? data.get(key) : null; },
    async put(key: string, value: any) { data.set(key, value); },
    async del(key: string) { data.delete(key); },
    async iterator(prefix: string) {
      const results: [string, any][] = [];
      for (const [key, value] of data.entries()) {
        if (key >= prefix && key <= prefix + '\uffff') results.push([key, value]);
      }
      results.sort((a, b) => a[0].localeCompare(b[0]));
      return results;
    },
    async nextSeq() { return ++seq; },
    async getCurrentSeq() { return seq; },
    close() {},
  } as EoStore;
}

function createMockMatrixClient(overrides?: Partial<EncodingMatrixClient>): EncodingMatrixClient {
  let currentClaim: EncodingClaim | null = null;
  let currentComplete: EncodingComplete | null = null;

  return {
    getDeviceId: () => 'device-A',
    getEncodingClaim: (_roomId: string) => currentClaim,
    getEncodingComplete: (_roomId: string) => currentComplete,
    setEncodingClaim: async (_roomId: string, claim: EncodingClaim) => {
      currentClaim = claim;
    },
    setEncodingComplete: async (_roomId: string, complete: EncodingComplete) => {
      currentComplete = complete;
    },
    getEventsSince: async (_roomId: string, _sinceSeq: number) => [],
    ...overrides,
  };
}

function createMockFilenClient(): EncodingFilenClient {
  const files = new Map<string, Uint8Array>();
  return {
    uploadFile: async (fileName: string, data: Uint8Array) => {
      const uuid = `file-${fileName}`;
      files.set(uuid, data);
      return { uuid, fileKey: 'test-key' };
    },
    downloadFile: async (uuid: string, _key: string) => {
      const data = files.get(uuid);
      if (!data) throw new Error(`File not found: ${uuid}`);
      return data;
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('encoding-claim', () => {
  describe('shouldEncode', () => {
    it('triggers at ≥500 loose events', () => {
      expect(shouldEncode(499, Date.now(), false)).toBe(false);
      expect(shouldEncode(500, Date.now(), false)).toBe(true);
      expect(shouldEncode(1000, Date.now(), false)).toBe(true);
    });

    it('triggers on idle with any loose events', () => {
      expect(shouldEncode(0, Date.now(), true)).toBe(false); // no events
      expect(shouldEncode(1, Date.now(), true)).toBe(true);
    });

    it('triggers after 24h gap', () => {
      const yesterday = Date.now() - 25 * 60 * 60 * 1000;
      expect(shouldEncode(0, yesterday, false)).toBe(true);
    });

    it('does not trigger with fresh encoding and few events', () => {
      expect(shouldEncode(10, Date.now(), false)).toBe(false);
    });
  });

  describe('claimEncoding', () => {
    it('claims successfully when no existing claim', async () => {
      const matrix = createMockMatrixClient();
      const result = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(result).toBe(true);
    });

    it('claims when existing claim is stale', async () => {
      const staleClaim: EncodingClaim = {
        type: 'encoding_claim',
        clientId: 'client-X',
        claimedThrough: 50,
        timestamp: Date.now() - 6 * 60 * 1000, // 6 minutes ago (past TTL)
        status: 'pending',
      };
      let currentClaim: EncodingClaim | null = staleClaim;
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => currentClaim,
        setEncodingClaim: async (_roomId: string, claim: EncodingClaim) => {
          currentClaim = claim;
        },
      });

      const result = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(result).toBe(true);
    }, 5000);

    it('refuses when another device has active claim', async () => {
      const activeClaim: EncodingClaim = {
        type: 'encoding_claim',
        clientId: 'client-X',
        claimedThrough: 50,
        timestamp: Date.now(), // fresh
        status: 'pending',
      };
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => activeClaim,
      });

      const result = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(result).toBe(false);
    });

    it('allows re-claim by same clientId', async () => {
      const ownClaim: EncodingClaim = {
        type: 'encoding_claim',
        clientId: 'client-A',
        claimedThrough: 50,
        timestamp: Date.now(),
        status: 'pending',
      };
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => ownClaim,
      });

      const result = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(result).toBe(true);
    }, 5000);

    it('claims when previous claim was completed', async () => {
      const completedClaim: EncodingClaim = {
        type: 'encoding_claim',
        clientId: 'client-X',
        claimedThrough: 50,
        timestamp: Date.now(),
        status: 'complete',
      };
      let currentClaim: EncodingClaim | null = completedClaim;
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => currentClaim,
        setEncodingClaim: async (_roomId: string, claim: EncodingClaim) => {
          currentClaim = claim;
        },
      });

      const result = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(result).toBe(true);
    }, 5000);

    it('lower clientId wins ties', async () => {
      // Simulate a conflict: after we write our claim, another device
      // with a lower clientId has also written theirs
      let callCount = 0;
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => {
          callCount++;
          if (callCount === 1) return null; // first check: no existing claim
          // After our write + jitter: another device claimed with lower ID
          return {
            type: 'encoding_claim',
            clientId: 'client-AAA', // lower than client-ZZZ
            claimedThrough: 100,
            timestamp: Date.now(),
            status: 'pending',
          };
        },
      });

      const result = await claimEncoding(matrix, 'room1', 'client-ZZZ', 100);
      expect(result).toBe(false);
    }, 5000);
  });

  describe('hydration', () => {
    it('falls back to local IDB when no .eodb available', async () => {
      const store = createTestStore();
      const matrix = createMockMatrixClient({
        getEncodingComplete: () => null,
      });
      const filen = createMockFilenClient();

      const stages: string[] = [];
      const buffer = await hydrate(
        store,
        matrix,
        filen,
        'room1',
        () => null,
        (stage) => { stages.push(stage); },
      );

      expect(buffer).toBeDefined();
      expect(stages[0]).toBe('local');
    });

    it('falls back when .eodb has no fileUuid', async () => {
      const store = createTestStore();
      const matrix = createMockMatrixClient({
        getEncodingComplete: () => ({
          type: 'encoding_complete',
          clientId: 'client-A',
          encodedThrough: 50,
          fileVersion: 1,
          fileHash: 12345,
          // no fileUuid or fileKey
        }),
      });
      const filen = createMockFilenClient();

      const buffer = await hydrate(store, matrix, filen, 'room1', () => null);
      expect(buffer).toBeDefined();
    });
  });

  describe('shouldEncode edge cases', () => {
    it('does not trigger with zero lastEncodingTs', () => {
      // lastEncodingTs=0 means no previous encoding — 24h gap check should not trigger
      expect(shouldEncode(0, 0, false)).toBe(false);
    });

    it('triggers on idle even with 1 event', () => {
      expect(shouldEncode(1, Date.now(), true)).toBe(true);
    });
  });
});
