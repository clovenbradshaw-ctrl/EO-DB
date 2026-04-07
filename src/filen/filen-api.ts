/**
 * Filen API — low-level REST helpers and v002 crypto for Filen cloud storage.
 *
 * Server-side port of github-matrix-dev/app/src/filen/filen-api.ts.
 * Node 22 provides all required APIs: crypto.subtle, fetch, atob/btoa,
 * crypto.randomUUID, TextEncoder/TextDecoder.
 *
 * Used by the import-upload module to archive raw source data to Filen
 * before processing, enabling auditability and crash-resume.
 */

const FILEN_GATEWAY = 'https://gateway.filen.io';

/**
 * n8n webhook that returns the shared Filen credentials (and optionally an
 * Airtable PAT) to authenticated Matrix users. The webhook validates the
 * caller's Matrix access token via /_matrix/client/v3/account/whoami and
 * responds with
 * `{"filen username": "...", "filen password": "...", "airtable PAT": "pat..."}`.
 */
const FILEN_CREDS_WEBHOOK =
  'https://n8n.intelechia.com/webhook/2caa4b94-873d-4a78-9770-d73a4d5b3c79';

export interface WebhookCredentials {
  username: string;
  password: string;
  airtablePat?: string;
}

export async function fetchFilenCredentialsFromWebhook(
  matrixAccessToken: string,
): Promise<WebhookCredentials> {
  const res = await fetch(FILEN_CREDS_WEBHOOK, {
    headers: { Authorization: `Bearer ${matrixAccessToken}` },
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  const username = data?.['filen username'];
  const password = data?.['filen password'];
  if (!username || !password) {
    throw new Error('Filen credentials webhook: unauthorized or malformed response');
  }
  return {
    username,
    password,
    airtablePat: data?.['airtable PAT'] || undefined,
  };
}

/** Ingest servers — one is chosen at random for each upload. */
const FILEN_INGEST_SERVERS = [
  'https://ingest.filen.io',
  'https://ingest.filen.net',
  'https://ingest.filen-1.net',
  'https://ingest.filen-2.net',
  'https://ingest.filen-3.net',
  'https://ingest.filen-4.net',
  'https://ingest.filen-5.net',
  'https://ingest.filen-6.net',
];

/** Egest servers — one is chosen at random for each download. */
const FILEN_EGEST_SERVERS = [
  'https://egest.filen.io',
  'https://egest.filen.net',
  'https://egest.filen-1.net',
  'https://egest.filen-2.net',
  'https://egest.filen-3.net',
  'https://egest.filen-4.net',
  'https://egest.filen-5.net',
  'https://egest.filen-6.net',
];

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export interface FilenAuth {
  apiKey: string;
  email: string;
}

export interface FilenItem {
  type: 'folder' | 'file';
  name: string;
  uuid: string;
  size?: number;
  key?: string;       // file encryption key (decrypted from metadata)
  timestamp?: number;
  region?: string;
  bucket?: string;
  chunks?: number;
  version?: number;
}

export interface LoginResult {
  apiKey: string;
  masterKeys: string[];
}

// ──────────────────────────────────────────────────────────────
// Crypto helpers — matches Filen SDK v002
// ──────────────────────────────────────────────────────────────

export async function sha512(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-512', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function deriveKeyFromPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 200000, hash: 'SHA-512' }, key, 512,
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decrypt Filen v002 metadata using master key.
 * Format: `002` + 12-char IV + base64(ciphertext + auth tag)
 */
export async function decryptMetadata(metadata: string, key: string): Promise<string | null> {
  try {
    if (!metadata || metadata.length < 16 || metadata.slice(0, 3) !== '002') return null;
    const enc = new TextEncoder();
    const pbk = await crypto.subtle.importKey('raw', enc.encode(key), 'PBKDF2', false, ['deriveBits']);
    const keyBits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(key), iterations: 1, hash: 'SHA-512' }, pbk, 256,
    );
    const aesKey = await crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['decrypt']);
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: enc.encode(metadata.slice(3, 15)) }, aesKey,
      Uint8Array.from(atob(metadata.slice(15)), c => c.charCodeAt(0)),
    );
    return new TextDecoder().decode(dec);
  } catch {
    return null;
  }
}

/**
 * Encrypt Filen v002 metadata string.
 * Output: `002` + 12-char IV + base64(ciphertext + auth tag)
 */
export async function encryptMetadata(plaintext: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const pbk = await crypto.subtle.importKey('raw', enc.encode(key), 'PBKDF2', false, ['deriveBits']);
  const keyBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(key), iterations: 1, hash: 'SHA-512' }, pbk, 256,
  );
  const aesKey = await crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt']);
  const ivChars = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => String.fromCharCode(97 + (b % 26)))
    .join('');
  const iv = enc.encode(ivChars);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintext));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  return `002${ivChars}${b64}`;
}

