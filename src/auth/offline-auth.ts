/**
 * Offline authentication — allows login without Matrix homeserver access.
 *
 * On successful online login, credentials (user_id, access_token, device_id,
 * homeserver) and the access check result are cached locally in an encrypted
 * store protected by the user's password.
 *
 * When the Matrix homeserver is unreachable, the system:
 *   1. Verifies the password against the encrypted local cache
 *   2. Restores the cached session (user_id, access level)
 *   3. Operates in offline mode with full local DB access
 *   4. Queues any writes for sync when Matrix becomes available
 *
 * The encrypted cache uses AES-256-GCM with PBKDF2 key derivation — the
 * password is the user's Matrix password, so no extra credential is needed.
 */

import { EncryptedLocalStore } from '../crypto/encrypted-local-store.js';
import { fetchWithRetry, type RetryOptions } from '../matrix/connection-resilience.js';
import type { AccessCheckResult } from './matrix-auth-config.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CachedSession {
  /** Matrix user ID (@user:server). */
  user_id: string;
  /** Matrix access token (encrypted at rest). */
  access_token: string;
  /** Matrix device ID. */
  device_id?: string;
  /** Homeserver URL used for this session. */
  homeserver: string;
  /** Cached access check result from last online auth. */
  accessCheck: AccessCheckResult;
  /** When this session was last verified online. */
  lastVerified: string;
  /** Password verification hash for offline auth. */
  passwordHash: string;
}

export interface OfflineLoginResult {
  /** Whether this login was verified online or from cache. */
  mode: 'online' | 'offline';
  /** The authenticated user. */
  user_id: string;
  /** Device ID (if known). */
  device_id?: string;
  /** Access token (from online login or cache). */
  access_token: string;
  /** Homeserver URL. */
  homeserver: string;
  /** Access check result. */
  accessCheck: AccessCheckResult;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Key name for the encrypted session file. */
const SESSION_STORE_NAME = 'session-cache';

/** How long a cached session is valid without re-verification (7 days). */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ─── OfflineAuthManager ─────────────────────────────────────────────────────

export class OfflineAuthManager {
  private store: EncryptedLocalStore;

  constructor(dataDir: string) {
    this.store = new EncryptedLocalStore(dataDir);
  }

  /**
   * Attempt login — tries online first, falls back to encrypted cache.
   *
   * Flow:
   *   1. Try Matrix login with retry
   *   2. On success: cache session encrypted with password, return online result
   *   3. On failure: try to decrypt cached session with password
   *   4. If cache valid and not expired: return offline result
   *   5. If no cache or wrong password: throw
   */
  async login(
    user: string,
    password: string,
    homeserver: string,
    accessCheck?: AccessCheckResult,
    retryOpts?: RetryOptions,
  ): Promise<OfflineLoginResult> {
    const targetHomeserver = homeserver.replace(/\/+$/, '');

    // Try online login first
    try {
      const result = await this.onlineLogin(user, password, targetHomeserver, retryOpts);

      // Cache the session for offline use
      const session: CachedSession = {
        user_id: result.user_id,
        access_token: result.access_token,
        device_id: result.device_id,
        homeserver: targetHomeserver,
        accessCheck: accessCheck ?? { allowed: true, access: 'read_write', source: 'disabled' },
        lastVerified: new Date().toISOString(),
        passwordHash: this.hashForVerification(password),
      };

      await this.cacheSession(session, password);

      return {
        mode: 'online',
        user_id: result.user_id,
        device_id: result.device_id,
        access_token: result.access_token,
        homeserver: targetHomeserver,
        accessCheck: session.accessCheck,
      };
    } catch (onlineErr: any) {
      // Online login failed — try offline cache
      return this.offlineLogin(password, onlineErr);
    }
  }

  /**
   * Verify an existing token — tries online, falls back to cache.
   */
  async verifyToken(
    accessToken: string,
    password: string,
    homeserver: string,
    retryOpts?: RetryOptions,
  ): Promise<OfflineLoginResult> {
    const targetHomeserver = homeserver.replace(/\/+$/, '');

    try {
      const response = await fetchWithRetry(
        `${targetHomeserver}/_matrix/client/v3/account/whoami`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } },
        { maxRetries: 2, baseDelay: 500, ...retryOpts },
      );

