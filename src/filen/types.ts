/**
 * Filen socket listener — type definitions.
 *
 * Maps Filen SDK socket events into a normalized shape that the
 * EO-DB pipeline can consume.
 */

// ─── Socket event types we care about ──────────────────────────────────────

export type FilenSocketEventType =
  | 'fileNew'
  | 'fileRename'
  | 'fileMove'
  | 'fileTrash'
  | 'fileRestore'
  | 'fileArchived'
  | 'fileArchiveRestored'
  | 'fileDeletedPermanent'
  | 'folderSubCreated'
  | 'folderRename'
  | 'folderMove'
  | 'folderTrash'
  | 'folderRestore'
  | 'folderColorChanged';

/** All socket event types we subscribe to. */
export const WATCHED_EVENTS: FilenSocketEventType[] = [
  'fileNew',
  'fileRename',
  'fileMove',
  'fileTrash',
  'fileRestore',
  'fileArchived',
  'fileArchiveRestored',
  'fileDeletedPermanent',
  'folderSubCreated',
  'folderRename',
  'folderMove',
  'folderTrash',
  'folderRestore',
  'folderColorChanged',
];

// ─── Normalized change event ───────────────────────────────────────────────

/** Unified event emitted by the listener after folder-filtering. */
export interface FilenChangeEvent {
  type: FilenSocketEventType;
  uuid: string;
  name: string;
  folderUuid: string;
  /** Space ID this event belongs to (set when listener is space-aware). */
  spaceId?: string;
  timestamp: number;
  raw: unknown;
}

export type FilenChangeHandler = (event: FilenChangeEvent) => void;

// ─── Configuration ─────────────────────────────────────────────────────────

export interface FilenListenerConfig {
  /** Auth: email/password login. */
  email?: string;
  password?: string;
  twoFactorCode?: string;
  /** Auth: apiKey login (from n8n webhook / org mode). */
  apiKey?: string;
  masterKeys?: string[];
  /**
   * Initial folder UUID to watch. Can be changed later via switchFolder().
   * When used with spaces, this is set to the current space's folder UUID.
   */
  folderUuid: string;
  /** Space ID associated with the folder (e.g. "space_amino"). */
  spaceId?: string;
  /** Path within the Filen virtual FS to the watched folder (e.g. "/EO-DB/amino"). */
  folderPath?: string;
  healthCheckIntervalMs?: number;
}
