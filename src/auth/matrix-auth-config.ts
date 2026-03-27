import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single allowed Matrix account with optional encryption metadata. */
export interface AllowedMatrixAccount {
  /** Full Matrix user ID, e.g. "@user:app.aminoimmigration.com" */
  user_id: string;
  /** Human-readable label for this account (optional) */
  label?: string;
  /** When this account was added to the allowlist */
  added_at: string;
  /** Who added this account (Matrix user ID of the admin) */
  added_by: string;
  /**
   * Future: per-account encryption key fingerprint.
   * When Matrix-based encryption is enabled, this will store
   * the public key fingerprint used to encrypt data for this account.
   */
  encryption_key_id?: string;
}

/** Persistent configuration for Matrix auth on this database instance. */
export interface MatrixAuthConfig {
  /** Whether Matrix account-level auth gating is enabled */
  enabled: boolean;
  /** The Matrix homeserver(s) accepted for token validation */
  allowed_homeservers: string[];
  /** The set of allowed Matrix accounts (keyed by user_id) */
  allowed_accounts: AllowedMatrixAccount[];
  /**
   * Future: encryption settings for data-at-rest using Matrix auth.
   * Structured now so the schema is stable when encryption lands.
   */
  encryption: {
    /** Whether data encryption via Matrix keys is active */
    enabled: boolean;
    /** Algorithm identifier for future use (e.g. "m.megolm.v1.aes-sha2") */
    algorithm?: string;
    /** Key version / rotation counter */
    key_version?: number;
  };
  /** Last time this config was modified */
  updated_at: string;
  /** Who last modified this config */
  updated_by: string;
}

// ─── DB key ──────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'meta:matrix_auth_config';

// ─── Default config ──────────────────────────────────────────────────────────

function defaultConfig(): MatrixAuthConfig {
  return {
    enabled: false,
    allowed_homeservers: [],
    allowed_accounts: [],
    encryption: { enabled: false },
    updated_at: new Date().toISOString(),
    updated_by: 'system',
  };
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export async function getMatrixAuthConfig(db: EoDb): Promise<MatrixAuthConfig> {
  try {
    const buf = await db.get(CONFIG_KEY);
    return decode(buf) as MatrixAuthConfig;
  } catch (e: any) {
    if (e.code === 'LEVEL_NOT_FOUND') return defaultConfig();
    throw e;
  }
}

export async function setMatrixAuthConfig(db: EoDb, config: MatrixAuthConfig): Promise<void> {
  await db.put(CONFIG_KEY, encode(config));
}

// ─── Convenience helpers ─────────────────────────────────────────────────────

/** Toggle Matrix auth gating on or off. */
export async function setMatrixAuthEnabled(
  db: EoDb,
  enabled: boolean,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  config.enabled = enabled;
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Add a Matrix account to the allowlist. Returns updated config. */
export async function addAllowedAccount(
  db: EoDb,
  user_id: string,
  actor: string,
  label?: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);

  // Prevent duplicates
  if (config.allowed_accounts.some(a => a.user_id === user_id)) {
    return config;
  }

  config.allowed_accounts.push({
    user_id,
    label,
    added_at: new Date().toISOString(),
    added_by: actor,
  });
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Remove a Matrix account from the allowlist. */
export async function removeAllowedAccount(
  db: EoDb,
  user_id: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  config.allowed_accounts = config.allowed_accounts.filter(a => a.user_id !== user_id);
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Add a homeserver to the allowed list. */
export async function addAllowedHomeserver(
  db: EoDb,
  homeserver: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  if (!config.allowed_homeservers.includes(homeserver)) {
    config.allowed_homeservers.push(homeserver);
    config.updated_at = new Date().toISOString();
    config.updated_by = actor;
    await setMatrixAuthConfig(db, config);
  }
  return config;
}

/** Remove a homeserver from the allowed list. */
export async function removeAllowedHomeserver(
  db: EoDb,
  homeserver: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  config.allowed_homeservers = config.allowed_homeservers.filter(h => h !== homeserver);
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/**
 * Check whether a given Matrix user_id is allowed under current config.
 * Returns true if:
 *   - Matrix auth gating is disabled (open access), OR
 *   - The user_id is in the allowlist
 */
export async function isAccountAllowed(db: EoDb, user_id: string): Promise<boolean> {
  const config = await getMatrixAuthConfig(db);
  if (!config.enabled) return true;
  return config.allowed_accounts.some(a => a.user_id === user_id);
}

/**
 * Check whether a homeserver is allowed under current config.
 * Returns true if:
 *   - Matrix auth gating is disabled, OR
 *   - allowed_homeservers is empty (no restriction), OR
 *   - The homeserver is in the allowlist
 */
export async function isHomeserverAllowed(db: EoDb, homeserver: string): Promise<boolean> {
  const config = await getMatrixAuthConfig(db);
  if (!config.enabled) return true;
  if (config.allowed_homeservers.length === 0) return true;
  return config.allowed_homeservers.includes(homeserver);
}
