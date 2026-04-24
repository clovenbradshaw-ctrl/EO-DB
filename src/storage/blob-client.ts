/**
 * BlobClient — encrypted, versioned blob storage via the n8n `/webhook/eo-blob`
 * endpoint. The webhook persists to `/mnt/eo-blobs` on the hyphae-secure VM and
 * enforces Matrix room membership as the access boundary.
 *
 * Wire contract
 * -------------
 * POST JSON with `op` ∈ { store | get | versions }. Every request carries
 * `matrix_token`, `op`, `room_id`, `data_id`. The `data_id` MUST be prefixed
 * with the room prefix:
 *
 *   roomPrefix(roomId) = "r_" + roomId.replace(/^!/,'')
 *                                     .replace(/[^a-zA-Z0-9]/g,'_')
 *                                     .slice(0, 40)
 *   data_id            = `${roomPrefix}:${localId}`
 *
 * The derivation is plain-string, not a hash — the room_id isn't secret
 * (it's in the request) and we just need a stable, filesystem-safe prefix
 * that the server can re-derive. The server rejects mismatched IDs with
 * HTTP 400. Five most recent versions are retained per `data_id`; older
 * versions are pruned on each store. Version numbers are monotonic —
 * pruning v1 and writing again produces v6, not v1.
 *
 * Reuses:
 *   - EncryptedWebhookEnvelope from ../n8n/types
 *   - encryptForWebhook / decryptFromWebhook from ../n8n/encrypted-payload
 *   - LocalKeyring from ../db/crypto-types
 */

import type { EncryptedWebhookEnvelope } from '../n8n/types.js';
import type { LocalKeyring } from '../db/crypto-types.js';
import {
  encryptForWebhook,
  decryptFromWebhook,
} from '../n8n/encrypted-payload.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface BlobMeta {
  version: number;
  writer: string;
  auth_user_id: string;
  room_id: string;
  target: string | null;
  label: string | null;
  content_hash: string;
  plaintext_size: number | null;
  key_id: string | null;
  created_at: string;
}

export interface BlobClientOptions {
  /** Full URL to the n8n webhook, e.g. `https://n8n.intelechia.com/webhook/eo-blob`. */
  endpoint: string;
  /** Matrix access token — forwarded verbatim in the request body. */
  matrixToken: string;
  /** Matrix room that gates access. Must start with `!`. */
  roomId: string;
  /** Optional writer label sent as the `X-EO-Writer` header. */
  writerLabel?: string;
  /** Request timeout in ms (default 30 000). */
  timeoutMs?: number;
  /** Optional custom fetch (for tests / non-browser hosts). */
  fetchImpl?: typeof fetch;
}

export interface StoreOptions {
  /** Caller-supplied identifier. The room prefix is added automatically. */
  localId: string;
  /** Plaintext data. Any msgpack-serialisable value. */
  data: unknown;
  /** EO target path used for waterfall key resolution. */
  target: string;
  /** Local keyring holding AES-256-GCM keys. */
  keyring: LocalKeyring;
  /** Optional human-readable label stored alongside the blob. */
  label?: string;
}

export interface StoreResult {
  data_id: string;
  version: number;
  uri: string;
  content_hash: string;
  pruned: number[];
}

export interface RetrieveOptions {
  localId: string;
  keyring: LocalKeyring;
  /** Omit or pass `'latest'` for the newest version. */
  version?: number | 'latest';
}

export interface RetrieveResult {
  data: unknown;
  version: number;
  meta: BlobMeta;
}

export interface VersionListing {
  version: number;
  uri: string;
  meta: BlobMeta;
}

// ─── Internals ─────────────────────────────────────────────────────────────

/**
 * `r_<filesystem-safe(roomId)>` — must match the n8n workflow's derivation.
 * The `async` signature is kept for callers/tests that already `await` it;
 * no async work happens.
 */
export async function roomPrefix(roomId: string): Promise<string> {
  return 'r_' + roomId
    .replace(/^!/, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .slice(0, 40);
}

/** Build a room-scoped `data_id` from a `localId`. */
export async function roomScopedDataId(
  roomId: string,
  localId: string,
): Promise<string> {
  return `${await roomPrefix(roomId)}:${localId}`;
}

const DATA_ID_PATTERN = /^[a-zA-Z0-9_:-]{1,128}$/;

export class BlobClientError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'BlobClientError';
    this.status = status;
    this.body = body;
  }
}

// ─── Client ────────────────────────────────────────────────────────────────

