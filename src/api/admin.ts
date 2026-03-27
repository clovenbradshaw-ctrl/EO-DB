import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import {
  getMatrixAuthConfig,
  setMatrixAuthEnabled,
  addAllowedAccount,
  removeAllowedAccount,
  addAllowedHomeserver,
  removeAllowedHomeserver,
} from '../auth/matrix-auth-config.js';

/**
 * Admin routes for managing Matrix auth configuration.
 * All routes are auth-protected (registered inside the protected scope).
 */
export function registerAdminRoutes(app: FastifyInstance, db: EoDb): void {
  // GET /admin/matrix-auth — read current config
  app.get('/admin/matrix-auth', async (request: AuthenticatedRequest, reply) => {
    const config = await getMatrixAuthConfig(db);
    return reply.send(config);
  });

  // PUT /admin/matrix-auth/enabled — toggle on/off
  app.put('/admin/matrix-auth/enabled', async (request: AuthenticatedRequest, reply) => {
    const { enabled } = request.body as { enabled: boolean };
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'Field "enabled" must be a boolean' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await setMatrixAuthEnabled(db, enabled, actor);
    return reply.send(config);
  });

  // POST /admin/matrix-auth/accounts — add an allowed account
  app.post('/admin/matrix-auth/accounts', async (request: AuthenticatedRequest, reply) => {
    const { user_id, label } = request.body as { user_id: string; label?: string };
    if (!user_id || typeof user_id !== 'string') {
      return reply.code(400).send({ error: 'Field "user_id" is required (e.g. "@user:app.aminoimmigration.com")' });
    }
    // Basic Matrix user ID format check
    if (!user_id.startsWith('@') || !user_id.includes(':')) {
      return reply.code(400).send({ error: 'Invalid Matrix user ID format. Expected "@localpart:homeserver"' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await addAllowedAccount(db, user_id, actor, label);
    return reply.send(config);
  });

  // DELETE /admin/matrix-auth/accounts/:user_id — remove an allowed account
  app.delete('/admin/matrix-auth/accounts/:user_id', async (request: AuthenticatedRequest, reply) => {
    const { user_id } = request.params as { user_id: string };
    if (!user_id) {
      return reply.code(400).send({ error: 'Missing user_id parameter' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await removeAllowedAccount(db, decodeURIComponent(user_id), actor);
    return reply.send(config);
  });

  // POST /admin/matrix-auth/homeservers — add an allowed homeserver
  app.post('/admin/matrix-auth/homeservers', async (request: AuthenticatedRequest, reply) => {
    const { homeserver } = request.body as { homeserver: string };
    if (!homeserver || typeof homeserver !== 'string') {
      return reply.code(400).send({ error: 'Field "homeserver" is required (e.g. "https://app.aminoimmigration.com")' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await addAllowedHomeserver(db, homeserver, actor);
    return reply.send(config);
  });

  // DELETE /admin/matrix-auth/homeservers/:homeserver — remove an allowed homeserver
  app.delete('/admin/matrix-auth/homeservers/:homeserver', async (request: AuthenticatedRequest, reply) => {
    const { homeserver } = request.params as { homeserver: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await removeAllowedHomeserver(db, decodeURIComponent(homeserver), actor);
    return reply.send(config);
  });
}
