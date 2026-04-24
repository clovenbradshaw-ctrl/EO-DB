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