export class BlobClient {
  private readonly endpoint: string;
  private readonly matrixToken: string;
  private readonly roomId: string;
  private readonly writerLabel?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BlobClientOptions) {
    if (!opts.endpoint) throw new Error('BlobClient: endpoint is required');
    if (!opts.matrixToken) throw new Error('BlobClient: matrixToken is required');
    if (!opts.roomId || !opts.roomId.startsWith('!')) {
      throw new Error('BlobClient: roomId must start with "!"');
    }
    this.endpoint = opts.endpoint;
    this.matrixToken = opts.matrixToken;
    this.roomId = opts.roomId;
    this.writerLabel = opts.writerLabel;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get room(): string {
    return this.roomId;
  }

  async dataIdFor(localId: string): Promise<string> {
    const id = await roomScopedDataId(this.roomId, localId);
    if (!DATA_ID_PATTERN.test(id)) {
      throw new Error(
        `BlobClient: derived data_id "${id}" is not valid (allowed: [a-zA-Z0-9_:-]{1,128})`,
      );
    }
    return id;
  }

  async store(opts: StoreOptions): Promise<StoreResult> {
    const envelope = await encryptForWebhook(opts.data, opts.keyring, opts.target);
    if (!envelope) {
      throw new Error(
        `BlobClient.store: no encryption key covers target "${opts.target}".`,
      );
    }

    const data_id = await this.dataIdFor(opts.localId);
    const body = {
      matrix_token: this.matrixToken,
      op: 'store' as const,
      room_id: this.roomId,
      data_id,
      envelope,
      target: opts.target,
      label: opts.label,
    };

    const resp = await this.post(body, { includeWriterHeader: true });
    const json = (await resp.json()) as {
      data_id: string;
      version: number;
      uri: string;
      content_hash: string;
      pruned: number[];
    };

    if (json.content_hash !== envelope.content_hash) {
      throw new BlobClientError(
        500,
        `BlobClient.store: hash mismatch (sent ${envelope.content_hash}, got ${json.content_hash})`,
        json,
      );
    }

    return {
      data_id: json.data_id,
      version: json.version,
      uri: json.uri,
      content_hash: json.content_hash,
      pruned: json.pruned ?? [],
    };
  }

  async retrieve(opts: RetrieveOptions): Promise<RetrieveResult> {
    const data_id = await this.dataIdFor(opts.localId);
    const body: Record<string, unknown> = {
      matrix_token: this.matrixToken,
      op: 'get',
      room_id: this.roomId,
      data_id,
    };
    if (opts.version !== undefined) body.version = opts.version;

    const resp = await this.post(body);
    const json = (await resp.json()) as {
      data_id: string;
      version: number;
      uri: string;
      envelope: EncryptedWebhookEnvelope;
      meta: BlobMeta;
    };

    const data = await decryptFromWebhook(json.envelope, opts.keyring);
    return { data, version: json.version, meta: json.meta };
  }

  async listVersions(localId: string): Promise<VersionListing[]> {
    const data_id = await this.dataIdFor(localId);
    const body = {
      matrix_token: this.matrixToken,
      op: 'versions' as const,
      room_id: this.roomId,
      data_id,
    };

    const resp = await this.post(body);
    const json = (await resp.json()) as {
      data_id: string;
      versions: VersionListing[];
      latest: number | null;
    };
    return json.versions ?? [];
  }

  // ─── Transport ─────────────────────────────────────────────────────────

  private async post(
    body: Record<string, unknown>,
    opts: { includeWriterHeader?: boolean } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (opts.includeWriterHeader && this.writerLabel) {
      headers['X-EO-Writer'] = this.writerLabel;
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BlobClientError(
        0,
        `BlobClient: network error calling ${this.endpoint}: ${(err as Error).message}`,
      );
    }

    if (!resp.ok) {
      let parsed: unknown = null;
      const text = await resp.text().catch(() => '');
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      const detail =
        parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
          ? String((parsed as Record<string, unknown>).error)
          : typeof parsed === 'string'
            ? parsed
            : `HTTP ${resp.status}`;
      throw new BlobClientError(resp.status, `BlobClient: ${detail}`, parsed);
    }

    return resp;
  }
}

// ─── Default singleton (the recommended storage entry point) ───────────────

let _default: BlobClient | null = null;

/** Register a process-wide default BlobClient (recommended storage path). */
export function configureDefaultBlobClient(client: BlobClient): void {
  _default = client;
}

/** Retrieve the configured default BlobClient, or null if unconfigured. */
export function getDefaultBlobClient(): BlobClient | null {
  return _default;
}

/** Strict variant: throws if no default has been configured. */
export function requireDefaultBlobClient(): BlobClient {
  if (!_default) {
    throw new Error(
      'No default BlobClient configured. Call configureDefaultBlobClient(new BlobClient({...})) at startup.',
    );
  }
  return _default;
}
