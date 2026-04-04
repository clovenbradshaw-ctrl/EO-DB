/**
 * Backup monitor — reads Matrix room state and timeline events to compute
 * per-user health status for the cloud storage dashboard.
 *
 * Reads:
 * - eo.backup.head state event → latest data pointer
 * - eo.backup.horizon state event → latest snapshot pointer
 * - eo.backup.signal timeline events → recent upload history per user
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';

const EO_BACKUP_SIGNAL = 'eo.backup.signal';
const EO_BACKUP_HEAD = 'eo.backup.head';
const EO_BACKUP_HORIZON = 'eo.backup.horizon';

export interface BackupSignal {
  uploader: string;
  seq: number;
  event_count: number;
  uploaded_at: string;
  size_bytes: number;
  filen_path: string;
}

export interface UserBackupStatus {
  userId: string;
  lastUploadAt: string;
  lastSeq: number;
  status: 'active' | 'stale' | 'offline';
}

export interface BackupHealth {
  /** Whether org-mode is active (eo.filen.config exists). */
  orgMode: boolean;
  /** Current head pointer. */
  headSeq: number;
  headUpdatedAt: string;
  headUpdatedBy: string;
  headFilenPath: string;
  headFolderUuid: string;
  /** Snapshot/horizon pointer. */
  horizonSeq: number;
  horizonCompactedAt: string;
  horizonCompactedBy: string;
  /** Recent backup signals from room timeline. */
  recentSignals: BackupSignal[];
  /** Per-user status computed from signals. */
  perUserStatus: UserBackupStatus[];
}

/**
 * Read backup health from Matrix room state + timeline.
 * Returns null if the room or client is unavailable.
 */
export function readBackupHealth(
  matrixClient: MatrixClient,
  roomId: string,
  spaceId: string,
): BackupHealth | null {
  const room = matrixClient.getRoom(roomId);
  if (!room) return null;

  // Check org mode
  const configEvent = room.currentState.getStateEvents('eo.filen.config' as any, '');
  const orgMode = !!(configEvent && (configEvent as any).getContent?.()?.apiKey);

  // Read head state
  const headEvent = room.currentState.getStateEvents(EO_BACKUP_HEAD as any, spaceId);
  const head = headEvent ? (headEvent as any).getContent?.() ?? {} : {};

  // Read horizon state
  const horizonEvent = room.currentState.getStateEvents(EO_BACKUP_HORIZON as any, spaceId);
  const horizon = horizonEvent ? (horizonEvent as any).getContent?.() ?? {} : {};

  // Collect recent backup signals from timeline
  const timeline = room.getLiveTimeline().getEvents();
  const recentSignals: BackupSignal[] = [];
  const userLastSeen = new Map<string, { at: string; seq: number }>();

  for (const event of timeline) {
    if (event.getType() !== EO_BACKUP_SIGNAL) continue;
    const content = event.getContent();
    if (!content.uploader) continue;

    const signal: BackupSignal = {
      uploader: content.uploader,
      seq: content.seq || 0,
      event_count: content.event_count || 0,
      uploaded_at: content.uploaded_at || new Date(event.getTs()).toISOString(),
      size_bytes: content.size_bytes || 0,
      filen_path: content.filen_path || '',
    };
    recentSignals.push(signal);

    // Track per-user latest
    const existing = userLastSeen.get(content.uploader);
    if (!existing || signal.seq > existing.seq) {
      userLastSeen.set(content.uploader, { at: signal.uploaded_at, seq: signal.seq });
    }
  }

  // Compute per-user status
  const now = Date.now();
  const perUserStatus: UserBackupStatus[] = [];
  for (const [userId, info] of userLastSeen) {
    const ageMs = now - new Date(info.at).getTime();
    let status: 'active' | 'stale' | 'offline';
    if (ageMs < 5 * 60_000) status = 'active';       // < 5 min
    else if (ageMs < 60 * 60_000) status = 'stale';   // < 1 hour
    else status = 'offline';                            // > 1 hour

    perUserStatus.push({
      userId,
      lastUploadAt: info.at,
      lastSeq: info.seq,
      status,
    });
  }

  // Sort by last upload (most recent first)
  perUserStatus.sort((a, b) =>
    new Date(b.lastUploadAt).getTime() - new Date(a.lastUploadAt).getTime(),
  );

  return {
    orgMode,
    headSeq: head.seq || 0,
    headUpdatedAt: head.updated_at || '',
    headUpdatedBy: head.updated_by || '',
    headFilenPath: head.filen_path || '',
    headFolderUuid: head.folder_uuid || '',
    horizonSeq: horizon.seq || 0,
    horizonCompactedAt: horizon.compacted_at || '',
    horizonCompactedBy: horizon.compacted_by || '',
    recentSignals: recentSignals.slice(-50), // keep last 50
    perUserStatus,
  };
}
