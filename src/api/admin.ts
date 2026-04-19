import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { AccessLevel, ServerAccessMode } from '../auth/matrix-auth-config.js';
import { softDeleteByPrefix, restoreByPrefix } from '../db/soft-delete.js';
import {
  getMatrixAuthConfig,
  setMatrixAuthEnabled,
  addAllowedAccount,
  removeAllowedAccount,
  addAllowedHomeserver,
  removeAllowedHomeserver,
  addBlacklistedAccount,
  removeBlacklistedAccount,
  setServerRule,
  removeServerRule,
  createUserRulesBucket,
  deleteUserRulesBucket,
  updateUserRulesBucket,
  addBucketMember,
  removeBucketMember,
  addBucketServerMember,
  removeBucketServerMember,
  findAccountsSameServer,
} from '../auth/matrix-auth-config.js';

const VALID_ACCESS_LEVELS: AccessLevel[] = ['read', 'write', 'read_write'];
const VALID_SERVER_MODES: ServerAccessMode[] = ['accept_all', 'whitelist', 'blacklist'];

const ADMIN_PREFIX_RE = /^[A-Za-z0-9:/_\-.]{1,256}$/;

function parseAdminPrefix(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!ADMIN_PREFIX_RE.test(decoded)) return null;
  return decoded;
}

function validateAccessLevel(value: any): value is AccessLevel {
  return VALID_ACCESS_LEVELS.includes(value);
}

function validateServerMode(value: any): value is ServerAccessMode {
  return VALID_SERVER_MODES.includes(value);
}

function validateMatrixUserId(user_id: any): boolean {
  return typeof user_id === 'string' && user_id.startsWith('@') && user_id.includes(':');
}

/**
 * Admin routes for managing Matrix auth configuration.
 * All routes are auth-protected (registered inside the protected scope).
 */
