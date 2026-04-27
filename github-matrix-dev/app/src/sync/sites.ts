/**
 * Sync-layer site builders and parsers.
 *
 * Sites are addresses. Events occur at sites. These five families cover the
 * sync layer:
 *
 *   swarm:<roomId>                              — one per joined room
 *   peer:<userId>|<deviceId>                    — many per swarm
 *   log:<authorDeviceId>                        — one per author seen
 *   piece:<authorDeviceId>/v<version>/<index>   — many per author
 *   tail:<authorDeviceId>                       — one per author
 *
 * Site strings are stored in `EoEvent.target` — the repo's existing address
 * field. `isSyncTarget` is the check the fold worker calls on the wire;
 * `isSyncSite` is its alias for readability in places that conceptually
 * speak of "sites".
 */

export const SWARM_PREFIX = 'swarm:';
export const PEER_PREFIX = 'peer:';
export const LOG_PREFIX = 'log:';
export const PIECE_PREFIX = 'piece:';
export const TAIL_PREFIX = 'tail:';

export const PIECE_SCHEMA_VERSION = 1;

// ─── Builders ────────────────────────────────────────────────────────────

export function swarmSite(roomId: string): string {
  assertNoDelimiters('roomId', roomId, ['|', '/']);
  return SWARM_PREFIX + roomId;
}

export function peerSite(userId: string, deviceId: string): string {
  assertNoDelimiters('userId', userId, ['|']);
  assertNoDelimiters('deviceId', deviceId, ['|']);
  return PEER_PREFIX + userId + '|' + deviceId;
}

export function logSite(authorDeviceId: string): string {
  assertNoDelimiters('authorDeviceId', authorDeviceId, ['|', '/']);
  return LOG_PREFIX + authorDeviceId;
}

export function pieceSite(
  authorDeviceId: string,
  pieceIndex: number,
  version: number = PIECE_SCHEMA_VERSION,
): string {
  assertNoDelimiters('authorDeviceId', authorDeviceId, ['|', '/']);
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0) {
    throw new Error(`pieceIndex must be a non-negative integer, got ${pieceIndex}`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`version must be a positive integer, got ${version}`);
  }
  return `${PIECE_PREFIX}${authorDeviceId}/v${version}/${pieceIndex}`;
}

export function tailSite(authorDeviceId: string): string {
  assertNoDelimiters('authorDeviceId', authorDeviceId, ['|', '/']);
  return TAIL_PREFIX + authorDeviceId;
}

// ─── Parsers ─────────────────────────────────────────────────────────────

export interface ParsedSwarmSite {
  family: 'swarm';
  roomId: string;
}

export interface ParsedPeerSite {
  family: 'peer';
  userId: string;
  deviceId: string;
}

export interface ParsedLogSite {
  family: 'log';
  authorDeviceId: string;
}

export interface ParsedPieceSite {
  family: 'piece';
  authorDeviceId: string;
  version: number;
  pieceIndex: number;
}

export interface ParsedTailSite {
  family: 'tail';
  authorDeviceId: string;
}

export type ParsedSyncSite =
  | ParsedSwarmSite
  | ParsedPeerSite
  | ParsedLogSite
  | ParsedPieceSite
  | ParsedTailSite;

export type SyncSiteFamily = ParsedSyncSite['family'];

export function parseSwarmSite(s: string): ParsedSwarmSite | null {
  if (!s.startsWith(SWARM_PREFIX)) return null;
  const roomId = s.slice(SWARM_PREFIX.length);
  if (!roomId) return null;
  return { family: 'swarm', roomId };
}

export function parsePeerSite(s: string): ParsedPeerSite | null {
  if (!s.startsWith(PEER_PREFIX)) return null;
  const body = s.slice(PEER_PREFIX.length);
  const pipe = body.indexOf('|');
  if (pipe <= 0 || pipe === body.length - 1) return null;
  const userId = body.slice(0, pipe);
  const deviceId = body.slice(pipe + 1);
  if (deviceId.includes('|')) return null;
  return { family: 'peer', userId, deviceId };
}

export function parseLogSite(s: string): ParsedLogSite | null {
  if (!s.startsWith(LOG_PREFIX)) return null;
  const authorDeviceId = s.slice(LOG_PREFIX.length);
  if (!authorDeviceId || authorDeviceId.includes('/') || authorDeviceId.includes('|')) return null;
  return { family: 'log', authorDeviceId };
}

export function parsePieceSite(s: string): ParsedPieceSite | null {
  if (!s.startsWith(PIECE_PREFIX)) return null;
  const body = s.slice(PIECE_PREFIX.length);
  const parts = body.split('/');
  if (parts.length !== 3) return null;
  const [authorDeviceId, versionPart, indexPart] = parts;
  if (!authorDeviceId || authorDeviceId.includes('|')) return null;
  if (!versionPart.startsWith('v')) return null;
  const version = Number(versionPart.slice(1));
  const pieceIndex = Number(indexPart);
  if (!Number.isInteger(version) || version < 1) return null;
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0) return null;
  return { family: 'piece', authorDeviceId, version, pieceIndex };
}

export function parseTailSite(s: string): ParsedTailSite | null {
  if (!s.startsWith(TAIL_PREFIX)) return null;
  const authorDeviceId = s.slice(TAIL_PREFIX.length);
  if (!authorDeviceId || authorDeviceId.includes('/') || authorDeviceId.includes('|')) return null;
  return { family: 'tail', authorDeviceId };
}

export function parseSyncSite(s: string): ParsedSyncSite | null {
  return (
    parseSwarmSite(s) ||
    parsePeerSite(s) ||
    parseLogSite(s) ||
    parsePieceSite(s) ||
    parseTailSite(s)
  );
}

export function siteFamily(s: string): SyncSiteFamily | null {
  const parsed = parseSyncSite(s);
  return parsed ? parsed.family : null;
}

// ─── Type guards ─────────────────────────────────────────────────────────

/** Type guard used by the fold worker — `event.target` is the wire-side field. */
export function isSyncTarget(target: string): boolean {
  return parseSyncSite(target) !== null;
}

/** Alias for contexts that conceptually speak of "sites" rather than targets. */
export function isSyncSite(site: string): boolean {
  return isSyncTarget(site);
}

// ─── Internals ───────────────────────────────────────────────────────────

function assertNoDelimiters(name: string, value: string, forbidden: string[]): void {
  if (!value) throw new Error(`${name} must be non-empty`);
  for (const d of forbidden) {
    if (value.includes(d)) {
      throw new Error(`${name} must not contain '${d}' (got ${JSON.stringify(value)})`);
    }
  }
}
