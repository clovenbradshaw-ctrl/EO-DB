/**
 * Domain-agnostic Matrix configuration.
 *
 * All Matrix homeserver URLs, event type prefixes, and identity strings
 * are derived from environment variables or runtime configuration so the
 * app is not coupled to any specific homeserver domain.
 *
 * Environment variables:
 *   EO_MATRIX_HOMESERVER   — Base URL of the Matrix homeserver (e.g. "https://matrix.example.com")
 *   EO_WEBHOOK_USER        — Full Matrix user ID for webhook/bot identity (e.g. "@bot:matrix.example.com")
 *   EO_EVENT_PREFIX         — Custom event type namespace (default: "com.eo-db")
 *   EO_DATA_ROOM_ALIAS     — Matrix room alias for the data room (e.g. "#data:matrix.example.com")
 */

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_EVENT_PREFIX = 'com.eo-db';

// ─── Runtime state ──────────────────────────────────────────────────────────

let _homeserver = process.env.EO_MATRIX_HOMESERVER || '';
let _webhookUser = process.env.EO_WEBHOOK_USER || '';
let _eventPrefix = process.env.EO_EVENT_PREFIX || DEFAULT_EVENT_PREFIX;
let _dataRoomAlias = process.env.EO_DATA_ROOM_ALIAS || '';

// ─── Getters ────────────────────────────────────────────────────────────────

export function getHomeserver(): string {
  return _homeserver;
}

export function getWebhookUser(): string {
  return _webhookUser;
}

export function getEventPrefix(): string {
  return _eventPrefix;
}

export function getDataRoomAlias(): string {
  return _dataRoomAlias;
}

// ─── Event type builders ────────────────────────────────────────────────────

/** Key distribution event types (server-side crypto). */
export function keyEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    announce: `${p}.key.announce`,
    healRequest: `${p}.key.heal.request`,
    healResponse: `${p}.key.heal.response`,
  } as const;
}

/** EO data event types (browser-side sync). */
export function eoEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    event: `${p}.event`,
    snapshot: `${p}.snapshot`,
    /** Room state event: stores the latest snapshot URI for fast hydration. */
    snapshotState: `${p}.snapshot_state`,
  } as const;
}

/** Peer sync event types (browser-side device-to-device). */
export function peerSyncEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    hello: `${p}.sync.hello`,
    offer: `${p}.sync.offer`,
    request: `${p}.sync.request`,
    events: `${p}.sync.events`,
  } as const;
}

/**
 * Room sync event types.
 *
 * These are used for coordinator-to-client communication about the
 * Airtable sync status within a room. The actual data flows as normal
 * EO events through the changefeed — these types are metadata only.
 */
export function roomSyncEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    /** Broadcast when a primary syncer is elected/changed for a room binding. */
    primaryElected: `${p}.room-sync.primary`,
    /** Broadcast after each successful sync cycle with summary stats. */
    syncComplete: `${p}.room-sync.complete`,
    /** Broadcast when a sync cycle fails. */
    syncError: `${p}.room-sync.error`,
  } as const;
}

// ─── Setter (call once at startup) ──────────────────────────────────────────

export interface MatrixDomainConfig {
  homeserver?: string;
  webhookUser?: string;
  eventPrefix?: string;
  dataRoomAlias?: string;
}

export function configureMatrixDomain(cfg: MatrixDomainConfig): void {
  if (cfg.homeserver !== undefined) _homeserver = cfg.homeserver;
  if (cfg.webhookUser !== undefined) _webhookUser = cfg.webhookUser;
  if (cfg.eventPrefix !== undefined) _eventPrefix = cfg.eventPrefix;
  if (cfg.dataRoomAlias !== undefined) _dataRoomAlias = cfg.dataRoomAlias;
}
