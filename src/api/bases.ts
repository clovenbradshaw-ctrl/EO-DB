import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { AccessLevel } from '../auth/matrix-auth-config.js';
import {
  createBase,
  getBase,
  updateBase,
  deleteBase,
  listBasesForUser,
  addBaseShare,
  updateBaseShare,
  removeBaseShare,
  getBaseSharing,
} from '../db/bases.js';

const VALID_ACCESS_LEVELS: AccessLevel[] = ['read', 'write', 'read_write'];

function validateAccessLevel(value: any): value is AccessLevel {
  return VALID_ACCESS_LEVELS.includes(value);
}

function validateMatrixUserId(user_id: any): boolean {
  return typeof user_id === 'string' && user_id.startsWith('@') && user_id.includes(':');
}

/**
 * API routes for managing bases and per-base sharing.
 * All routes are auth-protected (registered inside the protected scope).
 */
export function registerBasesRoutes(app: FastifyInstance, db: EoDb): void {

  // ─── Base CRUD ──────────────────────────────────────────────────────────

  // POST /bases — create a new base
  app.post('/bases', async (request: AuthenticatedRequest, reply) => {
    const { name, description } = request.body as { name: string; description?: string };
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Field "name" is required and must be a non-empty string' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const base = await createBase(db, name.trim(), actor, description);
    return reply.code(201).send(base);
  });

  // GET /bases — list bases accessible to the current user
  app.get('/bases', async (request: AuthenticatedRequest, reply) => {
    const actor = request.matrixUser?.user_id || 'unknown';
    const bases = await listBasesForUser(db, actor);
    return reply.send({ bases });
  });

  // GET /bases/:id — get a single base
  app.get('/bases/:id', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    const base = await getBase(db, id);
    if (!base) {
      return reply.code(404).send({ error: 'Base not found' });
    }
    // Check access
    const isOwner = base.created_by === actor;
    const hasShare = base.sharing.some(s => s.user_id === actor);
    if (!isOwner && !hasShare) {
      return reply.code(403).send({ error: 'You do not have access to this base' });
    }
    return reply.send(base);
  });

  // PUT /bases/:id — update a base (name/description, owner only)
  app.put('/bases/:id', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const { name, description } = request.body as { name?: string; description?: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const base = await updateBase(db, id, actor, { name, description });
      return reply.send(base);
    } catch (e: any) {
      if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
      if (e.message.includes('owner')) return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  // DELETE /bases/:id — delete a base (owner only)
  app.delete('/bases/:id', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      await deleteBase(db, id, actor);
      return reply.send({ deleted: true });
    } catch (e: any) {
      if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
      if (e.message.includes('owner')) return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  // ─── Sharing ────────────────────────────────────────────────────────────

  // GET /bases/:id/sharing — list sharing for a base
  app.get('/bases/:id/sharing', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const sharing = await getBaseSharing(db, id, actor);
      return reply.send(sharing);
    } catch (e: any) {
      if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
      if (e.message.includes('access')) return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  // POST /bases/:id/sharing — share a base with a Matrix user
  app.post('/bases/:id/sharing', async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    const { user_id, access } = request.body as { user_id: string; access?: AccessLevel };
    if (!validateMatrixUserId(user_id)) {
      return reply.code(400).send({ error: 'Invalid or missing "user_id". Expected "@localpart:homeserver"' });
    }
    const effectiveAccess = access ?? 'read';
    if (!validateAccessLevel(effectiveAccess)) {
      return reply.code(400).send({ error: `Invalid "access". Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const base = await addBaseShare(db, id, user_id, effectiveAccess, actor);
      return reply.send(base);
    } catch (e: any) {
      if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
      if (e.message.includes('owner')) return reply.code(403).send({ error: e.message });
      if (e.message.includes('yourself')) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // PUT /bases/:id/sharing/:user_id — update sharing access level
  app.put('/bases/:id/sharing/:user_id', async (request: AuthenticatedRequest, reply) => {
    const { id, user_id } = request.params as { id: string; user_id: string };
    const { access } = request.body as { access: AccessLevel };
    if (!validateAccessLevel(access)) {
      return reply.code(400).send({ error: `Invalid "access". Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const base = await updateBaseShare(db, id, decodeURIComponent(user_id), access, actor);
      return reply.send(base);
    } catch (e: any) {
      if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
      if (e.message.includes('owner')) return reply.code(403).send({ error: e.message });
      if (e.message.includes('does not have')) return reply.code(404).send({ error: e.message });
      throw e;
    }
  });

  // DELETE /bases/:id/sharing/:user_id — remove a user's access
  app.delete('/bases/:id/sharing/:user_id', async (request: AuthenticatedRequest, reply) => {
    const { id, user_id } = request.params as { id: string; user_id: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const base = await removeBaseShare(db, id, decodeURIComponent(user_id), actor);
      return reply.send(base);
    } catch (e: any) {
      if (e.message.includes('not found')) return reply.code(404).send({ error: e.message });
      if (e.message.includes('owner')) return reply.code(403).send({ error: e.message });
      throw e;
    }
  });
}
