import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fetchWithRetry } from '../matrix/connection-resilience.js';
import { OfflineAuthManager } from '../auth/offline-auth.js';
import { getConnectionStatus } from '../auth/matrix.js';
import {
  encryptDatabase,
  decryptDatabase,
  hasEncryptedDatabase,
} from '../crypto/encrypted-local-store.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Auth proxy routes — unauthenticated endpoints that proxy Matrix login,
 * whoami, and profile lookups so the admin UI doesn't need to know the
 * homeserver URL or deal with CORS.
 *
 * Enhanced with:
 *   - Retry with exponential backoff on all homeserver calls
 *   - POST /auth/login falls back to encrypted offline cache
 *   - GET /auth/status returns connection health
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  homeserver: string,
  dataDir?: string,
  hooks?: { onLogout?: (password: string) => Promise<void>; onLogin?: (password: string) => Promise<void> },
): void {

  const resolvedDataDir = dataDir || './data';
  const encryptedDbPath = join(resolvedDataDir, 'db-encrypted.vault');

  // Offline auth manager (uses encrypted local store)
  const offlineAuth = new OfflineAuthManager(resolvedDataDir);

  // POST /auth/login — proxy to Matrix login, with offline fallback
  // Also decrypts the DB if it was encrypted on logout.
  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, password, homeserver: clientHomeserver } = request.body as {
      user?: string; password?: string; homeserver?: string;
    };

    if (!user || !password) {
      return reply.code(400).send({ error: 'Fields "user" and "password" are required' });
    }

    const targetHomeserver = (clientHomeserver || homeserver).replace(/\/+$/, '');

    try {
      const result = await offlineAuth.login(user, password, targetHomeserver);

      // If the DB was encrypted at logout, decrypt it now
      const dbEncrypted = await hasEncryptedDatabase(encryptedDbPath);
      if (dbEncrypted) {
        try {
          await hooks?.onLogout?.(password); // signal DB close if needed
          await decryptDatabase(encryptedDbPath, password, resolvedDataDir);
          await rm(encryptedDbPath, { force: true });
          await hooks?.onLogin?.(password); // signal DB reopen
        } catch (decryptErr: any) {
          app.log.error(`Failed to decrypt database on login: ${decryptErr.message}`);
          // Don't fail login — the session is valid, DB just needs manual recovery
        }
      }

      return reply.send({
        access_token: result.access_token,
        user_id: result.user_id,
        device_id: result.device_id,
        homeserver: result.homeserver,
        mode: result.mode,
        offline: result.mode === 'offline',
        db_decrypted: dbEncrypted,
      });
    } catch (e: any) {
      // If online login returned a definitive auth error, return 401
      if (e.message?.includes('login failed') || e.message?.includes('Invalid')) {
        return reply.code(401).send({ error: e.message });
      }
      // Homeserver unreachable and no offline cache
      return reply.code(503).send({ error: e.message });
    }
  });

  // POST /auth/logout — encrypt all local data and clear session
  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const { password } = request.body as { password?: string } || {};

    if (!password) {
      return reply.code(400).send({
        error: 'Password required to encrypt local data on logout',
      });
    }

    try {
      // Encrypt the database directory into a single vault file
      await encryptDatabase(resolvedDataDir, password, encryptedDbPath);

      // Clear the session cache (it's already inside the encrypted vault,
      // but we also want a clean state)
      await offlineAuth.clearSession();

      app.log.info('Local data encrypted on logout');
      return reply.send({ ok: true, encrypted: true });
    } catch (e: any) {
      app.log.error(`Failed to encrypt database on logout: ${e.message}`);
      return reply.code(500).send({ error: `Encryption failed: ${e.message}` });
    }
  });

  // GET /auth/whoami — verify a bearer token (with retry)
  app.get('/auth/whoami', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);

    try {
      const res = await fetchWithRetry(
        `${homeserver}/_matrix/client/v3/account/whoami`,
        { headers: { 'Authorization': `Bearer ${token}` } },
        { maxRetries: 2, baseDelay: 500 },
      );

      if (!res.ok) {
        return reply.code(res.status).send({ error: 'Invalid or expired token' });
      }

      const data = await res.json() as { user_id: string; device_id?: string };
      return reply.send({ user_id: data.user_id, device_id: data.device_id, offline: false });
    } catch (e: any) {
      return reply.code(502).send({ error: `Cannot reach homeserver: ${e.message}` });
    }
  });

  // GET /auth/profile — whoami + displayname lookup (with retry)
  app.get('/auth/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);

    try {
      const whoamiRes = await fetchWithRetry(
        `${homeserver}/_matrix/client/v3/account/whoami`,
        { headers: { 'Authorization': `Bearer ${token}` } },
        { maxRetries: 2, baseDelay: 500 },
      );

      if (!whoamiRes.ok) {
        return reply.code(whoamiRes.status).send({ error: 'Invalid or expired token' });
      }

      const whoami = await whoamiRes.json() as { user_id: string; device_id?: string };

      // Profile lookup is best-effort
      let displayname: string | null = null;
      try {
        const profileRes = await fetchWithRetry(
          `${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(whoami.user_id)}/displayname`,
          undefined,
          { maxRetries: 1, baseDelay: 500 },
        );
        if (profileRes.ok) {
          const profile = await profileRes.json() as { displayname?: string };
          displayname = profile.displayname || null;
        }
      } catch {
        // Profile lookup is best-effort
      }

      return reply.send({
        user_id: whoami.user_id,
        device_id: whoami.device_id,
        displayname,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: `Cannot reach homeserver: ${e.message}` });
    }
  });

  // GET /auth/status — connection health and offline capability
  app.get('/auth/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const hasCached = await offlineAuth.hasCachedSession();
    return reply.send({
      connection: getConnectionStatus(),
      offlineCapable: hasCached,
      homeserver,
    });
  });

  // POST /auth/change-password — re-encrypt the offline cache
  app.post('/auth/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const { old_password, new_password } = request.body as {
      old_password?: string; new_password?: string;
    };

    if (!old_password || !new_password) {
      return reply.code(400).send({ error: 'Fields "old_password" and "new_password" are required' });
    }

    try {
      await offlineAuth.changePassword(old_password, new_password);
      return reply.send({ ok: true });
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