/**
 * Encrypt file content using Filen v002 format.
 * Output: [12-byte IV][ciphertext + 16-byte auth tag]
 */
export async function encryptFileContent(data: Uint8Array, fileKey: string): Promise<Uint8Array> {
  const keyBytes = hexToBytes(fileKey.slice(0, 64));
  const aesKey = await crypto.subtle.importKey('raw', keyBytes as unknown as BufferSource, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data as unknown as BufferSource));
  const result = new Uint8Array(iv.byteLength + ct.byteLength);
  result.set(iv, 0);
  result.set(ct, iv.byteLength);
  return result;
}

/**
 * Decrypt file content from Filen v002 format.
 * Input: [12-byte IV][ciphertext + 16-byte auth tag]
 */
export async function decryptFileContent(encrypted: Uint8Array, fileKey: string): Promise<Uint8Array> {
  const keyBytes = hexToBytes(fileKey.slice(0, 64));
  const aesKey = await crypto.subtle.importKey('raw', keyBytes as unknown as BufferSource, 'AES-GCM', false, ['decrypt']);
  const iv = encrypted.slice(0, 12);
  const ct = encrypted.slice(12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct as unknown as BufferSource));
}

/** Generate a random 64-char hex string for use as a file encryption key. */
export function generateFileKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ──────────────────────────────────────────────────────────────
// API helpers
// ──────────────────────────────────────────────────────────────

async function gateway(
  endpoint: string,
  data: Record<string, unknown>,
  apiKey?: string,
): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(FILEN_GATEWAY + endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────────────────────

export async function filenLogin(
  email: string,
  password: string,
  twofa?: string,
): Promise<LoginResult> {
  // Step 1: auth/info
  const aiRes = await fetch(FILEN_GATEWAY + '/v3/auth/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const ai = await aiRes.json();
  if (!ai.status) throw new Error(ai.message || 'Auth info failed');

  // Step 2: derive password + master key (PBKDF2)
  const enc = new TextEncoder();
  const km = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(ai.data.salt), iterations: 200000, hash: 'SHA-512' },
    km, 512,
  );
  const fullKey = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const masterKey = fullKey.substring(0, fullKey.length / 2);
  const loginPw = fullKey.substring(fullKey.length / 2);
  const derivedPw = await sha512(loginPw);

  // Step 3: login
  const lrRes = await fetch(FILEN_GATEWAY + '/v3/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: derivedPw,
      twoFactorCode: twofa || 'XXXXXX',
      authVersion: ai.data.authVersion,
    }),
  });
  const lr = await lrRes.json();
  if (!lr.status) throw new Error(lr.message || 'Login failed');

  return {
    apiKey: lr.data.apiKey,
    masterKeys: [masterKey],
  };
}

export async function filenGetBaseFolder(apiKey: string): Promise<string> {
  const res = await fetch(FILEN_GATEWAY + '/v3/user/baseFolder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: '{}',
  });
  const data = await res.json();
  if (!data.status) {
    const res2 = await fetch(FILEN_GATEWAY + '/v3/user/baseFolder', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data2 = await res2.json();
    if (!data2.status) throw new Error(data2.message || 'Failed to get base folder');
    return data2.data.uuid;
  }
  return data.data.uuid;
}

// ──────────────────────────────────────────────────────────────
// Folder operations
// ──────────────────────────────────────────────────────────────

export async function filenCreateFolder(
  apiKey: string,
  parentUuid: string,
  folderName: string,
  masterKey: string,
): Promise<string> {
  const uuid = crypto.randomUUID();
  const nameHashed = await sha256(folderName.toLowerCase());
  const encName = await encryptMetadata(JSON.stringify({ name: folderName }), masterKey);

  const res = await gateway('/v3/dir/create', {
    uuid,
    name: encName,
    nameHashed,
    parent: parentUuid,
  }, apiKey);

  if (!res.status) throw new Error(res.message || 'Failed to create folder');
  return res.data?.uuid || uuid;
}