export function registerAdminRoutes(app: FastifyInstance, db: EoDb): void {
  // ─── Reset (clear entire DB) ────────────────────────────────────────────
  app.delete('/admin/reset', async (request: AuthenticatedRequest, reply) => {
    const keys: string[] = [];
    for await (const key of db.keys()) {
      keys.push(key);
    }
    const batch = db.batch();
    for (const key of keys) {
      batch.del(key);
    }
    await batch.write();
    return reply.send({ deleted: keys.length });
  });

  // ─── Soft-delete a table (by target prefix) ────────────────────────────
  // DELETE /admin/tables/:prefix — marks all entities under prefix as deleted.
  // Edges crossing the boundary are left as tombstones. No hard delete.
  app.delete('/admin/tables/:prefix', async (request: AuthenticatedRequest, reply) => {
    const { prefix } = request.params as { prefix: string };
    if (!prefix) {
      return reply.code(400).send({ error: 'Missing prefix parameter' });
    }
    const decoded = parseAdminPrefix(prefix);
    if (!decoded) {
      return reply.code(400).send({ error: 'Invalid prefix parameter' });
    }
    const agent = request.matrixUser?.user_id || 'unknown';
    try {
      const result = await softDeleteByPrefix(db, decoded, agent);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // POST /admin/tables/:prefix/restore — restores soft-deleted entities under prefix.
  app.post('/admin/tables/:prefix/restore', async (request: AuthenticatedRequest, reply) => {
    const { prefix } = request.params as { prefix: string };
    if (!prefix) {
      return reply.code(400).send({ error: 'Missing prefix parameter' });
    }
    const decoded = parseAdminPrefix(prefix);
    if (!decoded) {
      return reply.code(400).send({ error: 'Invalid prefix parameter' });
    }
    try {
      const result = await restoreByPrefix(db, decoded);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });

  // ─── Config ──────────────────────────────────────────────────────────────

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

  // ─── Same-server account discovery ──────────────────────────────────────

  // GET /admin/matrix-auth/same-server — find other accounts on the same homeserver
  app.get('/admin/matrix-auth/same-server', async (request: AuthenticatedRequest, reply) => {
    const query = request.query as { user_id?: string };
    // Use the provided user_id or fall back to the authenticated user
    const user_id = query.user_id
      ? decodeURIComponent(query.user_id)
      : request.matrixUser?.user_id;
    if (!user_id || !user_id.startsWith('@') || !user_id.includes(':')) {
      return reply.code(400).send({ error: 'Invalid or missing user_id. Expected "@localpart:homeserver"' });
    }
    const accounts = await findAccountsSameServer(db, user_id);
    const homeserver = user_id.slice(user_id.indexOf(':') + 1);
    return reply.send({ user_id, homeserver, accounts, count: accounts.length });
  });

  // ─── Account allowlist ───────────────────────────────────────────────────

  // POST /admin/matrix-auth/accounts — add an allowed account
  app.post('/admin/matrix-auth/accounts', async (request: AuthenticatedRequest, reply) => {
    const { user_id, label, access } = request.body as {
      user_id: string; label?: string; access?: AccessLevel;
    };
    if (!validateMatrixUserId(user_id)) {
      return reply.code(400).send({ error: 'Invalid or missing "user_id". Expected "@localpart:homeserver"' });
    }
    if (access !== undefined && !validateAccessLevel(access)) {
      return reply.code(400).send({ error: `Invalid "access". Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await addAllowedAccount(db, user_id, actor, label, access);
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

  // ─── Blacklist ───────────────────────────────────────────────────────────

  // POST /admin/matrix-auth/blacklist — add a blacklisted account
  app.post('/admin/matrix-auth/blacklist', async (request: AuthenticatedRequest, reply) => {
    const { user_id, reason } = request.body as { user_id: string; reason?: string };
    if (!validateMatrixUserId(user_id)) {
      return reply.code(400).send({ error: 'Invalid or missing "user_id". Expected "@localpart:homeserver"' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await addBlacklistedAccount(db, user_id, actor, reason);
    return reply.send(config);
  });

  // DELETE /admin/matrix-auth/blacklist/:user_id — remove from blacklist
  app.delete('/admin/matrix-auth/blacklist/:user_id', async (request: AuthenticatedRequest, reply) => {
    const { user_id } = request.params as { user_id: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await removeBlacklistedAccount(db, decodeURIComponent(user_id), actor);
    return reply.send(config);
  });

  // ─── Server rules ────────────────────────────────────────────────────────

  // PUT /admin/matrix-auth/server-rules — add or update a server rule
  app.put('/admin/matrix-auth/server-rules', async (request: AuthenticatedRequest, reply) => {
    const { homeserver, mode, default_access } = request.body as {
      homeserver: string; mode: ServerAccessMode; default_access: AccessLevel;
    };
    if (!homeserver || typeof homeserver !== 'string') {
      return reply.code(400).send({ error: 'Field "homeserver" is required' });
    }
    if (!validateServerMode(mode)) {
      return reply.code(400).send({ error: `Invalid "mode". Must be one of: ${VALID_SERVER_MODES.join(', ')}` });
    }
    if (!validateAccessLevel(default_access)) {
      return reply.code(400).send({ error: `Invalid "default_access". Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await setServerRule(db, homeserver, mode, default_access, actor);
    return reply.send(config);
  });

  // DELETE /admin/matrix-auth/server-rules/:homeserver — remove a server rule
  app.delete('/admin/matrix-auth/server-rules/:homeserver', async (request: AuthenticatedRequest, reply) => {
    const { homeserver } = request.params as { homeserver: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await removeServerRule(db, decodeURIComponent(homeserver), actor);
    return reply.send(config);
  });

  // ─── Legacy homeserver allowlist ─────────────────────────────────────────

  // POST /admin/matrix-auth/homeservers — add an allowed homeserver
  app.post('/admin/matrix-auth/homeservers', async (request: AuthenticatedRequest, reply) => {
    const { homeserver } = request.body as { homeserver: string };
    if (!homeserver || typeof homeserver !== 'string') {
      return reply.code(400).send({ error: 'Field "homeserver" is required (e.g. "https://matrix.example.com")' });
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

  // ─── User rules buckets ──────────────────────────────────────────────────

  // POST /admin/matrix-auth/buckets — create a bucket
  app.post('/admin/matrix-auth/buckets', async (request: AuthenticatedRequest, reply) => {
    const { name, access, description } = request.body as {
      name: string; access: AccessLevel; description?: string;
    };
    if (!name || typeof name !== 'string') {
      return reply.code(400).send({ error: 'Field "name" is required' });
    }
    if (!validateAccessLevel(access)) {
      return reply.code(400).send({ error: `Invalid "access". Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const config = await createUserRulesBucket(db, name, access, actor, description);
      return reply.code(201).send(config);
    } catch (e: any) {
      return reply.code(409).send({ error: e.message });
    }
  });

  // PUT /admin/matrix-auth/buckets/:name — update a bucket
  app.put('/admin/matrix-auth/buckets/:name', async (request: AuthenticatedRequest, reply) => {
    const { name } = request.params as { name: string };
    const { access, description } = request.body as { access?: AccessLevel; description?: string };
    if (access !== undefined && !validateAccessLevel(access)) {
      return reply.code(400).send({ error: `Invalid "access". Must be one of: ${VALID_ACCESS_LEVELS.join(', ')}` });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const config = await updateUserRulesBucket(db, name, actor, { access, description });
      return reply.send(config);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // DELETE /admin/matrix-auth/buckets/:name — delete a bucket
  app.delete('/admin/matrix-auth/buckets/:name', async (request: AuthenticatedRequest, reply) => {
    const { name } = request.params as { name: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    const config = await deleteUserRulesBucket(db, name, actor);
    return reply.send(config);
  });

  // POST /admin/matrix-auth/buckets/:name/members — add a user to a bucket
  app.post('/admin/matrix-auth/buckets/:name/members', async (request: AuthenticatedRequest, reply) => {
    const { name } = request.params as { name: string };
    const { user_id } = request.body as { user_id: string };
    if (!validateMatrixUserId(user_id)) {
      return reply.code(400).send({ error: 'Invalid or missing "user_id". Expected "@localpart:homeserver"' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const config = await addBucketMember(db, name, user_id, actor);
      return reply.send(config);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // DELETE /admin/matrix-auth/buckets/:name/members/:user_id — remove a user from a bucket
  app.delete('/admin/matrix-auth/buckets/:name/members/:user_id', async (request: AuthenticatedRequest, reply) => {
    const { name, user_id } = request.params as { name: string; user_id: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const config = await removeBucketMember(db, name, decodeURIComponent(user_id), actor);
      return reply.send(config);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // POST /admin/matrix-auth/buckets/:name/servers — add a homeserver to a bucket
  app.post('/admin/matrix-auth/buckets/:name/servers', async (request: AuthenticatedRequest, reply) => {
    const { name } = request.params as { name: string };
    const { homeserver } = request.body as { homeserver: string };
    if (!homeserver || typeof homeserver !== 'string') {
      return reply.code(400).send({ error: 'Field "homeserver" is required' });
    }
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const config = await addBucketServerMember(db, name, homeserver, actor);
      return reply.send(config);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // DELETE /admin/matrix-auth/buckets/:name/servers/:homeserver — remove a homeserver from a bucket
  app.delete('/admin/matrix-auth/buckets/:name/servers/:homeserver', async (request: AuthenticatedRequest, reply) => {
    const { name, homeserver } = request.params as { name: string; homeserver: string };
    const actor = request.matrixUser?.user_id || 'unknown';
    try {
      const config = await removeBucketServerMember(db, name, decodeURIComponent(homeserver), actor);
      return reply.send(config);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });
}
