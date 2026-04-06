/**
 * Pipeline bridge — maps Filen change events into EO-DB events.
 *
 * Each FilenChangeEvent is translated into an EoEventInput and emitted
 * through a DirectSink, integrating Filen file activity into the
 * standard EO event log and changefeed.
 */

import type { EoEventInput, LoggableOperator } from '../db/types.js';
import { DirectSink } from '../ingestion/event-sink.js';
import type { EoDb } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import type { FilenChangeEvent, FilenSocketEventType } from './types.js';

/** Map Filen event types to EO operators. */
function eventTypeToOp(type: FilenSocketEventType): LoggableOperator {
  switch (type) {
    case 'fileNew':
    case 'fileRestore':
    case 'fileArchiveRestored':
    case 'folderSubCreated':
    case 'folderRestore':
      return 'INS';

    case 'fileRename':
    case 'fileMove':
    case 'folderRename':
    case 'folderMove':
    case 'folderColorChanged':
      return 'DEF';

    case 'fileTrash':
    case 'fileArchived':
    case 'fileDeletedPermanent':
    case 'folderTrash':
      return 'NUL';

    default:
      return 'DEF';
  }
}

export class FilenPipelineBridge {
  private sink: DirectSink;

  constructor(db: EoDb, feed: Feed) {
    this.sink = new DirectSink(db, feed);
  }

  /**
   * Handle a Filen change event by folding it into the EO-DB log.
   * Returns the assigned sequence number.
   */
  async handleEvent(event: FilenChangeEvent): Promise<number> {
    const eoEvent = this.toEoEvent(event);
    return this.sink.emit(eoEvent);
  }

  private toEoEvent(event: FilenChangeEvent): EoEventInput {
    const now = new Date().toISOString();

    return {
      op: eventTypeToOp(event.type),
      target: `filen.${event.folderUuid}.${event.uuid}`,
      operand: {
        filen_event_type: event.type,
        uuid: event.uuid,
        name: event.name,
        folder_uuid: event.folderUuid,
        timestamp: event.timestamp,
      },
      agent: 'system:filen',
      ts: new Date(event.timestamp).toISOString(),
      acquired_ts: now,
      meta: { source: 'filen', event_type: event.type, space_id: event.spaceId },
    };
  }
}
