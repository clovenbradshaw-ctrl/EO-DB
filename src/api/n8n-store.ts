/**
 * n8n blob storage API routes.
 *
 * Talks to the deployed "EO Blob Store" workflow on n8n. That workflow
 * stores encrypted blobs on the n8n host's filesystem (/mnt/eo-blobs)
 * with a 5-version rolling history per data_id, and authorizes every
 * call by checking Matrix room membership.
 *
 * Devices signal each other via Matrix room state (manifest entries),
 * not by polling the workflow for changes.
 *
 * Routes:
 *   POST /n8n/store     — encrypt & store a blob via n8n
 *   POST /n8n/retrieve  — fetch & decrypt a blob via n8n
 *   POST /n8n/versions  — list server-retained versions of a single data_id
 *   GET  /n8n/status    — check if n8n integration is configured
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { ManifestDataType, ManifestEntry } from '../n8n/types.js';
import { getN8nConfig } from '../n8n/config.js';
import {
  storeViaN8n,
  retrieveViaN8n,
  versionsViaN8n,
} from '../n8n/webhook-client.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Extract the raw Matrix access token from the Authorization header. */
function extractMatrixToken(request: AuthenticatedRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') return parts[1];
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────

export function registerN8nRoutes(
  app: FastifyInstance,
  _db: EoDb,
  _feed: Feed,
): void {
  /**
   * GET /n8n/status — is n8n configured?
   */
  app.get('/n8n/status', async (_request: AuthenticatedRequest, reply) => {
    const config = getN8nConfig();
    return reply.send({
      configured: !!config,
      webhookUrl: config
        ? `${config.baseUrl}${config.webhookPath}`
        : null,
    });
  });

  /**
   * POST /n8n/store — encrypt and store data via the n8n workflow.
   *
   * Body: {
   *   data: any,              — the payload to encrypt and store
   *   data_type: string,      — "snapshot" | "event-batch" | "import-archive" | "attachment" | "backup"
   *   target: string,         — EO target path for key resolution
   *   room_id: string,        — Matrix room id (must start with "!")
   *   label?: string,         — optional human-readable label
   *   seq_range?: { from: number, to: number }
   * }
   */
  app.post('/n8n/store', async (request: AuthenticatedRequest, reply) => {
    const config = getN8nConfig();
    if (!config) {
      return reply.code(503).send({ error: 'n8n webhook not configured' });
    }

    const matrixToken = extractMatrixToken(request);
    if (!matrixToken) {
      return reply.code(401).send({ error: 'Missing Matrix token' });
    }

    const body = request.body as {
      data: unknown;
      data_type: ManifestDataType;
      target: string;
      room_id: string;
      label?: string;
      seq_range?: { from: number; to: number };
      keyring: any;
    };

    if (!body.data || !body.data_type || !body.target || !body.room_id || !body.keyring) {
      return reply.code(400).send({
        error: 'Missing required fields: data, data_type, target, room_id, keyring',
      });
    }

    const agent = request.matrixUser?.user_id || 'unknown';

    try {
      const result = await storeViaN8n(body.data, body.keyring, {
        roomId: body.room_id,
        target: body.target,
        dataType: body.data_type,
        label: body.label,
        agent,
        seqRange: body.seq_range,
        matrixToken,
      });

      return reply.send({
        ok: true,
        manifest: result.manifest,
        response: result.response,
      });
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

  /**
   * POST /n8n/retrieve — fetch and decrypt a blob via n8n.
   *
   * Body: {
   *   manifest: ManifestEntry, — the manifest entry identifying the blob
   *   keyring: any
   * }
   */
  app.post('/n8n/retrieve', async (request: AuthenticatedRequest, reply) => {
    const config = getN8nConfig();
    if (!config) {
      return reply.code(503).send({ error: 'n8n webhook not configured' });
    }

    const matrixToken = extractMatrixToken(request);
    if (!matrixToken) {
      return reply.code(401).send({ error: 'Missing Matrix token' });
    }

    const body = request.body as {
      manifest: ManifestEntry;
      keyring: any;
    };

    if (!body.manifest || !body.keyring) {
      return reply.code(400).send({
        error: 'Missing required fields: manifest, keyring',
      });
    }

    try {
      const data = await retrieveViaN8n(body.manifest, body.keyring, matrixToken);
      return reply.send({ ok: true, data });
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

  /**
   * POST /n8n/versions — list server-retained versions of one data_id.
   *
   * Body: {
   *   room_id: string,
   *   data_id: string
   * }
   */
  app.post('/n8n/versions', async (request: AuthenticatedRequest, reply) => {
    const config = getN8nConfig();
    if (!config) {
      return reply.code(503).send({ error: 'n8n webhook not configured' });
    }

    const matrixToken = extractMatrixToken(request);
    if (!matrixToken) {
      return reply.code(401).send({ error: 'Missing Matrix token' });
    }

    const body = request.body as {
      room_id: string;
      data_id: string;
    };

    if (!body.room_id || !body.data_id) {
      return reply.code(400).send({
        error: 'Missing required fields: room_id, data_id',
      });
    }

    try {
      const result = await versionsViaN8n(body.room_id, body.data_id, matrixToken);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(502).send({ error: e.message });
    }
  });

}
