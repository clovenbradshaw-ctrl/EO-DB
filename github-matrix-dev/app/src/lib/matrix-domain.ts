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
