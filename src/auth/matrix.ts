import type { FastifyRequest, FastifyReply } from 'fastify';

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

export function setAuthConfig(config: { homeserver?: string; webhookSecret?: string }): void {
  if (config.homeserver) matrixHomeserver = config.homeserver;
  if (config.webhookSecret) webhookSecret = config.webhookSecret;
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
  } catch (e) {
    reply.code(401).send({ error: 'Authentication failed' });
    return;
  }
}
