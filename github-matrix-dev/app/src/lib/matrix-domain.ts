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
    /** Filen sync notification: tells other devices to fetch from Filen. */
    filenSync: `${p}.filen.sync`,
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

/** Key distribution event types. */
export function keyEventTypes(prefix?: string) {
  const p = prefix ?? _eventPrefix;
  return {
    announce: `${p}.key.announce`,
    healRequest: `${p}.key.heal.request`,
    healResponse: `${p}.key.heal.response`,
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
