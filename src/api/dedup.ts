// ─── Dedup API Routes ────────────────────────────────────────────────────────
// CRUD for tool configs, job execution, and candidate review.

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { DedupToolConfig } from '../dedup/types.js';
import {
  storeTool, getTool, listTools, deleteTool,
  runDedupJob, getJob, getCandidates, reviewCandidate,
} from '../dedup/engine.js';
import { ALL_PRESETS, getPreset } from '../dedup/presets.js';

export function registerDedupRoutes(app: FastifyInstance, db: EoDb, feed: Feed): void {

  // ─── Tool Config CRUD ────────────────────────────────────────────────

  app.post('/dedup/tools', async (request: AuthenticatedRequest, reply) => {
    const body = request.body as Partial<DedupToolConfig>;

    if (!body.id || !body.name || !body.tier || !body.scope?.collection || !body.comparisons?.length) {
      return reply.code(400).send({ error: 'Missing required fields: id, name, tier, scope.collection, comparisons' });
    }

    const agent = request.matrixUser?.user_id || 'unknown';
    const config: DedupToolConfig = {
      ...body as DedupToolConfig,
      created_by: agent,
      created_at: new Date().toISOString(),
    };

    await storeTool(db, config);
    return reply.code(201).send(config);
  });

  app.get('/dedup/tools', async (_request, reply) => {
    const tools = await listTools(db);
    return reply.send({ tools });
  });

  app.get('/dedup/tools/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const tool = await getTool(db, id);
    if (!tool) return reply.code(404).send({ error: 'Tool not found' });
    return reply.send(tool);
  });

  app.delete('/dedup/tools/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteTool(db, id);
    return reply.code(204).send();
  });

  // ─── Presets ─────────────────────────────────────────────────────────

  app.get('/dedup/presets', async (_request, reply) => {
    return reply.send({ presets: ALL_PRESETS });
  });

  app.get('/dedup/presets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const preset = getPreset(id);
    if (!preset) return reply.code(404).send({ error: 'Preset not found' });
    return reply.send(preset);
  });

  // ─── Job Execution ───────────────────────────────────────────────────

  app.post('/dedup/run/:toolId', async (request: AuthenticatedRequest, reply) => {
    const { toolId } = request.params as { toolId: string };

    // Check saved tools first, then presets
    let config = await getTool(db, toolId);
    if (!config) config = getPreset(toolId) ?? null;
    if (!config) return reply.code(404).send({ error: 'Tool config not found' });

    // Allow overriding scope collection in the request body
    const body = request.body as { collection?: string } | undefined;
    if (body?.collection) {
      config = { ...config, scope: { ...config.scope, collection: body.collection } };
    }

    const job = await runDedupJob(db, config, feed);
    return reply.send(job);
  });

  app.get('/dedup/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await getJob(db, jobId);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return reply.send(job);
  });

  // ─── Candidate Review ────────────────────────────────────────────────

  app.get('/dedup/candidates/:toolId', async (request, reply) => {
    const { toolId } = request.params as { toolId: string };
    const query = request.query as { status?: string };
    const status = query.status as any;
    const candidates = await getCandidates(db, toolId, status);
    return reply.send({ candidates });
  });

  app.post('/dedup/candidates/:candidateId/review', async (request: AuthenticatedRequest, reply) => {
    const { candidateId } = request.params as { candidateId: string };
    const body = request.body as { decision?: 'approved' | 'rejected' };

    if (!body.decision || !['approved', 'rejected'].includes(body.decision)) {
      return reply.code(400).send({ error: 'decision must be "approved" or "rejected"' });
    }

    const agent = request.matrixUser?.user_id || 'unknown';

    try {
      const candidate = await reviewCandidate(db, candidateId, body.decision, agent, feed);
      return reply.send(candidate);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
  });
}
