import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import {
  registerCrystallizationRule,
  getCrystallizationRule,
  removeCrystallizationRule,
} from '../db/crystallize.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';

export function registerCrystallizeRoutes(app: FastifyInstance, db: EoDb): void {
  // PUT /crystallize/:scope — register a crystallization rule
  app.put('/crystallize/:scope', async (request: AuthenticatedRequest, reply) => {
    const { scope } = request.params as { scope: string };
    const body = request.body as {
      window?: number;
      min_members?: number;
      traits?: string[];
    };

    if (!body.traits || body.traits.length === 0) {
      return reply.code(400).send({ error: 'traits array is required' });
    }

    if (!body.window || body.window < 1) {
      return reply.code(400).send({ error: 'window must be >= 1' });
    }

    await registerCrystallizationRule(db, {
      scope,
      predicate: 'cohort_forms',
      window: body.window,
      min_members: body.min_members ?? 2,
      traits: body.traits,
    });

    return reply.send({ ok: true, scope, window: body.window });
  });

  // GET /crystallize/:scope — get a crystallization rule
  app.get('/crystallize/:scope', async (request: AuthenticatedRequest, reply) => {
    const { scope } = request.params as { scope: string };
    const rule = await getCrystallizationRule(db, scope);
    if (!rule) {
      return reply.code(404).send({ error: 'No crystallization rule for scope' });
    }
    return reply.send(rule);
  });

  // DELETE /crystallize/:scope — remove a crystallization rule
  app.delete('/crystallize/:scope', async (request: AuthenticatedRequest, reply) => {
    const { scope } = request.params as { scope: string };
    await removeCrystallizationRule(db, scope);
    return reply.send({ ok: true, scope });
  });
}
