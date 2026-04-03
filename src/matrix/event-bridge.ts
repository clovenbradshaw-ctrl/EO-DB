/**
 * Event bridge — converts between EO events and Matrix room events.
 *
 * Custom event type derived from configurable prefix (default: "com.eo-db").
 * Agent is ALWAYS derived from the Matrix sender, never from event content.
 * This prevents spoofing — Matrix guarantees sender authenticity.
 *
 * Megolm encryption is handled transparently by the SDK (client.sendEvent()
 * encrypts in E2EE rooms). The homeserver never sees plaintext event content.
 */

import type { EoEventInput } from '../db/types.js';
import type { IMatrixClient, IMatrixEvent } from './types.js';
import { eoEventTypes, getDataRoomAlias } from '../config/matrix-domain.js';

const _types = eoEventTypes();

export const EO_EVENT_TYPE = _types.event;
export const EO_SNAPSHOT_TYPE = _types.snapshot;
export const EO_SNAPSHOT_STATE_TYPE = _types.snapshotState;
export const EO_IMPORT_TYPE = _types.import;

export const EO_SPACE_CONFIG_TYPE = 'com.eo-db.space.config';
export const EO_SCHEMA_MANIFEST_TYPE = 'com.eo-db.schema.manifest';
export const EO_KEY_ANNOUNCE_TYPE = 'com.eo-db.key.announce';

/** Room alias — configured at runtime via `configureMatrixDomain()`. */
export function getDataRoom(): string {
  return getDataRoomAlias();
}

/**
 * Send an EO event to the encrypted Matrix room.
 * The SDK handles Megolm encryption transparently.
 *
 * Invariant: the `agent` field is never included in the Matrix event content.
 * On receipt, agent is always derived from matrixEvent.getSender().
 */
export async function sendEoEvent(
  client: IMatrixClient,
  roomId: string,
  event: EoEventInput,
): Promise<string> {
  const result = await client.sendEvent(roomId, EO_EVENT_TYPE, {
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
 * The agent comes from the Matrix event sender field — never from content.
 */
export function matrixEventToEo(matrixEvent: IMatrixEvent): EoEventInput {
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
export async function resolveDataRoom(client: IMatrixClient): Promise<string> {
  const alias = getDataRoom();
  if (!alias) {
    throw new Error('Data room alias not configured — call configureMatrixDomain() first');
  }
  const result = await client.getRoomIdForAlias(alias);
  return result.room_id;
}
