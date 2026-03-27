import type { EoDb } from '../db/level.js';
import { encode, decode } from '../db/level.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Granular access level: read-only, write-only, or full read+write. */
export type AccessLevel = 'read' | 'write' | 'read_write';

/**
 * How a homeserver's users are handled:
 *   - accept_all:  every user from this server gets default_access
 *   - whitelist:   only explicitly listed users are allowed
 *   - blacklist:   all users allowed EXCEPT explicitly blocked ones
 */
export type ServerAccessMode = 'accept_all' | 'whitelist' | 'blacklist';

/** Per-homeserver access policy. */
export interface ServerRule {
  /** Homeserver domain, e.g. "app.aminoimmigration.com" */
  homeserver: string;
  /** How users from this server are filtered */
  mode: ServerAccessMode;
  /** Default access level when mode is accept_all or blacklist */
  default_access: AccessLevel;
  /** When this rule was created */
  added_at: string;
  /** Who created this rule */
  added_by: string;
}

/** A single allowed Matrix account with access level. */
export interface AllowedMatrixAccount {
  /** Full Matrix user ID, e.g. "@user:app.aminoimmigration.com" */
  user_id: string;
  /** Human-readable label for this account (optional) */
  label?: string;
  /** What this account can do */
  access: AccessLevel;
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

/** An explicitly blocked Matrix account. */
export interface BlacklistedAccount {
  /** Full Matrix user ID */
  user_id: string;
  /** Why this account was blocked */
  reason?: string;
  /** When this account was blocked */
  added_at: string;
  /** Who blocked this account */
  added_by: string;
}

/**
 * A named bucket of access rules — groups users and/or entire homeservers
 * under a shared access level. Useful for team-based permissions like
 * "read-only-auditors" or "intake-writers".
 */
export interface UserRulesBucket {
  /** Unique bucket identifier (slug-style, e.g. "intake-writers") */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Access level granted to all members of this bucket */
  access: AccessLevel;
  /** Individual Matrix user IDs in this bucket */
  members: string[];
  /** Entire homeserver domains — all users from these servers get bucket access */
  server_members: string[];
  /** When this bucket was created */
  created_at: string;
  /** Who created this bucket */
  created_by: string;
  /** When this bucket was last modified */
  updated_at: string;
  /** Who last modified this bucket */
  updated_by: string;
}

/** Persistent configuration for Matrix auth on this database instance. */
export interface MatrixAuthConfig {
  /** Whether Matrix account-level auth gating is enabled */
  enabled: boolean;

  /** Per-homeserver access policies */
  server_rules: ServerRule[];

  /** Explicitly allowed Matrix accounts with access levels */
  allowed_accounts: AllowedMatrixAccount[];

  /** Explicitly blocked accounts (always denied regardless of other rules) */
  blacklisted_accounts: BlacklistedAccount[];

  /** Named rule groups for team-based access control */
  user_rules_buckets: UserRulesBucket[];

