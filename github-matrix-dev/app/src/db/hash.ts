/**
 * Browser-compatible transformation hash functions.
 * Mirrors src/db/hash.ts but uses SubtleCrypto (Web Crypto API) instead of Node crypto.
 */

function serialize(value: any): string {
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function seedHash(event: { op: string; target: string; operand: any; ts: string }): Promise<string> {
  const input = event.op + event.target + serialize(event.operand) + event.ts;
  return sha256(input);
}

export async function chainHash(previousHash: string, event: { op: string; operand: any }): Promise<string> {
  const input = previousHash + event.op + serialize(event.operand);
  return sha256(input);
}
