/**
 * Ingestion API routes.
 *
 * Endpoints for managing Airtable API keys and triggering syncs.
 * All routes are auth-protected (Matrix Bearer token).
 *
 * API key management:
 *   POST   /ingestion/keys          — Store a new API key
 *   GET    /ingestion/keys          — List all stored keys (redacted)
 *   GET    /ingestion/keys/:label   — Get a specific key (redacted)
 *   DELETE /ingestion/keys/:label   — Delete a stored key
 *
 * Schema discovery:
 *   GET    /ingestion/airtable/discover/:label — Discover bases/tables for a key
 *
 * Sync:
 *   POST   /ingestion/airtable/hydrate/:label  — Full hydration sync
 *   POST   /ingestion/airtable/sync/:label     — Incremental update sync
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import {
  storeApiKey,
  getApiKey,
  getApiKeyRedacted,
  listApiKeys,
  deleteApiKey,
  touchApiKey,
} from '../ingestion/api-keys.js';
import { AirtableClient } from '../ingestion/airtable-client.js';
import {
  discoverSchema,
  hydrationSync,
  updateSync,
} from '../ingestion/airtable-sync.js';

export function registerIngestionRoutes(app: FastifyInstance, db: EoDb, feed: Feed): void {

  // ── API Key Management ──────────────────────────────────────────────────

  /** Store a new Airtable API key. */
  app.post('/ingestion/keys', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as {
      label?: string;
      api_key?: string;
      base_ids?: string[];
    };

    if (!body.label || !body.api_key) {
      return reply.code(400).send({ error: 'Missing required fields: label, api_key' });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(body.label)) {
      return reply.code(400).send({
        error: 'Label must be alphanumeric with hyphens/underscores only',
      });
    }

    const stored = await storeApiKey(db, body.label, body.api_key, agent, body.base_ids);
    return reply.send({ stored });
  });

  /** List all stored API keys (redacted). */
  app.get('/ingestion/keys', async (_request: AuthenticatedRequest, reply) => {
    const keys = await listApiKeys(db);
    return reply.send({ keys });
  });

  /** Get a specific key by label (redacted). */
  app.get('/ingestion/keys/:label', async (request: AuthenticatedRequest, reply) => {
    const { label } = request.params as { label: string };
    const key = await getApiKeyRedacted(db, label);
    if (!key) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }
    return reply.send({ key });
  });

  /** Delete a stored API key. */
  app.delete('/ingestion/keys/:label', async (request: AuthenticatedRequest, reply) => {
    const { label } = request.params as { label: string };
    const deleted = await deleteApiKey(db, label);
    if (!deleted) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }
    return reply.send({ deleted: true });
  });

  // ── Schema Discovery ────────────────────────────────────────────────────

  /** Discover all bases and tables accessible by a stored API key. */
  app.get('/ingestion/airtable/discover/:label', async (request: AuthenticatedRequest, reply) => {
    const { label } = request.params as { label: string };
    const keyEntry = await getApiKey(db, label);
    if (!keyEntry) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }

    try {
      const client = new AirtableClient(keyEntry.api_key);
      const manifest = await discoverSchema(client);
      await touchApiKey(db, label);
      return reply.send({ manifest });
    } catch (e: any) {
      return reply.code(502).send({ error: `Airtable API error: ${e.message}` });
    }
  });

  // ── Hydration Sync ──────────────────────────────────────────────────────

  /**
   * Full hydration sync: pull all data from Airtable into EO-DB.
   * Returns the manifest plus per-table sync results.
   */
  app.post('/ingestion/airtable/hydrate/:label', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const { label } = request.params as { label: string };
    const body = (request.body || {}) as {
      base_ids?: string[];
      table_ids?: string[];
    };

    const keyEntry = await getApiKey(db, label);
    if (!keyEntry) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }

    // If the key has restricted base_ids, enforce them
    const baseIds = keyEntry.base_ids?.length
      ? (body.base_ids?.filter(b => keyEntry.base_ids!.includes(b)) || keyEntry.base_ids)
      : body.base_ids;

    try {
      const client = new AirtableClient(keyEntry.api_key);
      const result = await hydrationSync(db, feed, client, agent, {
        baseIds,
        tableIds: body.table_ids,
      });
      await touchApiKey(db, label);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(502).send({ error: `Airtable sync error: ${e.message}` });
    }
  });

  // ── Update Sync ─────────────────────────────────────────────────────────

  /**
   * Incremental update sync: pull only changes since last sync.
   * Designed to be called from client devices — deduplicates across
   * concurrent syncs and filters non-transformations.
   */
  app.post('/ingestion/airtable/sync/:label', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const { label } = request.params as { label: string };
    const body = (request.body || {}) as {
      base_ids?: string[];
      table_ids?: string[];
    };

    const keyEntry = await getApiKey(db, label);
    if (!keyEntry) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }

    const baseIds = keyEntry.base_ids?.length
      ? (body.base_ids?.filter(b => keyEntry.base_ids!.includes(b)) || keyEntry.base_ids)
      : body.base_ids;

    try {
      const client = new AirtableClient(keyEntry.api_key);
      const result = await updateSync(db, feed, client, agent, {
        baseIds,
        tableIds: body.table_ids,
      });
      await touchApiKey(db, label);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(502).send({ error: `Airtable sync error: ${e.message}` });
    }
  });
}
