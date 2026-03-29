/**
 * Room sync API routes.
 *
 * Admin endpoints for managing room-level Airtable sync bindings
 * and viewing coordinator status.
 *
 * Binding management:
 *   POST   /room-sync/bindings                     — Create a new binding
 *   GET    /room-sync/bindings                     — List all bindings
 *   GET    /room-sync/bindings/:bindingId          — Get a specific binding
 *   PUT    /room-sync/bindings/:bindingId          — Update a binding
 *   DELETE /room-sync/bindings/:bindingId          — Delete a binding
 *   GET    /room-sync/bindings/room/:roomId        — List bindings for a room
 *
 * Status:
 *   GET    /room-sync/status                       — Status of all active syncs
 *   GET    /room-sync/status/:bindingId            — Status of a specific sync
 *   GET    /room-sync/status/room/:roomId          — Status of all syncs for a room
 */

import type { FastifyInstance } from 'fastify';
import type { EoDb } from '../db/level.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { RoomSyncCoordinator } from '../ingestion/room-sync-coordinator.js';
import {
  createBinding,
  getBinding,
  updateBinding,
  deleteBinding,
  getAllBindings,
  getBindingsForRoom,
  type CreateBindingInput,
} from '../ingestion/room-sync-config.js';
import { getApiKeyRedacted } from '../ingestion/api-keys.js';

export function registerRoomSyncRoutes(
  app: FastifyInstance,
  db: EoDb,
  coordinator: RoomSyncCoordinator,
): void {

  // ── Create binding ────────────────────────────────────────────────────

  app.post('/room-sync/bindings', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'unknown';
    const body = request.body as CreateBindingInput;

    if (!body.room_id || !body.api_key_label) {
      return reply.code(400).send({
        error: 'Missing required fields: room_id, api_key_label',
      });
    }

    // Verify the API key exists
    const keyCheck = await getApiKeyRedacted(db, body.api_key_label);
    if (!keyCheck) {
      return reply.code(404).send({
        error: `API key "${body.api_key_label}" not found. Store it first via POST /ingestion/keys`,
      });
    }

    const binding = await createBinding(db, body, agent);

    // Notify coordinator so it picks up the new binding immediately
    await coordinator.onBindingChanged(binding.binding_id);

    return reply.code(201).send({ binding });
  });

  // ── List all bindings ─────────────────────────────────────────────────

  app.get('/room-sync/bindings', async (_request: AuthenticatedRequest, reply) => {
    const bindings = await getAllBindings(db);
    return reply.send({ bindings });
  });

  // ── Get binding by ID ─────────────────────────────────────────────────

  app.get('/room-sync/bindings/:bindingId', async (request: AuthenticatedRequest, reply) => {
    const { bindingId } = request.params as { bindingId: string };
    const binding = await getBinding(db, bindingId);
    if (!binding) {
      return reply.code(404).send({ error: 'Binding not found' });
    }
    return reply.send({ binding });
  });

  // ── Update binding ────────────────────────────────────────────────────

  app.put('/room-sync/bindings/:bindingId', async (request: AuthenticatedRequest, reply) => {
    const { bindingId } = request.params as { bindingId: string };
    const body = request.body as Partial<CreateBindingInput>;

    const updated = await updateBinding(db, bindingId, body);
    if (!updated) {
      return reply.code(404).send({ error: 'Binding not found' });
    }

    // Notify coordinator of the change
    await coordinator.onBindingChanged(bindingId);

    return reply.send({ binding: updated });
  });

  // ── Delete binding ────────────────────────────────────────────────────

  app.delete('/room-sync/bindings/:bindingId', async (request: AuthenticatedRequest, reply) => {
    const { bindingId } = request.params as { bindingId: string };

    const deleted = await deleteBinding(db, bindingId);
    if (!deleted) {
      return reply.code(404).send({ error: 'Binding not found' });
    }

    // Notify coordinator to tear down the runtime
    await coordinator.onBindingChanged(bindingId);

    return reply.send({ deleted: true });
  });

  // ── List bindings for a room ──────────────────────────────────────────

  app.get('/room-sync/bindings/room/:roomId', async (request: AuthenticatedRequest, reply) => {
    const { roomId } = request.params as { roomId: string };
    const bindings = await getBindingsForRoom(db, roomId);
    return reply.send({ bindings });
  });

  // ── Status: all ───────────────────────────────────────────────────────

  app.get('/room-sync/status', async (_request: AuthenticatedRequest, reply) => {
    return reply.send({ status: coordinator.getAllStatus() });
  });

  // ── Status: by binding ID ────────────────────────────────────────────

  app.get('/room-sync/status/:bindingId', async (request: AuthenticatedRequest, reply) => {
    const { bindingId } = request.params as { bindingId: string };
    const status = coordinator.getStatus(bindingId);
    if (!status) {
      return reply.code(404).send({ error: 'No active runtime for this binding' });
    }
    return reply.send({ status });
  });

  // ── Status: by room ──────────────────────────────────────────────────

  app.get('/room-sync/status/room/:roomId', async (request: AuthenticatedRequest, reply) => {
    const { roomId } = request.params as { roomId: string };
    return reply.send({ status: coordinator.getRoomStatus(roomId) });
  });
}
