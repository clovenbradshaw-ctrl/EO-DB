import type { FastifyRequest, FastifyReply } from 'fastify';
import type { EoDb } from '../db/level.js';
import { isAccountAllowed, addAllowedAccount, getMatrixAuthConfig } from './matrix-auth-config.js';

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

/** The DB handle used by authMiddleware for allowlist checks. */
let authDb: EoDb | null = null;

export function setAuthConfig(config: { homeserver?: string; webhookSecret?: string }): void {
  if (config.homeserver) matrixHomeserver = config.homeserver;
  if (config.webhookSecret) webhookSecret = config.webhookSecret;
}

/** Provide the DB reference so the middleware can check the account allowlist. */
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
}

/**
 * Verify that the authenticated user is on the account allowlist.
 * If auth gating is enabled and the user is not yet on the list,
 * auto-add them — the model is "authenticated = allowed unless removed".
 * Skipped when Matrix auth gating is disabled or no DB is attached.
 */
async function enforceAllowlist(user_id: string): Promise<void> {
  if (!authDb) return;
  const allowed = await isAccountAllowed(authDb, user_id);
  if (!allowed) {
    // Auto-add authenticated users to the allowlist
    const config = await getMatrixAuthConfig(authDb);
    if (config.enabled) {
      await addAllowedAccount(authDb, user_id, 'system:auto', 'Auto-added on login');
      return; // Now allowed
    }
  }
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

    // Enforce account allowlist (when Matrix auth gating is enabled)
    await enforceAllowlist(request.matrixUser!.user_id);
  } catch (e: any) {
    const message = e.message === 'Account not in allowlist'
      ? 'Account not authorized for this database'
      : 'Authentication failed';
    reply.code(403).send({ error: message });
    return;
  }
}
