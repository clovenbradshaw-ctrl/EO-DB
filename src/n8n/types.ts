/**
 * n8n webhook storage types.
 *
 * Replaces Filen — all data flows through n8n webhooks (POST to store,
 * GET to retrieve) with AES-256-GCM encryption on every payload.
 * The Matrix room holds a manifest of what data exists so any client
 * knows exactly what to request and which key decrypts it.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

export interface N8nWebhookConfig {
  /** Base URL of the n8n instance (e.g. "https://n8n.example.com"). */
  baseUrl: string;
  /** Webhook path for storing/retrieving data (e.g. "/webhook/eo-store"). */
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

// ─── Webhook Request / Response ────────────────────────────────────────────

export interface WebhookStoreRequest {
  /** The encrypted envelope. */
  envelope: EncryptedWebhookEnvelope;
  /** Data ID (so n8n can key the storage). */
  data_id: string;
  /** Data type hint for n8n routing/storage decisions. */
  data_type: ManifestDataType;
}

export interface WebhookStoreResponse {
  /** Whether n8n accepted the blob. */
  ok: boolean;
  /** The content_hash echoed back for verification. */
  content_hash: string;
  /** Optional storage URL / reference from n8n. */
  ref?: string;
}

export interface WebhookRetrieveRequest {
  /** Content hash to look up. */
  content_hash: string;
  /** Data ID as a secondary key. */
  data_id: string;
}

export interface WebhookRetrieveResponse {
  /** Whether the blob was found. */
  ok: boolean;
  /** The encrypted envelope (if found). */
  envelope?: EncryptedWebhookEnvelope;
}
