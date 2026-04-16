/**
 * Parses origin identity off of an `EoEvent`.
 *
 * The repo's `EoEvent.agent` field is a single string, typically a Matrix user
 * ID ("@user:server"). The sync layer needs a separate device identity for the
 * SEG authority rule and peer-site addressing.
 *
 * The canonical way for sync-layer events to carry the device id is via
 * `event.meta.origin_device_id` (set by the emitting device). As a fallback,
 * this module also recognizes the compound form "@user:server|device" in the
 * `agent` field — useful for tests and any legacy events that adopt that form.
 *
 * Centralized here so the SEG authority rule can be tested in isolation.
 */

import type { EoEvent } from '../db/types';

export interface OriginIdentity {
  userId: string | null;
  deviceId: string | null;
}

const AGENT_DEVICE_SEPARATOR = '|';

/**
 * Parse a bare agent string. Recognizes the compound form "<userId>|<deviceId>"
 * and the plain form "<userId>".
 */
export function parseAgentString(agent: string | undefined | null): OriginIdentity {
  if (!agent) return { userId: null, deviceId: null };
  const pipe = agent.indexOf(AGENT_DEVICE_SEPARATOR);
  if (pipe > 0 && pipe < agent.length - 1) {
    return {
      userId: agent.slice(0, pipe),
      deviceId: agent.slice(pipe + 1),
    };
  }
  return { userId: agent, deviceId: null };
}

/**
 * Extract origin identity from an event. Prefers explicit `meta.origin_device_id`
 * / `meta.origin_user_id`; falls back to parsing `agent`.
 */
export function getOriginIdentity(event: EoEvent): OriginIdentity {
  const fromAgent = parseAgentString(event.agent);
  const meta = event.meta as { origin_device_id?: unknown; origin_user_id?: unknown } | undefined;
  const metaDevice = typeof meta?.origin_device_id === 'string' ? meta.origin_device_id : null;
  const metaUser = typeof meta?.origin_user_id === 'string' ? meta.origin_user_id : null;
  return {
    userId: metaUser ?? fromAgent.userId,
    deviceId: metaDevice ?? fromAgent.deviceId,
  };
}

export function getOriginDeviceId(event: EoEvent): string | null {
  return getOriginIdentity(event).deviceId;
}

export function getOriginUserId(event: EoEvent): string | null {
  return getOriginIdentity(event).userId;
}

/**
 * Construct the `agent` string that, when later parsed, yields the given
 * identity pair. Used by callers that want to embed the device id inline
 * rather than in `meta`.
 */
export function formatAgent(userId: string, deviceId: string): string {
  if (userId.includes(AGENT_DEVICE_SEPARATOR)) {
    throw new Error(`userId must not contain '${AGENT_DEVICE_SEPARATOR}'`);
  }
  if (deviceId.includes(AGENT_DEVICE_SEPARATOR)) {
    throw new Error(`deviceId must not contain '${AGENT_DEVICE_SEPARATOR}'`);
  }
  return userId + AGENT_DEVICE_SEPARATOR + deviceId;
}
