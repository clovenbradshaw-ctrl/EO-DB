import type { FastifyRequest, FastifyReply } from 'fastify';
import type { EoDb } from '../db/level.js';
import { checkAccess, accessSatisfies, addAllowedAccount, type AccessCheckResult } from './matrix-auth-config.js';

export interface MatrixUser {
  user_id: string;
  device_id?: string;
}

interface CacheEntry {
  user: MatrixUser;
  expires: number;
}

const tokenCache = new Map<string, CacheEntry>();
const CACHE_TTL = 300_000; // 5 minutes

let matrixHomeserver = process.env.EO_MATRIX_HOMESERVER || 'https://app.aminoimmigration.com';
let webhookSecret = process.env.EO_WEBHOOK_SECRET || '';

/** The DB handle used by authMiddleware for access checks. */
let authDb: EoDb | null = null;

export function setAuthConfig(config: { homeserver?: string; webhookSecret?: string }): void {
  if (config.homeserver) matrixHomeserver = config.homeserver;
  if (config.webhookSecret) webhookSecret = config.webhookSecret;
}

/** Provide the DB reference so the middleware can check access rules. */
export function setAuthDb(db: EoDb): void {
  authDb = db;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}

export async function verifyMatrixToken(accessToken: string): Promise<MatrixUser> {
  const cached = tokenCache.get(accessToken);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  const response = await fetch(`${matrixHomeserver}/_matrix/client/v3/account/whoami`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Invalid Matrix token');
  }

  const data = await response.json() as { user_id: string; device_id?: string };
  const user: MatrixUser = {
    user_id: data.user_id,
    device_id: data.device_id,
  };

  tokenCache.set(accessToken, { user, expires: Date.now() + CACHE_TTL });
  return user;
}

export function verifyWebhookSecret(secret: string): MatrixUser {
  if (!webhookSecret || secret !== webhookSecret) {
    throw new Error('Invalid webhook secret');
  }
  return { user_id: '@n8n:app.aminoimmigration.com' };
}

export interface AuthenticatedRequest extends FastifyRequest {
  matrixUser?: MatrixUser;
  /** The resolved access check result — available after auth middleware runs. */
  accessCheck?: AccessCheckResult;
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
 * If the user is not found in any rule, auto-add them to the allowlist
 * with read_write access — the model is "authenticated = allowed unless
 * explicitly blacklisted or removed".
 * Skipped when no DB is attached.
 */
async function enforceAccess(user_id: string, method: string): Promise<AccessCheckResult> {
  if (!authDb) {
    return { allowed: true, access: 'read_write', source: 'disabled' };
  }
  let result = await checkAccess(authDb, user_id);
  if (!result.allowed && result.source !== 'blacklist') {
    // Auto-add authenticated users who aren't blacklisted
    await addAllowedAccount(authDb, user_id, 'system:auto', 'Auto-added on login');
    result = { allowed: true, access: 'read_write', source: 'account' };
  }
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
