import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import { getCurrentSeq } from '../db/level.js';
import { readLogSince, readLogForTarget } from '../db/log.js';
import { horizonGet } from '../db/horizon.js';
import { getEdgesFrom, getEdgesTo, traverse } from '../db/graph.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';

// ─── Horizon result cache ─────────────────────────────────────────────────────
// Short-lived (2 s) in-memory cache for GET /horizon/:target results.
// Invalidated by target when the feed fires (done via horizonCache.delete).
// Keeps at most MAX_ENTRIES entries to avoid unbounded growth.

const CACHE_TTL_MS = 2_000;
const MAX_ENTRIES = 500;

interface CacheEntry {
  result: unknown;
  etag: string;
  ts: number;
}

const horizonCache = new Map<string, CacheEntry>();

function horizonCacheGet(key: string): CacheEntry | null {
  const entry = horizonCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    horizonCache.delete(key);
    return null;
  }
  return entry;
}

function horizonCacheSet(key: string, result: unknown): CacheEntry {
  if (horizonCache.size >= MAX_ENTRIES) {
    // Evict oldest entry
    const oldest = horizonCache.keys().next().value;
    if (oldest !== undefined) horizonCache.delete(oldest);
  }
  const etag = `"${createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 16)}"`;
  const entry: CacheEntry = { result, etag, ts: Date.now() };
  horizonCache.set(key, entry);
  return entry;
}

/** Invalidate cached horizon result for a target (call on feed.notify). */
export function invalidateHorizonCache(target: string): void {
  horizonCache.delete(target);
}

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
    // Include query flags in cache key so different option combos don't collide.
    const cacheKey = `${target}|${query.prefix}|${query.signals}|${query.grounds}|` +
      `${query.ancestry}|${query.nearby}|${query.governance}|${query.include_deleted}`;

    // Check cache first
    const cached = horizonCacheGet(cacheKey);
    if (cached) {
      const ifNoneMatch = (request.headers as Record<string, string | undefined>)['if-none-match'];
      if (ifNoneMatch === cached.etag) {
        return reply.code(304).send();
      }
      reply.header('ETag', cached.etag);
      reply.header('Cache-Control', 'private, max-age=2');
      return reply.send(cached.result);
    }

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
    const entry = horizonCacheSet(cacheKey, result);
    reply.header('ETag', entry.etag);
    reply.header('Cache-Control', 'private, max-age=2');
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
