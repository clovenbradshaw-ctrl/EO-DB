/**
 * Drive change bridge — maps Google Drive change notifications into EO-DB events.
 *
 * Same pattern as FilenPipelineBridge: translates external file-system activity
 * into EoEventInputs and folds them through a DirectSink into the event log.
 *
 * Drive change notifications arrive as `eo.n8n.drive.change` events, either:
 *   - Via Matrix room timeline (from the n8n Drive Watcher workflow)
 *   - Via the POST /n8n/drive-change webhook (direct from n8n)
 *
 * The bridge normalises both paths into the same EO operator mapping.
 */

import type { EoEventInput, LoggableOperator } from '../db/types.js';
import { DirectSink } from '../ingestion/event-sink.js';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { DriveChangeNotification } from './types.js';

/** Map Drive change types to EO operators. */
function changeTypeToOp(changeType: DriveChangeNotification['change_type']): LoggableOperator {
  switch (changeType) {
    case 'created':
      return 'INS';
    case 'modified':
      return 'DEF';
    case 'deleted':
      return 'NUL';
    default:
      return 'DEF';
  }
}

export type DriveChangeHandler = (event: DriveChangeNotification) => void;

export class DriveChangeBridge {
  private sink: DirectSink;
  private handlers: Set<DriveChangeHandler> = new Set();

  constructor(db: EoDb, feed: Feed) {
    this.sink = new DirectSink(db, feed);
  }

  /**
   * Handle a Drive change notification by folding it into the EO-DB log.
   * Returns the assigned sequence number.
   */
  async handleChange(notification: DriveChangeNotification): Promise<number> {
    const eoEvent = this.toEoEvent(notification);
    const seq = await this.sink.emit(eoEvent);

    // Notify any registered handlers (e.g. for changefeed push)
    for (const handler of this.handlers) {
      try { handler(notification); } catch { /* non-fatal */ }
    }

    return seq;
  }

  /**
   * Handle a batch of Drive change notifications.
   */
  async handleBatch(notifications: DriveChangeNotification[]): Promise<number[]> {
    const seqs: number[] = [];
    for (const n of notifications) {
      seqs.push(await this.handleChange(n));
    }
    return seqs;
  }

  /** Register a handler for processed drive changes. Returns an unsubscribe fn. */
  onChange(handler: DriveChangeHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  private toEoEvent(notification: DriveChangeNotification): EoEventInput {
    const now = new Date().toISOString();

    return {
      op: changeTypeToOp(notification.change_type),
      target: `gdrive.${notification.drive_folder}.${notification.file_id}`,
      operand: {
        drive_file_id: notification.file_id,
        file_name: notification.file_name,
        mime_type: notification.mime_type,
        size: notification.size,
        change_type: notification.change_type,
        drive_folder: notification.drive_folder,
        detected_at: notification.detected_at,
      },
      agent: 'system:n8n-drive',
      ts: notification.detected_at || now,
      acquired_ts: now,
      meta: { source: 'google-drive', change_type: notification.change_type },
    };
  }
}
