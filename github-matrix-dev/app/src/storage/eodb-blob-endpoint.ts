export const EODB_BLOB_ENDPOINT = 'https://n8n.intelechia.com/webhook/eo-blob';

export async function eodbBlobDataIdForRoom(roomId: string): Promise<string> {
  const bytes = new TextEncoder().encode(roomId);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource),
  );
  let hex = '';
  for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
  return `eodb-${hex.slice(0, 40)}`;
}

export type BlobProbe = 'exists' | 'missing' | 'unknown';

/**
 * Probe whether a room's blob has ever been written. Used by the client
 * before minting a fresh space key — if a ciphertext blob already exists,
 * we must wait for key delivery instead of generating a divergent key that
 * would overwrite unreadable data.
 *
 * `exists` = the webhook returned 2xx for op=get.
 * `missing` = 404.
 * `unknown` = anything else (network error, 5xx, timeout) — callers should
 *             treat this as "do not generate" to stay safe.
 */
export async function probeBlobExists(
  matrixToken: string,
  roomId: string,
  dataId: string,
): Promise<BlobProbe> {
  try {
    const res = await fetch(EODB_BLOB_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        matrix_token: matrixToken,
        op: 'get',
        room_id: roomId,
        data_id: dataId,
      }),
    });
    if (res.ok) return 'exists';
    if (res.status === 404) return 'missing';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