      if (response.ok) {
        const data = await response.json() as { user_id: string; device_id?: string };
        return {
          mode: 'online',
          user_id: data.user_id,
          device_id: data.device_id,
          access_token: accessToken,
          homeserver: targetHomeserver,
          accessCheck: { allowed: true, access: 'read_write', source: 'disabled' },
        };
      }

      // 401/403 means token is invalid — don't fall back to cache
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid or expired token');
      }

      // Server error — try cache
      throw new Error(`Homeserver returned ${response.status}`);
    } catch (err: any) {
      if (err.message === 'Invalid or expired token') throw err;
      return this.offlineLogin(password, err);
    }
  }

  /**
   * Cache a session after successful online authentication.
   * Called externally when auth middleware succeeds.
   */
  async cacheSession(session: CachedSession, password: string): Promise<void> {
    await this.store.put(SESSION_STORE_NAME, session, password);
  }

  /**
   * Update the cached access check (e.g., after admin changes permissions).
   */
  async updateCachedAccessCheck(
    password: string,
    accessCheck: AccessCheckResult,
  ): Promise<void> {
    const session = await this.store.get<CachedSession>(SESSION_STORE_NAME, password);
    if (session) {
      session.accessCheck = accessCheck;
      session.lastVerified = new Date().toISOString();
      await this.store.put(SESSION_STORE_NAME, session, password);
    }
  }

  /**
   * Check if a cached session exists (doesn't require password).
   */
  async hasCachedSession(): Promise<boolean> {
    return this.store.has(SESSION_STORE_NAME);
  }

  /**
   * Clear the cached session (e.g., on explicit logout).
   */
  async clearSession(): Promise<void> {
    await this.store.delete(SESSION_STORE_NAME);
  }

  /**
   * Change the encryption password for the cached session.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.store.changePassword(oldPassword, newPassword, [SESSION_STORE_NAME]);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async onlineLogin(
    user: string,
    password: string,
    homeserver: string,
    retryOpts?: RetryOptions,
  ): Promise<{ user_id: string; device_id?: string; access_token: string }> {
    const loginBody = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
    };

    const response = await fetchWithRetry(
      `${homeserver}/_matrix/client/v3/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginBody),
      },
      { maxRetries: 2, baseDelay: 1000, ...retryOpts },
    );

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((data.error as string) || `Matrix login failed (${response.status})`);
    }

    const data = await response.json() as {
      access_token: string;
      user_id: string;
      device_id?: string;
    };

    return {
      user_id: data.user_id,
      device_id: data.device_id,
      access_token: data.access_token,
    };
  }

  private async offlineLogin(
    password: string,
    onlineErr: Error,
  ): Promise<OfflineLoginResult> {
    // Try to decrypt cached session
    let session: CachedSession | null;
    try {
      session = await this.store.get<CachedSession>(SESSION_STORE_NAME, password);
    } catch (decryptErr: any) {
      // Wrong password or corrupted cache
      throw new Error(
        `Matrix homeserver unreachable (${onlineErr.message}) and offline login failed: ${decryptErr.message}`,
      );
    }

    if (!session) {
      throw new Error(
        `Matrix homeserver unreachable (${onlineErr.message}) and no cached session available`,
      );
    }

    // Check cache age
    const cacheAge = Date.now() - new Date(session.lastVerified).getTime();
    if (cacheAge > CACHE_MAX_AGE_MS) {
      throw new Error(
        `Matrix homeserver unreachable and cached session expired (${Math.floor(cacheAge / 86400000)}d old, max 7d)`,
      );
    }

    return {
      mode: 'offline',
      user_id: session.user_id,
      device_id: session.device_id,
      access_token: session.access_token,
      homeserver: session.homeserver,
      accessCheck: session.accessCheck,
    };
  }

  private hashForVerification(password: string): string {
    // Simple hash for quick password comparison — not used for encryption
    const { createHash } = require('node:crypto');
    return createHash('sha256').update(`eo-offline-verify:${password}`).digest('hex');
  }
}
