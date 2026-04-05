/**
 * Encrypted store — wraps the raw IndexedDB with transparent AES-GCM encryption.
 *
 * The fold engine and all other consumers call this store's methods.
 * They never deal with encryption directly. If the key is missing (logged out),
 * all operations throw — this is correct behavior.
 *
 * Values are msgpack-encoded before encryption, and decrypted+decoded on read.
 */

import { pack, unpack } from 'msgpackr';
import { encrypt, decrypt } from '../lib/crypto';
import { type EoIdb, idbGet, idbPut, idbDel, idbIterator, padSeq, type IteratorOpts } from './idb';

export type { IteratorOpts };

export interface EoStore {
  get(key: string): Promise<any | null>;
  put(key: string, value: any): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Range scan over a prefix. Pass `opts.limit` and/or `opts.afterKey` for
   * cursor-based pagination — callers should avoid unbounded scans at scale.
   */
  iterator(prefix: string, opts?: IteratorOpts): Promise<[string, any][]>;
  nextSeq(): Promise<number>;
  getCurrentSeq(): Promise<number>;
  close(): void;
}

export function createStore(idb: EoIdb, cryptoKey: CryptoKey): EoStore {
  async function encryptValue(value: any): Promise<Uint8Array> {
    const packed = pack(value);
    return encrypt(cryptoKey, new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
  }

  async function decryptValue(data: Uint8Array): Promise<any> {
    const plain = await decrypt(cryptoKey, data);
    return unpack(plain);
  }

  return {
    async get(key: string): Promise<any | null> {
      const raw = await idbGet(idb, key);
      if (!raw) return null;
      return decryptValue(raw);
    },

    async put(key: string, value: any): Promise<void> {
      const encrypted = await encryptValue(value);
      await idbPut(idb, key, encrypted);
    },

    async del(key: string): Promise<void> {
      await idbDel(idb, key);
    },

    async iterator(prefix: string, opts?: IteratorOpts): Promise<[string, any][]> {
      const raw = await idbIterator(idb, prefix, opts);
      const results: [string, any][] = [];
      for (const [key, data] of raw) {
        const value = await decryptValue(data);
        results.push([key, value]);
      }
      return results;
    },

    async nextSeq(): Promise<number> {
      let current = 0;
      const raw = await idbGet(idb, 'meta:seq');
      if (raw) {
        current = await decryptValue(raw) as number;
      }
      const next = current + 1;
      await idbPut(idb, 'meta:seq', await encryptValue(next));
      return next;
    },

    async getCurrentSeq(): Promise<number> {
      const raw = await idbGet(idb, 'meta:seq');
      if (!raw) return 0;
      return await decryptValue(raw) as number;
    },

    close(): void {
      idb.close();
    },
  };
}

/**
 * Create an unencrypted local store — same EoStore interface but no crypto key
 * required.  Values are msgpack-encoded for consistency with the encrypted
 * variant but stored in the clear.  This allows local ingest / create
 * operations to work even when the user hasn't logged in to Matrix.
 */
export function createLocalStore(idb: EoIdb): EoStore {
  return {
    async get(key: string): Promise<any | null> {
      const raw = await idbGet(idb, key);
      if (!raw) return null;
      return unpack(raw);
    },

    async put(key: string, value: any): Promise<void> {
      const packed = pack(value);
      await idbPut(idb, key, new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
    },

    async del(key: string): Promise<void> {
      await idbDel(idb, key);
    },

    async iterator(prefix: string, opts?: IteratorOpts): Promise<[string, any][]> {
      const raw = await idbIterator(idb, prefix, opts);
      const results: [string, any][] = [];
      for (const [key, data] of raw) {
        results.push([key, unpack(data)]);
      }
      return results;
    },

    async nextSeq(): Promise<number> {
      let current = 0;
      const raw = await idbGet(idb, 'meta:seq');
      if (raw) {
        current = unpack(raw) as number;
      }
      const next = current + 1;
      const packed = pack(next);
      await idbPut(idb, 'meta:seq', new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength));
      return next;
    },

    async getCurrentSeq(): Promise<number> {
      const raw = await idbGet(idb, 'meta:seq');
      if (!raw) return 0;
      return unpack(raw) as number;
    },

    close(): void {
      idb.close();
    },
  };
}

export { padSeq };
