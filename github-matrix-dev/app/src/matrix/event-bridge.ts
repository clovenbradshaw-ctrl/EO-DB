/**
 * Event bridge — converts between EO events and Matrix room events.
 *
 * Custom event type: com.aminoimmigration.eo.event
 * Agent is ALWAYS derived from the Matrix sender, never from event content.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoEventInput } from '../db/types';

export const EO_EVENT_TYPE = 'com.aminoimmigration.eo.event';
export const EO_SNAPSHOT_TYPE = 'com.aminoimmigration.eo.snapshot';
export const DATA_ROOM_ALIAS = '#amino-data:app.aminoimmigration.com';

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
  const result = await client.getRoomIdForAlias(DATA_ROOM_ALIAS);
  return result.room_id;
}
