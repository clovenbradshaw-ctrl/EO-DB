/**
 * Seed uploader.
 *
 * Read the input file's bytes. AES-CTR encrypt them. POST to
 * `/_matrix/media/v3/upload`. Send one `m.eo.block` referencing the
 * mxc URI + AES key, then advance `m.eo.head`. Done.
 *
 * No parsing of the file contents on the upload side — the bytes go
 * to the homeserver as opaque ciphertext. The receiving end (every
 * client hydrating the room, including the uploader's own next sync
 * tick) downloads, decrypts, and folds the block through the normal
 * `sync/block-hydration` path. Events inside the `.eodb` carry their
 * own timestamps and content-hashed `client_event_id`s, so ordering
 * and deduplication are preserved across the round trip.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import {
  readHeadState,
  sealBlockFromPayload,
  BLOCK_SCHEMA_VERSION,
} from './block-sealer';
import type { BlockDriveMirrorDeps } from './block-drive-mirror';

export interface SeedUploadResult {
  blockEventId: string;
  blockIndex: number;
  byteCount: number;
}

/**
 * Upload a seed file as the next block in the room's chain. The file
 * bytes are uploaded verbatim (after AES-CTR encryption for Matrix
 * attachment e2ee) — no client-side parsing, no chunking, no diff
 * against existing state. If the input has the same `client_event_id`s
 * as events already folded into the room, the fold engine dedups them
 * on the read side; the seed becomes a no-op for state but adds a
 * block to the chain. Use the block-toggle admin path to disable
 * unwanted blocks rather than skipping the upload.
 *
 * When `mirror` is supplied, the same plaintext bytes are also written
 * to Drive (fire-and-forget) so subsequent reads have a fallback if
 * the homeserver media path is slow or unreachable.
 */
export async function uploadSeedFile(
  client: MatrixClient,
  roomId: string,
  bytes: Uint8Array,
  eventCount: number = 0,
  mirror: BlockDriveMirrorDeps | null = null,
): Promise<SeedUploadResult> {
  if (bytes.byteLength === 0) {
    throw new Error('Seed file is empty');
  }

  const head = readHeadState(client, roomId);
  const myDeviceId = client.getDeviceId?.() ?? 'seed';

  const result = await sealBlockFromPayload(
    client,
    roomId,
    myDeviceId,
    bytes,
    eventCount,
    head,
    { schemaVersion: BLOCK_SCHEMA_VERSION, mirror },
  );

  return {
    blockEventId: result.blockEventId,
    blockIndex: result.blockIndex,
    byteCount: bytes.byteLength,
  };
}
