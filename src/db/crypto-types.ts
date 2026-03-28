// ─── Shared Encryption Types ────────────────────────────────────────────────
// Segment-key encryption: optional, waterfall, room-based key distribution.

/** Encrypted operand wrapper — replaces plaintext operand in EoEvent/EoState. */
export interface EncryptedOperand {
  /** Marker so the system knows this operand is encrypted */
  _encrypted: true;
  /** Segment key UUID that encrypted this data */
  key_id: string;
  /** Base64-encoded ciphertext: [12-byte IV | AES-GCM ciphertext] */
  ciphertext: string;
  /** Key version at time of encryption (for rotation tracking) */
  key_version: number;
}

/** Metadata for a segment encryption key (no raw key material). */
export interface SegmentKey {
  /** Unique key identifier (UUID) */
  key_id: string;
  /** Target prefix this key covers — everything below is encrypted (waterfall) */
  scope: string;
  /** Key version (incremented on rotation) */
  version: number;
  /** Who created this key (Matrix user ID) */
  created_by: string;
  /** When this key was created (ISO 8601) */
  created_at: string;
  /** Optional human label */
  label?: string;
}

/** A single entry in the local keyring. */
export interface KeyringEntry {
  /** The raw AES-GCM CryptoKey */
  key: CryptoKey;
  /** Target prefix this key covers */
  scope: string;
  /** Key version */
  version: number;
}

/** Local keyring — decrypted segment keys this device holds. */
export interface LocalKeyring {
  /** Map of key_id → keyring entry */
  keys: Map<string, KeyringEntry>;
}

/** Type guard for encrypted operands. */
export function isEncryptedOperand(operand: any): operand is EncryptedOperand {
  return operand != null && typeof operand === 'object' && operand._encrypted === true;
}

/** SEG operand shape when declaring an encryption boundary. */
export interface EncryptBoundaryOperand {
  boundary: 'encrypt';
  key_id: string;
  algorithm: 'aes-256-gcm';
  key_version?: number;
}

/** Type guard for encrypt boundary SEG operands. */
export function isEncryptBoundary(operand: any): operand is EncryptBoundaryOperand {
  return operand != null && typeof operand === 'object' && operand.boundary === 'encrypt' && typeof operand.key_id === 'string';
}
