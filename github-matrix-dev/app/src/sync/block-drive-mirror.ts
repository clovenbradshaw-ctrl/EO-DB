/**
 * Drive mirror for canonical Matrix-media blocks.
 *
 * Every block sealed by `block-sealer.ts` is uploaded to the homeserver's
 * media store (`mxc://`) — that's the canonical write. This module adds a
 * fire-and-forget Drive copy of the *same plaintext `.eodb` bytes*, keyed
 * by the canonical mxc URI. On the read side, `block-hydration.ts` tries
 * Matrix media first and falls back to Drive if and only if the Matrix
 * download fails.
 *
 * Drive blobs go through the existing `BlobEnvelope` (gzip + AES-GCM with
 * the EoStore keyring) — totally independent of the Matrix attachment's
 * AES-CTR ciphertext. Each path is self-contained: a reader needs either
 * the attachment metadata (Matrix) or the EoStore keyring (Drive), not
 * both.
 *
 * Mirror failures never block the canonical write. The mxc URL is what
 * lands in `m.eo.block` and `m.eo.head`; Drive is a CDN fast-path that
 * may be missing without affecting correctness.
 */

import { getKeyById, resolveSnapshotKeyId, base64ToBuffer, bufferToBase64 } from '../crypto/segment-keys';
import type { LocalKeyring } from '../db/crypto-types';
import {
  fetchBlobFromDrive,
  gunzipBytes,
  gzipBytes,
  storeBlobToDrive,
  type BlobUploadMeta,
} from '../storage/eodb-blob-endpoint';

/**
 * Deps a caller wires once at boot to enable Drive mirroring. If any of
 * these can't be supplied (e.g. keyring not yet delivered), pass `null`
 * to `attachBlockMirror` — the sealer falls back to mxc-only behavior.
 */
export interface BlockDriveMirrorDeps {
  matrixToken: string;
  spaceRoomId: string;
  /**
   * Lazy keyring loader — same pattern as `HydrationBundleDriveDeps`.
   * The mirror calls it on every upload/download so a freshly delivered
   * key is picked up without restart.
   */
  loadKeyring: () => Promise<LocalKeyring>;
}

/**
 * Drive `dataId` for a block, derived from its mxc URI so the read side
 * can look up the mirror without separate bookkeeping. SHA-256 → first
 * 40 hex chars matches `eodbBlobDataIdForRoom`'s shape.
 */
async function mxcToDataId(mxcUri: string): Promise<string> {
  const bytes = new TextEncoder().encode(mxcUri);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource),
  );
  let hex = '';
  for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
  return `block-${hex.slice(0, 40)}`;
}

async function sha256hex(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', data as unknown as BufferSource),
  );
  let hex = '';
  for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
  return hex;
}

async function resolveKey(
  deps: BlockDriveMirrorDeps,
): Promise<{ key: CryptoKey; keyId: string }> {
  const keyring = await deps.loadKeyring();
  const keyId = resolveSnapshotKeyId(keyring);
  if (!keyId) {
    throw new Error('No encryption key in keyring — block mirror disabled until key delivery');
  }
  const entry = getKeyById(keyring, keyId);
  if (!entry) throw new Error('Keyring missing resolved key');
  return { key: entry.key, keyId };
}

/**
 * Upload a block's plaintext `.eodb` bytes to Drive as a mirror of the
 * canonical `mxc://` copy. Fire-and-forget — callers should not await
 * this on the seal critical path.
 *
 * The bytes are gzipped + AES-GCM-encrypted under the EoStore keyring
 * before they leave the browser. The on-disk Drive envelope matches
 * `BlobEnvelope` v2 — same shape used by `eodb-blob-writer.ts`.
 */
export async function mirrorBlockToDrive(
  deps: BlockDriveMirrorDeps,
  plaintext: Uint8Array,
  mxcUri: string,
): Promise<void> {
  const { key, keyId } = await resolveKey(deps);

  const contentHash = await sha256hex(plaintext);
  const plaintextSize = plaintext.byteLength;
  const compressed = await gzipBytes(plaintext);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    compressed as unknown as ArrayBuffer,
  );
  const ciphertext = new Uint8Array(ctBuf);

  const meta: BlobUploadMeta = {
    v: 2,
    iv: bufferToBase64(iv),
    content_hash: contentHash,
    key_id: keyId,
    plaintext_size: plaintextSize,
    compression: 'gzip',
  };

  const dataId = await mxcToDataId(mxcUri);
  await storeBlobToDrive(deps.matrixToken, dataId, meta, ciphertext, deps.spaceRoomId);
}

/**
 * Fetch a block's plaintext `.eodb` bytes from the Drive mirror, keyed by
 * its canonical mxc URI. Returns `null` if no mirror exists for this
 * block (e.g. it was sealed before mirroring was enabled, or the upload
 * failed silently).
 *
 * Integrity is verified against the envelope's `content_hash` — a mirror
 * with corrupted bytes is treated the same as a missing mirror.
 */
export async function fetchBlockFromDriveMirror(
  deps: BlockDriveMirrorDeps,
  mxcUri: string,
): Promise<Uint8Array | null> {
  const dataId = await mxcToDataId(mxcUri);
  const fetched = await fetchBlobFromDrive(deps.matrixToken, dataId, deps.spaceRoomId);
  if (!fetched) return null;

  const { key } = await resolveKey(deps);
  const envelope = fetched.envelope;
  const iv = base64ToBuffer(envelope.iv);
  const ct = base64ToBuffer(envelope.ct);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    ct as unknown as ArrayBuffer,
  );
  const decrypted = new Uint8Array(plainBuf);
  const plaintext = envelope.compression === 'gzip'
    ? await gunzipBytes(decrypted)
    : decrypted;

  const observed = await sha256hex(plaintext);
  if (observed !== envelope.content_hash) {
    return null;
  }
  return plaintext;
}