export async function filenListFolder(
  apiKey: string,
  folderUuid: string,
  masterKeys: string[],
): Promise<FilenItem[]> {
  const res = await gateway('/v3/dir/content', { uuid: folderUuid }, apiKey);
  if (!res.status) throw new Error(res.message || 'Failed to list folder');

  const items: FilenItem[] = [];

  for (const f of (res.data.folders || [])) {
    let name = f.name;
    for (const mk of masterKeys) {
      const dec = await decryptMetadata(f.name, mk);
      if (dec) { try { name = JSON.parse(dec).name || dec; } catch { name = dec; } break; }
    }
    items.push({ type: 'folder', name, uuid: f.uuid });
  }

  for (const f of (res.data.uploads || [])) {
    let name = f.name || '?', size = f.size || 0, fileKey = '';
    let timestamp = f.timestamp;
    for (const mk of masterKeys) {
      const dec = await decryptMetadata(f.metadata, mk);
      if (dec) {
        try {
          const p = JSON.parse(dec);
          name = p.name || name;
          size = p.size || size;
          fileKey = p.key || '';
        } catch { name = dec; }
        break;
      }
    }
    items.push({
      type: 'file', name, uuid: f.uuid, size, key: fileKey, timestamp,
      region: f.region, bucket: f.bucket, chunks: f.chunks, version: f.version,
    });
  }

  items.sort((a, b) =>
    a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name),
  );

  return items;
}

export async function filenFindFolder(
  apiKey: string,
  parentUuid: string,
  folderName: string,
  masterKeys: string[],
): Promise<string | null> {
  const items = await filenListFolder(apiKey, parentUuid, masterKeys);
  const folder = items.find(i => i.type === 'folder' && i.name === folderName);
  return folder?.uuid ?? null;
}

export async function filenEnsureFolder(
  apiKey: string,
  parentUuid: string,
  folderName: string,
  masterKeys: string[],
): Promise<string> {
  const existing = await filenFindFolder(apiKey, parentUuid, folderName, masterKeys);
  if (existing) return existing;
  return filenCreateFolder(apiKey, parentUuid, folderName, masterKeys[0]);
}

// ──────────────────────────────────────────────────────────────
// File upload
// ──────────────────────────────────────────────────────────────

export async function filenUploadFile(
  apiKey: string,
  parentUuid: string,
  fileName: string,
  data: Uint8Array,
  masterKey: string,
): Promise<{ uuid: string; fileKey: string }> {
  const fileUuid = crypto.randomUUID();
  const fileKey = generateFileKey();
  const uploadKey = crypto.randomUUID();
  const rm = crypto.randomUUID();

  // 1. Encrypt file content
  const encrypted = await encryptFileContent(data, fileKey);

  // 2. Encrypt file metadata
  const metadataObj = JSON.stringify({
    name: fileName,
    size: data.byteLength,
    mime: 'application/octet-stream',
    key: fileKey,
    lastModified: Date.now(),
  });
  const encryptedMetadata = await encryptMetadata(metadataObj, masterKey);

  // 3. Hash filename
  const nameHashed = await sha256(fileName.toLowerCase());

  // 4. Compute hash of encrypted content for integrity
  const hashBuf = await crypto.subtle.digest('SHA-512', encrypted as unknown as BufferSource);
  const contentHash = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // 5. Upload encrypted chunk to ingest server
  const ingestUrl = pickRandom(FILEN_INGEST_SERVERS);
  const params = new URLSearchParams({
    uuid: fileUuid,
    index: '0',
    parent: parentUuid,
    uploadKey,
    hash: contentHash,
  });

  const uploadRes = await fetch(`${ingestUrl}/v3/upload?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: encrypted as unknown as BodyInit,
  });
  const uploadJson = await uploadRes.json();
  if (!uploadJson.status) {
    throw new Error(uploadJson.message || 'Chunk upload failed');
  }

  // 6. Finalize upload
  const doneRes = await gateway('/v3/upload/done', {
    uuid: fileUuid,
    name: encryptedMetadata,
    nameHashed,
    size: String(encrypted.byteLength),
    chunks: 1,
    mime: 'application/octet-stream',
    rm,
    metadata: encryptedMetadata,
    version: 2,
    uploadKey,
  }, apiKey);

  if (!doneRes.status) {
    throw new Error(doneRes.message || 'Upload finalization failed');
  }

  return { uuid: fileUuid, fileKey };
}

// ──────────────────────────────────────────────────────────────
// File download
// ──────────────────────────────────────────────────────────────

export async function filenDownloadFile(
  apiKey: string,
  fileUuid: string,
  fileKey: string,
  region?: string,
  bucket?: string,
): Promise<Uint8Array> {
  const egestUrl = pickRandom(FILEN_EGEST_SERVERS);

  const params = new URLSearchParams({
    uuid: fileUuid,
    region: region || 'de-1',
    bucket: bucket || 'filen-1',
    index: '0',
  });

  const res = await fetch(`${egestUrl}/v3/download?${params}`, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const encrypted = new Uint8Array(await res.arrayBuffer());
  return decryptFileContent(encrypted, fileKey);
}
