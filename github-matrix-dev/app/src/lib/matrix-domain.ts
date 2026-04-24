/**
 * Domain-agnostic Matrix configuration for the browser app.
 *
 * Event type prefixes and room aliases are configurable at runtime
 * so the app is not coupled to any specific homeserver domain.
 *
 * Call `configureMatrixDomain()` once at startup (e.g. after login)
 * with values from the user's session or environment.
 */

const DEFAULT_EVENT_PREFIX = 'com.eo-db';

let _eventPrefix = DEFAULT_EVENT_PREFIX;
let _dataRoomAlias = '';

export function getEventPrefix(): string {
  return _eventPrefix;
}

export function getDataRoomAlias(): string {
  return _dataRoomAlias;
}

/** EO data event types. */
export function eoEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    event: `${p}.event`,
    snapshot: `${p}.snapshot`,
    /** Room state event: stores the latest snapshot URI for fast hydration. */
    snapshotState: `${p}.snapshot_state`,
    /** Room state event: hand-raising lease so one device at a time creates a snapshot. */
    snapshotClaim: `${p}.snapshot.claim`,
  } as const;
}

/** Peer sync event types. */
export function peerSyncEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    hello: `${p}.sync.hello`,
    offer: `${p}.sync.offer`,
    request: `${p}.sync.request`,
    events: `${p}.sync.events`,
  } as const;
}

/** Presence heartbeat event type (to-device). */
export function presenceEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    /** Heartbeat ping broadcast to all room members. */
    ping: `${p}.presence.ping`,
  } as const;
}

/** Key distribution event types. */
export function keyEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    announce: `${p}.key.announce`,
    healRequest: `${p}.key.heal.request`,
    healResponse: `${p}.key.heal.response`,
  } as const;
}

/** WebRTC signaling event types (to-device). */
export function peerRtcEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    offer: `${p}.peer.rtc.offer`,
    answer: `${p}.peer.rtc.answer`,
    ice: `${p}.peer.rtc.ice`,
    hangup: `${p}.peer.rtc.hangup`,
  } as const;
}

/** Whisper (ephemeral P2P messaging) signaling event types (to-device only). */
export function whisperEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    /** SDP offer to start a whisper session. */
    invite: `${p}.whisper.invite`,
    /** SDP answer accepting a whisper session. */
    accept: `${p}.whisper.accept`,
    /** Peer declined the whisper invitation. */
    decline: `${p}.whisper.decline`,
    /** ICE candidate exchange during whisper signaling. */
    ice: `${p}.whisper.ice`,
  } as const;
}

/** Collaborative editing (Yjs) signaling event types (to-device). */
export function collabEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    /** Announce that this device is editing a document. */
    announce: `${p}.collab.announce`,
    /** Yjs document update (fallback when WebRTC unavailable). */
    update: `${p}.collab.update`,
    /** Yjs awareness update (cursors, selections). */
    awareness: `${p}.collab.awareness`,
    /** WebRTC SDP offer for collab DataChannel. */
    rtcOffer: `${p}.collab.rtc.offer`,
    /** WebRTC SDP answer for collab DataChannel. */
    rtcAnswer: `${p}.collab.rtc.answer`,
    /** WebRTC ICE candidate exchange. */
    rtcIce: `${p}.collab.rtc.ice`,
    /** Announce that this device stopped editing. */
    leave: `${p}.collab.leave`,
  } as const;
}

/** Test / diagnostic event type (to-device, ephemeral). */
export function testEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    ping: `${p}.test.ping`,
  } as const;
}

/** Permission management event type constants (to-device). */
export const PERMISSIONS_KEY_DELIVER = `${DEFAULT_EVENT_PREFIX}.key.grant`;
/** Room signal broadcast when a user's permissions have changed. */
export const PERMISSIONS_UPDATED = `${DEFAULT_EVENT_PREFIX}.permissions.updated`;

/**
 * EO-native swarm sync (operator-native, replaces peer-sync v2).
 *
 * Three to-device event types form the wire protocol defined in
 * sync.md §4:
 *   - `swarm.v2.control` — ephemeral control queries
 *     (request_piece_bytes, request_tail_events, cancel).
 *   - `swarm.v2.bulk`    — bulk frames over Matrix to-device when
 *     WebRTC is unavailable (fallback).
 *   - `swarm.v2.hello`   — lightweight presence announcement so a
 *     joining device knows who else is currently live.
 *
 * Control and bulk messages do NOT enter the EO log. Only the INS /
 * EVA / REC events the worker emits from verified bytes do.
 */
export function swarmV2EventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    control: `${p}.swarm.v2.control`,
    bulk: `${p}.swarm.v2.bulk`,
    hello: `${p}.swarm.v2.hello`,
  } as const;
}

/** Airtable sync coordination event types (to-device, ephemeral). */
export function airtableSyncEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    /** Sync status broadcast after completion (to-device). */
    signal: `${p}.airtable.signal`,
    /** Sync lock claim/release (to-device). */
    lock: `${p}.airtable.lock`,
  } as const;
}

export interface MatrixDomainConfig {
  eventPrefix?: string;
  dataRoomAlias?: string;
}

export function configureMatrixDomain(cfg: MatrixDomainConfig): void {
  if (cfg.eventPrefix !== undefined) _eventPrefix = cfg.eventPrefix;
  if (cfg.dataRoomAlias !== undefined) _dataRoomAlias = cfg.dataRoomAlias;
}

/**
 * Whether the given homeserver URL belongs to the hosted Amino deployment.
 *
 * Drive + Airtable integrations are tied to shared n8n proxy credentials
 * scoped to `app.aminoimmigration.com` — their UI and network calls are
 * gated on this check so foreign homeservers never see the endpoints.
 */
export function isAminoHomeserver(homeserver: string | undefined | null): boolean {
  if (!homeserver) return false;
  try {
    const host = new URL(homeserver).hostname.toLowerCase();
    return host === 'app.aminoimmigration.com';
  } catch {
    return false;
  }
}
