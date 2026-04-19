import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { EoDb } from '../db/level.js';
import { checkAccess, accessSatisfies, type AccessCheckResult } from './matrix-auth-config.js';
import { getHomeserver, getWebhookUser, configureMatrixDomain } from '../config/matrix-domain.js';
import { fetchWithRetry, type ConnectionStatus } from '../matrix/connection-resilience.js';

export interface MatrixUser {
  user_id: string;
  device_id?: string;
  /** Whether this user was authenticated offline (from cache). */
  offline?: boolean;
}

interface CacheEntry {
  user: MatrixUser;
  expires: number;
}

const tokenCache = new Map<string, CacheEntry>();
const CACHE_TTL = 300_000; // 5 minutes
const MAX_CACHE_SIZE = 1000; // cap to prevent unbounded growth

/** Extended cache for offline fallback — survives longer than the hot cache. */
const offlineTokenCache = new Map<string, { user: MatrixUser; cachedAt: number }>();
const OFFLINE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

let webhookSecret = process.env.EO_WEBHOOK_SECRET || '';

/** The DB handle used by authMiddleware for access checks. */
let authDb: EoDb | null = null;

/** Current connection status — updated by the connection monitor. */
let connectionStatus: ConnectionStatus = 'online';

export function setConnectionStatus(status: ConnectionStatus): void {
  connectionStatus = status;
}

export function getConnectionStatus(): ConnectionStatus {
  return connectionStatus;
}

export function setAuthConfig(config: { homeserver?: string; webhookSecret?: string; webhookUser?: string }): void {
  if (config.homeserver) configureMatrixDomain({ homeserver: config.homeserver });
  if (config.webhookUser) configureMatrixDomain({ webhookUser: config.webhookUser });
  if (config.webhookSecret) webhookSecret = config.webhookSecret;
}

/** Provide the DB reference so the middleware can check access rules. */
export function setAuthDb(db: EoDb): void {
  authDb = db;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

/**
 * Verify a Matrix access token — uses retry with backoff.
 * Falls back to offline cache when the homeserver is unreachable.
 */
export async function verifyMatrixToken(accessToken: string): Promise<MatrixUser> {
  // Check hot cache first
  const cached = tokenCache.get(accessToken);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  try {
    const response = await fetchWithRetry(
      `${getHomeserver()}/_matrix/client/v3/account/whoami`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } },
      { maxRetries: 2, baseDelay: 500, maxDelay: 5000 },
    );

    if (!response.ok) {
      // 5xx = server issue, try offline cache
      if (response.status >= 500) {
        throw new Error(`Homeserver returned ${response.status}`);
      }
      // Any other non-ok (401, 403, etc.) = genuinely invalid token
      offlineTokenCache.delete(accessToken);
      throw new Error('Invalid Matrix token');
    }

    const data = await response.json() as { user_id: string; device_id?: string };
    const user: MatrixUser = {
      user_id: data.user_id,
      device_id: data.device_id,
    };

    // Populate both caches
    evictExpiredTokens();
    tokenCache.set(accessToken, { user, expires: Date.now() + CACHE_TTL });
    offlineTokenCache.set(accessToken, { user, cachedAt: Date.now() });

    return user;
  } catch (err: any) {
    // If the error is a definitive auth rejection, don't try offline
    if (err.message === 'Invalid Matrix token') throw err;

    // Network/server error — try offline cache
    const offlineCached = offlineTokenCache.get(accessToken);
    if (offlineCached) {
      const age = Date.now() - offlineCached.cachedAt;
      if (age < OFFLINE_CACHE_TTL) {
        return { ...offlineCached.user, offline: true };
      }
      offlineTokenCache.delete(accessToken);
    }

    throw new Error(`Cannot reach homeserver and no cached session: ${err.message}`);
  }
}

function evictExpiredTokens(): void {
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [key, entry] of tokenCache) {
      if (entry.expires <= now) tokenCache.delete(key);
    }
    if (tokenCache.size >= MAX_CACHE_SIZE) {
      const excess = tokenCache.size - MAX_CACHE_SIZE + 1;
      const keys = tokenCache.keys();
      for (let i = 0; i < excess; i++) {
        tokenCache.delete(keys.next().value!);
      }
    }
  }
}

export function verifyWebhookSecret(secret: string): MatrixUser {
  if (!webhookSecret) {
    throw new Error('Webhook secret not configured');
  }
  const a = Buffer.from(secret);
  const b = Buffer.from(webhookSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid webhook secret');
  }
  const webhookUser = getWebhookUser();
  if (!webhookUser) {
    throw new Error('Webhook user not configured (set EO_WEBHOOK_USER)');
  }
  return { user_id: webhookUser };
}

export interface AuthenticatedRequest extends FastifyRequest {
  matrixUser?: MatrixUser;
  /** The resolved access check result — available after auth middleware runs. */
  accessCheck?: AccessCheckResult;
  /** True when the request was authenticated from offline cache. */
  offlineMode?: boolean;
}

/**
 * Determine the required access type for a request based on HTTP method.
 * GET/HEAD/OPTIONS → read, everything else → write.
 */
function requiredAccess(method: string): 'read' | 'write' {
  const readMethods = ['GET', 'HEAD', 'OPTIONS'];
  return readMethods.includes(method.toUpperCase()) ? 'read' : 'write';
}

/**
 * Check access rules for the authenticated user.
 * Skipped when no DB is attached.
 */
async function enforceAccess(user_id: string, method: string): Promise<AccessCheckResult> {
  if (!authDb) {
    return { allowed: true, access: 'read_write', source: 'disabled' };
  }
  const result = await checkAccess(authDb, user_id);
  if (!result.allowed) {
    throw new Error('Account not authorized for this database');
  }
  const needed = requiredAccess(method);
  if (!accessSatisfies(result.access, needed)) {
    throw new Error(`Account does not have ${needed} access`);
  }
  return result;
}

export async function authMiddleware(
  request: AuthenticatedRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    reply.code(401).send({ error: 'Missing Authorization header' });
    return;
  }

  try {
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      request.matrixUser = await verifyMatrixToken(token);
      request.offlineMode = request.matrixUser.offline ?? false;
    } else if (authHeader.startsWith('EoWebhook ')) {
      const secret = authHeader.slice(10);
      request.matrixUser = verifyWebhookSecret(secret);
    } else {
      reply.code(401).send({ error: 'Invalid Authorization format' });
      return;
    }

    // Enforce access rules (read vs write, blacklist, buckets, etc.)
    request.accessCheck = await enforceAccess(
      request.matrixUser!.user_id,
      request.method,
    );
  } catch (e: any) {
    const msg = e.message;
    if (msg === 'Account not authorized for this database' || msg.includes('does not have')) {
      reply.code(403).send({ error: msg });
    } else {
      reply.code(403).send({ error: 'Authentication failed' });
    }
    return;
  }
}
