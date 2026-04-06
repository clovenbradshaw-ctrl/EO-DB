import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import { getCurrentSeq } from '../db/level.js';
import { readLogSince, readLogForTarget } from '../db/log.js';
import { horizonGet } from '../db/horizon.js';
import { getEdgesFrom, getEdgesTo, traverse } from '../db/graph.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';

export function registerHealthRoute(app: FastifyInstance, db: EoDb): void {
  app.get('/health', async (request, reply) => {
    const seq = await getCurrentSeq(db);
    return reply.send({ status: 'ok', seq, uptime: process.uptime() });
  });
}

export function registerQueryRoutes(app: FastifyInstance, db: EoDb): void {
  // GET /horizon/:target
  app.get('/horizon/:target', async (request: AuthenticatedRequest, reply) => {
    const { target } = request.params as { target: string };
    const query = request.query as Record<string, string | undefined>;

    const result = await horizonGet(db, target, {
      prefix: query.prefix === 'true',
      signals: query.signals === 'true',
      grounds: query.grounds !== 'false',
      ancestry: query.ancestry !== 'false',
      nearby: query.nearby !== 'false',
      governance: query.governance !== 'false',
      include_deleted: query.include_deleted === 'true',
    });
    if (result === null) {
      return reply.code(404).send({ error: 'Target not found' });
    }
    return reply.send(result);
  });

  // GET /traverse/:target
  app.get('/traverse/:target', async (request: AuthenticatedRequest, reply) => {
    const { target } = request.params as { target: string };
    const { depth } = request.query as { depth?: string };
    const result = await traverse(db, target, parseInt(depth || '1', 10));
    return reply.send(result);
  });

  // GET /log
  app.get('/log', async (request: AuthenticatedRequest, reply) => {
    const { since, limit } = request.query as { since?: string; limit?: string };
    const sinceNum = parseInt(since || '0', 10);
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    const events = await readLogSince(db, sinceNum, limitNum);
    const currentSeq = await getCurrentSeq(db);
    return reply.send({ events, next_seq: currentSeq + 1 });
  });

  // GET /log/:target
  app.get('/log/:target', async (request: AuthenticatedRequest, reply) => {
    const { target } = request.params as { target: string };
    const events = await readLogForTarget(db, target);
    return reply.send({ events });
  });

  // GET /edges/:target
  app.get('/edges/:target', async (request: AuthenticatedRequest, reply) => {
    const { target } = request.params as { target: string };
    const { direction } = request.query as { direction?: string };

    if (direction === 'outgoing') {
      return reply.send({ edges: await getEdgesFrom(db, target) });
    }
    if (direction === 'incoming') {
      return reply.send({ edges: await getEdgesTo(db, target) });
    }
    // Both directions
    const outgoing = await getEdgesFrom(db, target);
    const incoming = await getEdgesTo(db, target);
    return reply.send({ edges: [...outgoing, ...incoming] });
  });

  // GET /meta (auth required — handled by middleware on parent)
  app.get('/meta', async (request: AuthenticatedRequest, reply) => {
    const seq = await getCurrentSeq(db);
    return reply.send({
      seq,
      event_count: seq,
    });
  });
}
