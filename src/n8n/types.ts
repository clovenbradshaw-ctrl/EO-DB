/**
 * n8n webhook storage types.
 *
 * Single-endpoint design: every request is a POST to /webhook/eo-store
 * with an `action` field that routes inside n8n via a Switch node.
 *
 * All data encrypted with AES-256-GCM before it leaves the device.
 * The Matrix room holds a manifest so any client knows what to request.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

export interface N8nWebhookConfig {
  /** Base URL of the n8n instance (e.g. "https://n8n.example.com"). */
  baseUrl: string;
  /** Webhook path (e.g. "/webhook/eo-store"). */
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
  /** SHA-256 hash of the plaintext, hex-encoded — used as content address. */
  content_hash: string;
  /** Key ID from the local keyring that encrypted this payload. */
  key_id: string;
  /** Original plaintext size in bytes (for quota / progress). */
  plaintext_size: number;
}

// ─── Manifest (lives as Matrix room state) ─────────────────────────────────

/**
 * A manifest entry stored as a Matrix state event:
 *   type  = "eo.n8n.manifest"
 *   state_key = data_id
 *
 * This is how the Matrix room "knows what data it's looking for".
 */
export interface ManifestEntry {
  /** Unique identifier for this data blob. */
  data_id: string;
  /** SHA-256 content hash — the lookup key when calling GET on n8n. */
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

// ─── Single-Endpoint Action Requests ───────────────────────────────────────

/** Every request to /webhook/eo-store is a POST with an `action` field. */
export type WebhookAction = 'store' | 'retrieve' | 'list';

export interface WebhookStoreRequest {
  action: 'store';
  /** The encrypted envelope. */
  envelope: EncryptedWebhookEnvelope;
  /** Data ID (so n8n can key the storage). */
  data_id: string;
  /** Data type hint for n8n routing / Drive folder selection. */
  data_type: ManifestDataType;
}

export interface WebhookRetrieveRequest {
  action: 'retrieve';
  /** Content hash to look up. */
  content_hash: string;
  /** Data ID as a secondary key. */
  data_id: string;
}

export interface WebhookListRequest {
  action: 'list';
  /** Optional: filter to a specific data type subfolder. */
  data_type?: ManifestDataType;
}

/** Union of all possible request bodies. */
export type WebhookRequest =
  | WebhookStoreRequest
  | WebhookRetrieveRequest
  | WebhookListRequest;

// ─── Responses ─────────────────────────────────────────────────────────────

export interface WebhookStoreResponse {
  ok: boolean;
  /** The content_hash echoed back for verification. */
  content_hash: string;
  /** Optional Google Drive file ID. */
  drive_file_id?: string;
}

export interface WebhookRetrieveResponse {
  ok: boolean;
  /** The encrypted envelope (if found). */
  envelope?: EncryptedWebhookEnvelope;
}

export interface WebhookListResponse {
  ok: boolean;
  /** List of { data_id, content_hash, data_type, stored_at } entries. */
  entries: Array<{
    data_id: string;
    content_hash: string;
    data_type: string;
    stored_at: string;
  }>;
}

