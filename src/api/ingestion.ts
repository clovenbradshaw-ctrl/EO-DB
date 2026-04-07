/**
 * Ingestion API routes.
 *
 * Endpoints for managing Airtable API keys and triggering syncs.
 * All routes are auth-protected (Matrix Bearer token).
 *
 * Upload-before-process: for Airtable syncs, raw records are captured during
 * fetch and archived to Filen (via n8n webhook) as an immutable binary (.eodb)
 * after the sync completes. Resumability for Airtable is already handled by
 * the existing cursor + HydrationJob system.
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
import type { SyncManager } from '../matrix/sync-manager.js';
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
  type SyncCustomization,
} from '../ingestion/airtable-sync.js';
import { createEventSink } from '../ingestion/event-sink.js';
import {
  createImportJob,
  saveImportJob,
  computeContentHash,
  packImportArchive,
  uploadImportArchive,
  type ImportArchive,
} from '../filen/import-upload.js';

export function registerIngestionRoutes(app: FastifyInstance, db: EoDb, feed: Feed, syncManager?: SyncManager): void {

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
   * Archives raw Airtable data to Filen (via n8n) for auditing.
   */
  app.post('/ingestion/airtable/hydrate/:label', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const { label } = request.params as { label: string };
    const body = (request.body || {}) as {
      base_ids?: string[];
      table_ids?: string[];
      customization?: SyncCustomization;
    };

    const keyEntry = await getApiKey(db, label);
    if (!keyEntry) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }

    const baseIds = keyEntry.base_ids?.length
      ? (body.base_ids?.filter(b => keyEntry.base_ids!.includes(b)) || keyEntry.base_ids)
      : body.base_ids;

    try {
      // Discover schema first — this is part of the raw data we archive
      const client = new AirtableClient(keyEntry.api_key);
      const manifest = await discoverSchema(client);

      // Archive the raw request + schema to Filen before processing
      let importJobId: string | undefined;
      let filenUploadOk = false;

      try {
        const rawData = {
          type: 'airtable-hydration',
          label,
          base_ids: baseIds,
          table_ids: body.table_ids,
          customization: body.customization,
          manifest,
        };
        const rawString = JSON.stringify(rawData);
        const contentHash = await computeContentHash(rawString);
        const job = createImportJob('airtable', agent, contentHash);
        await saveImportJob(db, job);

        const archive: ImportArchive = {
          version: 1,
          type: 'import-archive',
          source: 'airtable',
          agent,
          created_at: new Date().toISOString(),
          content_hash: contentHash,
          raw_data: rawData,
        };
        const binary = packImportArchive(archive);
        const { remotePath } = await uploadImportArchive(job.job_id, 'airtable', binary);

        job.filen_remote_path = remotePath;
        job.status = 'uploaded';
        await saveImportJob(db, job);

        importJobId = job.job_id;
        filenUploadOk = true;
        console.log(`[EO-DB] Airtable hydration archive uploaded to Filen: ${job.job_id} (${binary.byteLength} bytes)`);
      } catch (e: any) {
        console.warn(`[EO-DB] Filen archive upload failed for Airtable hydration: ${e.message}`);
      }

      // Process — uses existing hydrationSync with its own HydrationJob + cursor resume
      const sink = createEventSink(db, feed, syncManager, { source: 'airtable', label });
      const result = await hydrationSync(db, feed, client, agent, {
        baseIds,
        tableIds: body.table_ids,
        customization: body.customization,
        sink,
      });
      const grounded = await sink.flush();
      await touchApiKey(db, label);

      return reply.send({
        ...result,
        grounded,
        import_job_id: importJobId,
        filen_upload: filenUploadOk,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: `Airtable sync error: ${e.message}` });
    }
  });

  // ── Update Sync ─────────────────────────────────────────────────────────

  /**
   * Incremental update sync: pull only changes since last sync.
   * Archives raw request metadata to Filen (via n8n) for auditing.
   */
  app.post('/ingestion/airtable/sync/:label', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const { label } = request.params as { label: string };
    const body = (request.body || {}) as {
      base_ids?: string[];
      table_ids?: string[];
      customization?: SyncCustomization;
    };

    const keyEntry = await getApiKey(db, label);
    if (!keyEntry) {
      return reply.code(404).send({ error: `API key "${label}" not found` });
    }

    const baseIds = keyEntry.base_ids?.length
      ? (body.base_ids?.filter(b => keyEntry.base_ids!.includes(b)) || keyEntry.base_ids)
      : body.base_ids;

    try {
      let importJobId: string | undefined;
      let filenUploadOk = false;

      try {
        const rawData = {
          type: 'airtable-sync',
          label,
          base_ids: baseIds,
          table_ids: body.table_ids,
          customization: body.customization,
        };
        const rawString = JSON.stringify(rawData);
        const contentHash = await computeContentHash(rawString);
        const job = createImportJob('airtable', agent, contentHash);
        await saveImportJob(db, job);

        const archive: ImportArchive = {
          version: 1,
          type: 'import-archive',
          source: 'airtable',
          agent,
          created_at: new Date().toISOString(),
          content_hash: contentHash,
          raw_data: rawData,
        };
        const binary = packImportArchive(archive);
        const { remotePath } = await uploadImportArchive(job.job_id, 'airtable', binary);

        job.filen_remote_path = remotePath;
        job.status = 'uploaded';
        await saveImportJob(db, job);

        importJobId = job.job_id;
        filenUploadOk = true;
        console.log(`[EO-DB] Airtable sync archive uploaded to Filen: ${job.job_id} (${binary.byteLength} bytes)`);
      } catch (e: any) {
        console.warn(`[EO-DB] Filen archive upload failed for Airtable sync: ${e.message}`);
      }

      const client = new AirtableClient(keyEntry.api_key);
      const sink = createEventSink(db, feed, syncManager, { source: 'airtable', label });
      const result = await updateSync(db, feed, client, agent, {
        baseIds,
        tableIds: body.table_ids,
        customization: body.customization,
        sink,
      });
      const grounded = await sink.flush();
      await touchApiKey(db, label);

      return reply.send({
        ...result,
        grounded,
        import_job_id: importJobId,
        filen_upload: filenUploadOk,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: `Airtable sync error: ${e.message}` });
    }
  });
}
