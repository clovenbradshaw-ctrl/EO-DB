/**
 * Encoding-claim tests — leader-election lease for the block sealer.
 * (The earlier Filen-backed encoding/hydration paths were retired; what
 * remains is just the claim primitive.)
 */

import { describe, it, expect } from 'vitest';
import {
  shouldEncode,
  claimEncoding,
  releaseClaim,
  isClaimableByUs,
  type EncodingClaim,
  type EncodingMatrixClient,
} from '../encoding-claim';

function createMockMatrixClient(overrides?: Partial<EncodingMatrixClient>): EncodingMatrixClient {
  let currentClaim: EncodingClaim | null = null;
  return {
    getDeviceId: () => 'device-A',
    getEncodingClaim: (_roomId: string) => currentClaim,
    setEncodingClaim: async (_roomId: string, claim: EncodingClaim) => {
      currentClaim = claim;
    },
    ...overrides,
  };
}

describe('encoding-claim', () => {
  describe('shouldEncode', () => {
    it('triggers at ≥500 loose events', () => {
      expect(shouldEncode(499, Date.now(), false)).toBe(false);
      expect(shouldEncode(500, Date.now(), false)).toBe(true);
      expect(shouldEncode(1000, Date.now(), false)).toBe(true);
    });

    it('triggers on idle with any loose events', () => {
      expect(shouldEncode(0, Date.now(), true)).toBe(false);
      expect(shouldEncode(1, Date.now(), true)).toBe(true);
    });

    it('triggers after 24h gap', () => {
      const yesterday = Date.now() - 25 * 60 * 60 * 1000;
      expect(shouldEncode(0, yesterday, false)).toBe(true);
    });

    it('does not trigger with fresh encoding and few events', () => {
      expect(shouldEncode(10, Date.now(), false)).toBe(false);
    });

    it('does not trigger with zero lastEncodingTs', () => {
      expect(shouldEncode(0, 0, false)).toBe(false);
    });
  });

  describe('isClaimableByUs', () => {
    it('is claimable when nothing exists', () => {
      expect(isClaimableByUs(null, 'A')).toBe(true);
    });

    it('is claimable when prior claim is complete or failed', () => {
      const done: EncodingClaim = {
        type: 'encoding_claim', clientId: 'X', claimedThrough: 1,
        timestamp: Date.now(), status: 'complete',
      };
      expect(isClaimableByUs(done, 'A')).toBe(true);
      expect(isClaimableByUs({ ...done, status: 'failed' }, 'A')).toBe(true);
    });

    it('is claimable when prior claim is stale', () => {
      const stale: EncodingClaim = {
        type: 'encoding_claim', clientId: 'X', claimedThrough: 1,
        timestamp: Date.now() - 6 * 60 * 1000, status: 'pending',
      };
      expect(isClaimableByUs(stale, 'A')).toBe(true);
    });

    it('is not claimable when another client holds an active pending claim', () => {
      const active: EncodingClaim = {
        type: 'encoding_claim', clientId: 'X', claimedThrough: 1,
        timestamp: Date.now(), status: 'pending',
      };
      expect(isClaimableByUs(active, 'A')).toBe(false);
    });
  });

  describe('claimEncoding', () => {
    it('claims when no existing claim', async () => {
      const matrix = createMockMatrixClient();
      const ok = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(ok).toBe(true);
    });

    it('refuses when another device holds an active claim', async () => {
      const active: EncodingClaim = {
        type: 'encoding_claim', clientId: 'client-X', claimedThrough: 50,
        timestamp: Date.now(), status: 'pending',
      };
      const matrix = createMockMatrixClient({ getEncodingClaim: () => active });
      const ok = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(ok).toBe(false);
    });

    it('takes over a stale claim', async () => {
      const stale: EncodingClaim = {
        type: 'encoding_claim', clientId: 'client-X', claimedThrough: 50,
        timestamp: Date.now() - 6 * 60 * 1000, status: 'pending',
      };
      let cur: EncodingClaim | null = stale;
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => cur,
        setEncodingClaim: async (_r, c) => { cur = c; },
      });
      const ok = await claimEncoding(matrix, 'room1', 'client-A', 100);
      expect(ok).toBe(true);
    }, 5000);

    it('lower clientId wins ties', async () => {
      let callCount = 0;
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => {
          callCount++;
          if (callCount === 1) return null;
          return {
            type: 'encoding_claim', clientId: 'client-AAA',
            claimedThrough: 100, timestamp: Date.now(), status: 'pending',
          };
        },
      });
      const ok = await claimEncoding(matrix, 'room1', 'client-ZZZ', 100);
      expect(ok).toBe(false);
    }, 5000);

    it('releaseClaim writes a terminal claim status', async () => {
      let cur: EncodingClaim | null = null;
      const matrix = createMockMatrixClient({
        getEncodingClaim: () => cur,
        setEncodingClaim: async (_r, c) => { cur = c; },
      });
      await releaseClaim(matrix, 'room1', 'client-A', 200, 'complete');
      expect(cur).not.toBeNull();
      expect(cur!.status).toBe('complete');
      expect(cur!.clientId).toBe('client-A');
      expect(cur!.claimedThrough).toBe(200);
    });
  });
});
