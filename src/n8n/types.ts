/**
 * n8n webhook storage types — "EO Blob Store" workflow contract.
 *
 * Single endpoint, op-routed: every request is a POST whose body carries
 *   { matrix_token, op, room_id, data_id, ... }
 * The deployed workflow validates that data_id is room-scoped (must start
 * with `r_<sha256(room_id)[:8]>:`) before accepting the write.
 *
 * Storage backend is filesystem (/mnt/eo-blobs on the n8n host), with up
 * to 5 versions per data_id. Listing across blobs is not a server op —
 * the Matrix room state IS the cross-blob index.
 *
 * All payloads encrypted with AES-256-GCM before they leave the device.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

export interface N8nWebhookConfig {
  /** Base URL of the n8n instance (e.g. "https://n8n.example.com"). */
  baseUrl: string;
  /** Webhook path (e.g. "/webhook/eo-blob"). */
  webhookPath: string;
  /** Optional static auth token n8n expects in the Authorization header. */
  webhookAuthToken?: string;
  /** Max payload size in bytes before chunking (default: 5 MB). */
  maxPayloadBytes: number;
  /** Request timeout in ms (default: 30 000). */
  timeoutMs: number;
}

// ─── Encrypted Envelope ────────────────────────────────────────────────────

export interface EncryptedWebhookEnvelope {
  /** Format version marker. */
  v: 1;
  /** AES-256-GCM initialization vector (12 bytes, base64). */
  iv: string;
  /** Encrypted payload (base64). */
  ct: string;
  /** SHA-256 hash of the plaintext, hex-encoded — verified after decrypt. */
  content_hash: string;
  /** Key ID from the local keyring that encrypted this payload. */
  key_id: string;
  /** Original plaintext size in bytes (for quota / progress). */
  plaintext_size: number;
}

// ─── Manifest (lives as Matrix room state) ─────────────────────────────────

/**
 * A manifest entry stored as a Matrix state event:
 *   type      = "eo.n8n.manifest"
 *   state_key = data_id
 *
 * This is how the Matrix room "knows what data it's looking for".
 * Retrieval keys off (room_id, data_id, version) — content_hash is verified
 * after decrypt but is no longer the server-side lookup key.
 */
export interface ManifestEntry {
  /** Room-scoped data id: "r_<8hex>:<uuid>". */
  data_id: string;
  /** Matrix room id this blob belongs to (must match the data_id prefix). */
  room_id: string;
  /** Server-assigned version (1-based, monotonic per data_id). */
  version: number;
  /** Canonical URI: "eo-blob://<data_id>/v<version>". */
  uri: string;
  /** SHA-256 content hash — verified client-side after decrypt. */
  content_hash: string;
  /** Encryption key_id that was used. */
  key_id: string;
  /** Plaintext size in bytes. */
  size: number;
  /** ISO-8601 timestamp when the data was stored. */
  created_at: string;
  /** What kind of data this is. */
  data_type: ManifestDataType;
  /** Optional human-readable label. */
  label?: string;
  /** Agent / user who stored this. */
  stored_by: string;
  /** Sequence range covered (for event batches / snapshots). */
  seq_range?: { from: number; to: number };
}

export type ManifestDataType =
  | 'snapshot'
  | 'event-batch'
  | 'import-archive'
  | 'attachment'
  | 'backup';

// ─── Single-Endpoint Op Requests ───────────────────────────────────────────

export type WebhookOp = 'store' | 'get' | 'versions';

interface WebhookRequestBase {
  /** Matrix access token — workflow calls /whoami + room membership check. */
  matrix_token: string;
  /** Matrix room id (must start with "!"). */
  room_id: string;
  /** Room-scoped data id — must start with `r_<8hex>:`. */
  data_id: string;
}

export interface WebhookStoreRequest extends WebhookRequestBase {
  op: 'store';
  envelope: EncryptedWebhookEnvelope;
  /** Optional EO target path (informational, persisted in server-side meta). */
  target?: string;
  /** Optional human-readable label (persisted in server-side meta). */
  label?: string;
}

export interface WebhookGetRequest extends WebhookRequestBase {
  op: 'get';
  /** Specific version, or omit/"latest" for the newest. */
  version?: number | 'latest';
}

export interface WebhookVersionsRequest extends WebhookRequestBase {
  op: 'versions';
}

export type WebhookRequest =
  | WebhookStoreRequest
  | WebhookGetRequest
  | WebhookVersionsRequest;

// ─── Responses ─────────────────────────────────────────────────────────────

/**
 * Server-side per-version meta (written next to each blob).
 * Mirrors what the workflow's Store node persists in v<n>.meta.json.
 */
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

export interface WebhookStoreResponse {
  data_id: string;
  version: number;
  writer: string;
  auth_user_id: string;
  room_id: string;
  /** Canonical URI: "eo-blob://<data_id>/v<version>". */
  uri: string;
  content_hash: string;
  created_at: string;
  /** Versions pruned by the rolling-history cap. */
  pruned: number[];
  storage_base: string;
}

export interface WebhookGetResponse {
  data_id: string;
  version: number;
  uri: string;
  envelope: EncryptedWebhookEnvelope;
  meta: BlobMeta | null;
}

export interface WebhookVersionsResponse {
  data_id: string;
  versions: Array<{ version: number; uri: string; meta: BlobMeta | null }>;
  latest: number | null;
}

/** Error shape returned on non-2xx responses from the workflow. */
export interface WebhookErrorResponse {
  error: string;
  detail?: unknown;
}
