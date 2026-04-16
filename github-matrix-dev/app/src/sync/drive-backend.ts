/**
 * Google Drive archive backend for the memory-fading system.
 *
 * Uploads archived piece bytes to a per-space folder on Drive
 * (`EO-DB/eo-archive-<spaceId>/`) using the same direct/n8n transport that
 * the rest of the Drive integration uses. Returns a `drive://<fileId>` URI
 * that the rehydrate path can dereference.
 *
 * Integrity:
 *   - Uploads: Drive doesn't checksum for us, so we hash the bytes before
 *     upload (sha256) and include the hash in the filename. The archiver
 *     passes the expected content_hash alongside the bytes and we assert
 *     they match before writing anything remote. Mismatch → throw.
 *   - Downloads: `fetchArchive` hashes the returned bytes and compares
 *     against the expected content_hash. Mismatch → throw, caller leaves
 *     the piece archived and logs the failure.
 *
 * The backend is instantiated per space. Token + spaceId are read at each
 * call rather than snapshotted on construction so the user can reconnect
 * their Drive account without re-wiring the archiver.
 */

import type { ArchiveBackend } from './archiver';
import type { ArchiveScheme } from './operators';
import { gdriveStoreNamed, gdriveRetrieveNamed } from '../google-drive/gdrive-api';

// ─── URI format ──────────────────────────────────────────────────────────

const DRIVE_URI_PREFIX = 'drive://';

export function formatDriveUri(fileId: string): string {
  if (!fileId) throw new Error('formatDriveUri: fileId must be non-empty');
  if (fileId.includes('/')) throw new Error('formatDriveUri: fileId must not contain "/"');
  return DRIVE_URI_PREFIX + fileId;
}

export function parseDriveUri(uri: string): { fileId: string } | null {
  if (!uri.startsWith(DRIVE_URI_PREFIX)) return null;
  const fileId = uri.slice(DRIVE_URI_PREFIX.length);
  if (!fileId || fileId.includes('/')) return null;
  return { fileId };
}

// ─── Config ──────────────────────────────────────────────────────────────

export interface DriveBackendConfig {
  /**
   * Provide the current Google OAuth access token (or Matrix token when in
   * n8n-proxy mode — the underlying gdrive-api handles the switch). Called
   * before each upload/fetch, so the backend picks up token refreshes.
   */
  getToken: () => string | null;
  /**
   * Provide the current space id, used as the archive folder's data-type
   * scope: `eo-archive-<spaceId>`. Called per op so space switches take
   * effect immediately.
   */
  getSpaceId: () => string | null;
}

// ─── Archive backend ────────────────────────────────────────────────────

export class DriveArchiveBackend implements ArchiveBackend {
  readonly scheme: ArchiveScheme = 'drive';
  private readonly cfg: DriveBackendConfig;

  constructor(cfg: DriveBackendConfig) {
    this.cfg = cfg;
  }

  async uploadPiece(args: {
    piece_site: string;
    content_hash: string;
    bytes: Uint8Array;
  }): Promise<{ archive_uri: string; size_bytes: number }> {
    const token = this.cfg.getToken();
    if (!token) throw new Error('DriveArchiveBackend: no access token');
    const spaceId = this.cfg.getSpaceId();
    if (!spaceId) throw new Error('DriveArchiveBackend: no spaceId');

    // Pre-upload integrity check: the content_hash announced by the
    // archiver must match sha256(bytes). If it doesn't, something upstream
    // is already broken; refuse to write anything remote.
    const actualHash = await sha256Hex(args.bytes);
    if (actualHash !== args.content_hash) {
      throw new Error(
        `DriveArchiveBackend: pre-upload hash mismatch (expected ${args.content_hash}, got ${actualHash})`,
      );
    }

    const dataType = archiveDataType(spaceId);
    const fileName = archiveFileName(args.content_hash);
    const result = await gdriveStoreNamed(token, args.bytes, dataType, fileName);
    if (!result.ok || !result.drive_file_id) {
      throw new Error('DriveArchiveBackend: gdriveStoreNamed returned no file id');
    }
    return {
      archive_uri: formatDriveUri(result.drive_file_id),
      size_bytes: args.bytes.length,
    };
  }
}

// ─── Rehydrate fetcher ──────────────────────────────────────────────────

/**
 * Companion to `DriveArchiveBackend` for the rehydrate path. Reads bytes
 * back out of Drive given an archive URI and verifies against the expected
 * content hash. Returns bytes on success, throws on mismatch / missing.
 */
export async function driveFetchArchive(args: {
  cfg: DriveBackendConfig;
  archive_uri: string;
  content_hash: string;
}): Promise<Uint8Array> {
  const token = args.cfg.getToken();
  if (!token) throw new Error('driveFetchArchive: no access token');
  const spaceId = args.cfg.getSpaceId();
  if (!spaceId) throw new Error('driveFetchArchive: no spaceId');

  const parsed = parseDriveUri(args.archive_uri);
  if (!parsed) {
    throw new Error(`driveFetchArchive: not a drive uri: ${args.archive_uri}`);
  }

  // We don't have a by-fileId download helper exported from gdrive-api (the
  // existing helpers go via data-type + filename). Filename is deterministic
  // from content_hash, so use the name-based retrieve.
  const dataType = archiveDataType(spaceId);
  const fileName = archiveFileName(args.content_hash);
  const result = await gdriveRetrieveNamed(token, dataType, fileName);
  if (!result || !result.ok) {
    throw new Error(`driveFetchArchive: file not found (${fileName}) in ${dataType}`);
  }

  // Tripwire: if the file-id of the retrieved file doesn't match what the
  // archive_uri points at, we still trust the bytes (content-addressed),
  // but log — this indicates the file was re-created under the same name,
  // probably by a concurrent writer.
  if (result.fileId && parsed.fileId && result.fileId !== parsed.fileId) {
    console.warn(
      `[archiver] drive fileId drift for ${fileName}: uri says ${parsed.fileId}, found ${result.fileId}`,
    );
  }

  const actualHash = await sha256Hex(result.data);
  if (actualHash !== args.content_hash) {
    throw new Error(
      `driveFetchArchive: hash mismatch (expected ${args.content_hash}, got ${actualHash})`,
    );
  }
  return result.data;
}

// ─── Naming ─────────────────────────────────────────────────────────────

/** Per-space Drive folder suffix for archived pieces. */
export function archiveDataType(spaceId: string): string {
  if (!spaceId) throw new Error('archiveDataType: spaceId must be non-empty');
  return `eo-archive-${spaceId}`;
}

/** Filename format for an archived piece: content-addressed. */
export function archiveFileName(content_hash: string): string {
  if (!content_hash) throw new Error('archiveFileName: content_hash must be non-empty');
  if (content_hash.includes('/') || content_hash.includes('\\')) {
    throw new Error('archiveFileName: content_hash contains forbidden separators');
  }
  return `piece-${content_hash}.eodb`;
}

// ─── Hashing ────────────────────────────────────────────────────────────

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
