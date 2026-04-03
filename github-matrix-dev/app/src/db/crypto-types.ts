// ─── Shared Encryption Types (client mirror) ───────────────────────────────
// Minimal subset needed for snapshot/peer encryption on the client side.

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
