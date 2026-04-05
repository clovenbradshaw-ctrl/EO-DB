/**
 * Event bridge — converts between EO events and Matrix room events.
 *
 * Custom event type derived from configurable prefix (default: "com.eo-db").
 * Agent is ALWAYS derived from the Matrix sender, never from event content.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoEventInput } from '../db/types';
import { eoEventTypes, getDataRoomAlias } from '../lib/matrix-domain';

const _types = eoEventTypes();
export const EO_EVENT_TYPE = _types.event;
export const EO_SNAPSHOT_TYPE = _types.snapshot;
export const EO_SNAPSHOT_STATE_TYPE = _types.snapshotState;
export const EO_SNAPSHOT_CLAIM_TYPE = _types.snapshotClaim;

// --- Governance event types ---
export const EO_SCHEMA_TYPE = 'com.eo-db.schema';
export const EO_GOVERNANCE_TYPE = 'com.eo-db.governance';
export const EO_KEY_ANNOUNCE_TYPE = 'com.eo-db.key.announce';
export const EO_SCHEMA_MANIFEST_TYPE = 'com.eo-db.schema.manifest';
export const EO_SPACE_CONFIG_TYPE = 'com.eo-db.space.config';

/** Room alias — configured at runtime via `configureMatrixDomain()`. */
export function getDataRoom(): string {
  return getDataRoomAlias();
}

/** @deprecated Use getDataRoom() instead. Kept for backward compatibility. */
export const DATA_ROOM_ALIAS = '' as string;

/**
 * Send an EO event to the encrypted Matrix room.
 * The SDK handles Megolm encryption transparently.
 */
export async function sendEoEvent(
  client: MatrixClient,
  roomId: string,
  event: EoEventInput,
): Promise<string> {
  const result = await client.sendEvent(roomId, EO_EVENT_TYPE as any, {
    op: event.op,
    target: event.target,
    operand: event.operand,
    client_event_id: event.client_event_id,
    ts: event.ts,
    meta: event.meta,
    // agent is NOT included — derived from Matrix sender
  });

  return result.event_id;
}

/**
 * Convert a Matrix room event back to an EO event input.
 * The agent comes from the Matrix event sender field.
 */
export function matrixEventToEo(matrixEvent: MatrixEvent): EoEventInput {
  const content = matrixEvent.getContent();
  return {
    op: content.op,
    target: content.target,
    operand: content.operand,
    agent: matrixEvent.getSender()!,
    ts: content.ts || new Date(matrixEvent.getTs()).toISOString(),
    acquired_ts: new Date(matrixEvent.getTs()).toISOString(),
    client_event_id: content.client_event_id,
    meta: content.meta,
  };
}

/**
 * Resolve the data room alias to a room ID.
 */
export async function resolveDataRoom(client: MatrixClient): Promise<string> {
  const alias = getDataRoom();
  if (!alias) {
    throw new Error('Data room alias not configured — call configureMatrixDomain() first');
  }
  const result = await client.getRoomIdForAlias(alias);
  return result.room_id;
}