  /**
   * Legacy: homeserver strings from the original schema.
   * Kept so old configs deserialize without data loss.
   * New code uses server_rules instead.
   */
  allowed_homeservers: string[];

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

/** Result of an access check: what the user can do. */
export interface AccessCheckResult {
  /** Whether access is granted at all */
  allowed: boolean;
  /** The effective access level (only meaningful when allowed=true) */
  access: AccessLevel;
  /** Which rule granted the access (for audit/debugging) */
  source?: 'disabled' | 'account' | 'blacklist' | 'bucket' | 'server_rule' | 'denied';
}

// ─── DB key ──────────────────────────────────────────────────────────────────

const CONFIG_KEY = 'meta:matrix_auth_config';

// ─── Default config ──────────────────────────────────────────────────────────

function defaultConfig(): MatrixAuthConfig {
  return {
    enabled: false,
    server_rules: [],
    allowed_accounts: [],
    blacklisted_accounts: [],
    user_rules_buckets: [],
    allowed_homeservers: [],
    encryption: { enabled: false },
    updated_at: new Date().toISOString(),
    updated_by: 'system',
  };
}

/**
 * Ensure a config loaded from DB has all fields (handles upgrades from
 * older schemas that predate server_rules, blacklist, buckets, etc.).
 */
function normalizeConfig(raw: any): MatrixAuthConfig {
  const base = defaultConfig();
  return {
    ...base,
    ...raw,
    server_rules: raw.server_rules ?? [],
    blacklisted_accounts: raw.blacklisted_accounts ?? [],
    user_rules_buckets: raw.user_rules_buckets ?? [],
    allowed_homeservers: raw.allowed_homeservers ?? [],
    // Migrate old accounts that lack an `access` field
    allowed_accounts: (raw.allowed_accounts ?? []).map((a: any) => ({
      ...a,
      access: a.access ?? 'read_write',
    })),
    encryption: { ...base.encryption, ...(raw.encryption ?? {}) },
  };
}

// ─── Read / Write ────────────────────────────────────────────────────────────

export async function getMatrixAuthConfig(db: EoDb): Promise<MatrixAuthConfig> {
  try {
    const buf = await db.get(CONFIG_KEY);
    return normalizeConfig(decode(buf));
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

// ─── Account allowlist ───────────────────────────────────────────────────────

/** Add a Matrix account to the allowlist with an access level. Returns updated config. */
export async function addAllowedAccount(
  db: EoDb,
  user_id: string,
  actor: string,
  label?: string,
  access: AccessLevel = 'read_write',
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);

  // Prevent duplicates — update access if already present
  const existing = config.allowed_accounts.find(a => a.user_id === user_id);
  if (existing) {
    existing.access = access;
    if (label !== undefined) existing.label = label;
    config.updated_at = new Date().toISOString();
    config.updated_by = actor;
    await setMatrixAuthConfig(db, config);
    return config;
  }

  config.allowed_accounts.push({
    user_id,
    label,
    access,
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

// ─── Blacklist ───────────────────────────────────────────────────────────────

/** Add a Matrix account to the blacklist. */
export async function addBlacklistedAccount(
  db: EoDb,
  user_id: string,
  actor: string,
  reason?: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  if (config.blacklisted_accounts.some(a => a.user_id === user_id)) {
    return config;
  }
  config.blacklisted_accounts.push({
    user_id,
    reason,
    added_at: new Date().toISOString(),
    added_by: actor,
  });
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Remove a Matrix account from the blacklist. */
export async function removeBlacklistedAccount(
  db: EoDb,
  user_id: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  config.blacklisted_accounts = config.blacklisted_accounts.filter(a => a.user_id !== user_id);
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

// ─── Server rules ────────────────────────────────────────────────────────────

/** Add or update a server rule. */
export async function setServerRule(
  db: EoDb,
  homeserver: string,
  mode: ServerAccessMode,
  default_access: AccessLevel,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  const existing = config.server_rules.find(r => r.homeserver === homeserver);
  if (existing) {
    existing.mode = mode;
    existing.default_access = default_access;
  } else {
    config.server_rules.push({
      homeserver,
      mode,
      default_access,
      added_at: new Date().toISOString(),
      added_by: actor,
    });
  }
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Remove a server rule. */
export async function removeServerRule(
  db: EoDb,
  homeserver: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  config.server_rules = config.server_rules.filter(r => r.homeserver !== homeserver);
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

// ─── Legacy homeserver allowlist (kept for compatibility) ────────────────────

/** Add a homeserver to the legacy allowed list. */
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

/** Remove a homeserver from the legacy allowed list. */
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

// ─── User rules buckets ─────────────────────────────────────────────────────

/** Create a new user rules bucket. */
export async function createUserRulesBucket(
  db: EoDb,
  name: string,
  access: AccessLevel,
  actor: string,
  description?: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  if (config.user_rules_buckets.some(b => b.name === name)) {
    throw new Error(`Bucket "${name}" already exists`);
  }
  const now = new Date().toISOString();
  config.user_rules_buckets.push({
    name,
    description,
    access,
    members: [],
    server_members: [],
    created_at: now,
    created_by: actor,
    updated_at: now,
    updated_by: actor,
  });
  config.updated_at = now;
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Delete a user rules bucket. */
export async function deleteUserRulesBucket(
  db: EoDb,
  name: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  config.user_rules_buckets = config.user_rules_buckets.filter(b => b.name !== name);
  config.updated_at = new Date().toISOString();
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Update a bucket's access level or description. */
export async function updateUserRulesBucket(
  db: EoDb,
  name: string,
  actor: string,
  updates: { access?: AccessLevel; description?: string },
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  const bucket = config.user_rules_buckets.find(b => b.name === name);
  if (!bucket) throw new Error(`Bucket "${name}" not found`);
  if (updates.access !== undefined) bucket.access = updates.access;
  if (updates.description !== undefined) bucket.description = updates.description;
  bucket.updated_at = new Date().toISOString();
  bucket.updated_by = actor;
  config.updated_at = bucket.updated_at;
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Add a member (user_id) to a bucket. */
export async function addBucketMember(
  db: EoDb,
  bucket_name: string,
  user_id: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  const bucket = config.user_rules_buckets.find(b => b.name === bucket_name);
  if (!bucket) throw new Error(`Bucket "${bucket_name}" not found`);
  if (!bucket.members.includes(user_id)) {
    bucket.members.push(user_id);
    bucket.updated_at = new Date().toISOString();
    bucket.updated_by = actor;
    config.updated_at = bucket.updated_at;
    config.updated_by = actor;
    await setMatrixAuthConfig(db, config);
  }
  return config;
}

/** Remove a member from a bucket. */
export async function removeBucketMember(
  db: EoDb,
  bucket_name: string,
  user_id: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  const bucket = config.user_rules_buckets.find(b => b.name === bucket_name);
  if (!bucket) throw new Error(`Bucket "${bucket_name}" not found`);
  bucket.members = bucket.members.filter(m => m !== user_id);
  bucket.updated_at = new Date().toISOString();
  bucket.updated_by = actor;
  config.updated_at = bucket.updated_at;
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

/** Add a homeserver to a bucket (all users from that server get bucket access). */
export async function addBucketServerMember(
  db: EoDb,
  bucket_name: string,
  homeserver: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  const bucket = config.user_rules_buckets.find(b => b.name === bucket_name);
  if (!bucket) throw new Error(`Bucket "${bucket_name}" not found`);
  if (!bucket.server_members.includes(homeserver)) {
    bucket.server_members.push(homeserver);
    bucket.updated_at = new Date().toISOString();
    bucket.updated_by = actor;
    config.updated_at = bucket.updated_at;
    config.updated_by = actor;
    await setMatrixAuthConfig(db, config);
  }
  return config;
}

/** Remove a homeserver from a bucket. */
export async function removeBucketServerMember(
  db: EoDb,
  bucket_name: string,
  homeserver: string,
  actor: string,
): Promise<MatrixAuthConfig> {
  const config = await getMatrixAuthConfig(db);
  const bucket = config.user_rules_buckets.find(b => b.name === bucket_name);
  if (!bucket) throw new Error(`Bucket "${bucket_name}" not found`);
  bucket.server_members = bucket.server_members.filter(s => s !== homeserver);
  bucket.updated_at = new Date().toISOString();
  bucket.updated_by = actor;
  config.updated_at = bucket.updated_at;
  config.updated_by = actor;
  await setMatrixAuthConfig(db, config);
  return config;
}

// ─── Access helpers ─────────────────────────────────────────────────────────

/** Extract the homeserver domain from a Matrix user ID. */
export function extractHomeserver(user_id: string): string {
  const idx = user_id.indexOf(':');
  return idx >= 0 ? user_id.slice(idx + 1) : '';
}

/** Check if an access level satisfies a requested operation. */
export function accessSatisfies(granted: AccessLevel, requested: 'read' | 'write'): boolean {
  if (granted === 'read_write') return true;
  return granted === requested;
}

/** Merge two access levels (most permissive wins). */
function mergeAccess(a: AccessLevel, b: AccessLevel): AccessLevel {
  if (a === 'read_write' || b === 'read_write') return 'read_write';
  if ((a === 'read' && b === 'write') || (a === 'write' && b === 'read')) return 'read_write';
  return a; // both same
}

/**
 * Full access check for a Matrix user_id.
 *
 * Evaluation order (first match wins, except buckets which merge):
 *   1. Auth disabled → allow read_write
 *   2. Blacklisted → deny
 *   3. Explicit account entry → use its access level
 *   4. User rules buckets → merge all matching bucket access levels
 *   5. Server rule for user's homeserver:
 *      - accept_all → grant default_access
 *      - whitelist  → deny (not in account list, already checked)
 *      - blacklist  → grant default_access (not in blacklist, already checked)
 *   6. Legacy allowed_homeservers check → read_write if matched
 *   7. No match → deny
 */
export async function checkAccess(db: EoDb, user_id: string): Promise<AccessCheckResult> {
  const config = await getMatrixAuthConfig(db);

  // 1. Auth disabled — open access
  if (!config.enabled) {
    return { allowed: true, access: 'read_write', source: 'disabled' };
  }

  // 2. Blacklist — always deny
  if (config.blacklisted_accounts.some(a => a.user_id === user_id)) {
    return { allowed: false, access: 'read', source: 'blacklist' };
  }

  // 3. Explicit account entry
  const account = config.allowed_accounts.find(a => a.user_id === user_id);
  if (account) {
    return { allowed: true, access: account.access, source: 'account' };
  }

  // 4. User rules buckets — collect all matching
  const homeserver = extractHomeserver(user_id);
  let bucketAccess: AccessLevel | null = null;
  for (const bucket of config.user_rules_buckets) {
    const memberMatch = bucket.members.includes(user_id);
    const serverMatch = bucket.server_members.includes(homeserver);
    if (memberMatch || serverMatch) {
      bucketAccess = bucketAccess ? mergeAccess(bucketAccess, bucket.access) : bucket.access;
    }
  }
  if (bucketAccess) {
    return { allowed: true, access: bucketAccess, source: 'bucket' };
  }

  // 5. Server rules
  const serverRule = config.server_rules.find(r => r.homeserver === homeserver);
  if (serverRule) {
    switch (serverRule.mode) {
      case 'accept_all':
        return { allowed: true, access: serverRule.default_access, source: 'server_rule' };
      case 'blacklist':
        // Not in blacklist (checked above) → allowed
        return { allowed: true, access: serverRule.default_access, source: 'server_rule' };
      case 'whitelist':
        // Not in account list (checked above) → denied
        return { allowed: false, access: 'read', source: 'denied' };
    }
  }

  // 6. Legacy allowed_homeservers
  if (config.allowed_homeservers.length > 0 && config.allowed_homeservers.includes(homeserver)) {
    return { allowed: true, access: 'read_write', source: 'server_rule' };
  }

  // 7. No match → deny
  return { allowed: false, access: 'read', source: 'denied' };
}

/**
 * Backwards-compatible check: is this account allowed at all?
 * Uses the new checkAccess under the hood.
 */
export async function isAccountAllowed(db: EoDb, user_id: string): Promise<boolean> {
  const result = await checkAccess(db, user_id);
  return result.allowed;
}

/**
 * Check whether a homeserver is allowed under current config.
 * Returns true if:
 *   - Matrix auth gating is disabled, OR
 *   - A server_rule exists for this homeserver (accept_all or blacklist), OR
 *   - allowed_homeservers is empty (no restriction), OR
 *   - The homeserver is in the legacy allowlist
 */
export async function isHomeserverAllowed(db: EoDb, homeserver: string): Promise<boolean> {
  const config = await getMatrixAuthConfig(db);
  if (!config.enabled) return true;

  // Check server_rules
  const rule = config.server_rules.find(r => r.homeserver === homeserver);
  if (rule) return rule.mode !== 'whitelist' || true; // whitelist still allows the server, just gates users

  // Legacy: empty list = no restriction
  if (config.allowed_homeservers.length === 0) return true;
  return config.allowed_homeservers.includes(homeserver);
}
