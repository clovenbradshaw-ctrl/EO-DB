import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/**
 * Auth proxy routes — unauthenticated endpoints that proxy Matrix login,
 * whoami, and profile lookups so the admin UI doesn't need to know the
 * homeserver URL or deal with CORS.
 */
export function registerAuthRoutes(app: FastifyInstance, homeserver: string): void {

  // POST /auth/login — proxy to Matrix login endpoint
  app.post('/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const { user, password, homeserver: clientHomeserver } = request.body as {
      user?: string; password?: string; homeserver?: string;
    };

    if (!user || !password) {
      return reply.code(400).send({ error: 'Fields "user" and "password" are required' });
    }

    // Use client-provided homeserver if given, otherwise fall back to default
    const targetHomeserver = (clientHomeserver || homeserver).replace(/\/+$/, '');

    const loginBody = {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
    };

    try {
      const res = await fetch(`${targetHomeserver}/_matrix/client/v3/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loginBody),
      });

      const data = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        const errMsg = (data.error as string) || `Matrix login failed (${res.status})`;
        return reply.code(res.status).send({ error: errMsg });
      }

      return reply.send({
        access_token: data.access_token,
        user_id: data.user_id,
        device_id: data.device_id,
        homeserver: targetHomeserver,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: `Cannot reach homeserver: ${e.message}` });
    }
  });

  // GET /auth/whoami — verify a bearer token and return user_id
  app.get('/auth/whoami', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);

    try {
      const res = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!res.ok) {
        return reply.code(res.status).send({ error: 'Invalid or expired token' });
      }

      const data = await res.json() as { user_id: string; device_id?: string };
      return reply.send({ user_id: data.user_id, device_id: data.device_id });
    } catch (e: any) {
      return reply.code(502).send({ error: `Cannot reach homeserver: ${e.message}` });
    }
  });

  // GET /auth/profile — whoami + displayname lookup in one call
  app.get('/auth/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.slice(7);

    try {
      // Step 1: whoami
      const whoamiRes = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!whoamiRes.ok) {
        return reply.code(whoamiRes.status).send({ error: 'Invalid or expired token' });
      }

      const whoami = await whoamiRes.json() as { user_id: string; device_id?: string };

      // Step 2: profile displayname
      let displayname: string | null = null;
      try {
        const profileRes = await fetch(
          `${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(whoami.user_id)}/displayname`,
        );
        if (profileRes.ok) {
          const profile = await profileRes.json() as { displayname?: string };
          displayname = profile.displayname || null;
        }
      } catch {
        // Profile lookup is best-effort; fall through with null displayname
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
}
