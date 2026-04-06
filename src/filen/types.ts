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
  timestamp: number;
  raw: unknown;
}

export type FilenChangeHandler = (event: FilenChangeEvent) => void;

// ─── Configuration ─────────────────────────────────────────────────────────

export interface FilenListenerConfig {
  email?: string;
  password?: string;
  twoFactorCode?: string;
  apiKey?: string;
  masterKeys?: string[];
  folderUuid: string;
  /** Path within the Filen virtual FS to the watched folder (e.g. "/EO-DB"). */
  folderPath?: string;
  healthCheckIntervalMs?: number;
}
