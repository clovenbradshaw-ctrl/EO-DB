/**
 * Layer 1 — OPFS append-only log.
 *
 * Plaintext msgpack. No per-event encryption. Worker-only write path.
 * openLog() MUST only be called from a Worker context — it requires
 * FileSystemSyncAccessHandle, which is exclusively a Worker-side API.
 *
 * Header format — 16 bytes, little-endian DataView:
 *   [seq: u32][next_offset: u32][payload_length: u32][reserved: u32 = 0]
 *
 *   seq:            the event's sequence number (sanity check on read)
 *   next_offset:    byte offset of the next event's header
 *   payload_length: byte length of the msgpack payload
 *   reserved:       zero; available for future use
 *
 * Replaces:
 *   log.ts appendToLog      (was: IDB put with padded key)
 *   log.ts readLogSince     (was: full IDB iterator scan, O(n))
 *   log.ts readLogForTarget (was: full IDB scan + filter)
 *   log.ts readLogForPrefix (was: full IDB scan + filter)
 */

import { pack, unpack } from 'msgpackr';
import type { EoEvent } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OPFSLog {
  fileHandle: FileSystemFileHandle;
  /** Exclusive synchronous access handle — Worker-only. */
  syncHandle: FileSystemSyncAccessHandle;
  /** Current file size in bytes. Kept in sync by appendEvent(). */
  size: number;
}

const HEADER_BYTES = 16;

// ─── openLog ─────────────────────────────────────────────────────────────────

/**
 * Open (or create) the append-only log file.
 *
 * WORKER-ONLY: FileSystemSyncAccessHandle is only available inside a
 * DedicatedWorkerGlobalScope. Calling this from the main thread will throw
 * a DOMException at the createSyncAccessHandle() call.
 *
 * The initialization is async (Promise-based); the SyncAccessHandle's own
 * read/write/flush/getSize methods are synchronous after this resolves.
 */
export async function openLog(
  opfsDir: FileSystemDirectoryHandle,
): Promise<OPFSLog> {
  const fileHandle = await opfsDir.getFileHandle('log.bin', { create: true });
  // createSyncAccessHandle() grants an exclusive lock for the lifetime of the
  // handle. Only one SyncAccessHandle may be open per file at a time.
  const syncHandle = await fileHandle.createSyncAccessHandle();
  const size = syncHandle.getSize();

  return { fileHandle, syncHandle, size };
}

// ─── appendEvent ─────────────────────────────────────────────────────────────

/**
 * Append a single event to the log. Fully synchronous after the log is open.
 * Returns the byte offset at which the header was written.
 */
export function appendEvent(
  log: OPFSLog,
  event: EoEvent,
): { byteOffset: number } {
  const payload = pack(event) as Uint8Array;

  // Build 16-byte header
  const header = new Uint8Array(HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, event.seq, true);                                   // seq
  view.setUint32(4, log.size + HEADER_BYTES + payload.length, true);    // next_offset
  view.setUint32(8, payload.length, true);                              // payload_length
  view.setUint32(12, 0, true);                                          // reserved

  const byteOffset = log.size;
  log.syncHandle.write(header, { at: byteOffset });
  log.syncHandle.write(payload, { at: byteOffset + HEADER_BYTES });
  log.syncHandle.flush();
  log.size += HEADER_BYTES + payload.length;

  return { byteOffset };
}

// ─── readEventAt ─────────────────────────────────────────────────────────────

/**
 * Read a single event by its byte offset. Synchronous.
 */
export function readEventAt(log: OPFSLog, byteOffset: number): EoEvent {
  const header = new Uint8Array(HEADER_BYTES);
  log.syncHandle.read(header, { at: byteOffset });
  const view = new DataView(header.buffer);
  const payloadLength = view.getUint32(8, true);

  const payload = new Uint8Array(payloadLength);
  log.syncHandle.read(payload, { at: byteOffset + HEADER_BYTES });

  return unpack(payload) as EoEvent;
}

// ─── scanLog ─────────────────────────────────────────────────────────────────

export interface LogScanEntry {
  event: EoEvent;
  byteOffset: number;
  nextOffset: number;
}

/**
 * Forward scan of the log from a given byte offset.
 * Yields { event, byteOffset, nextOffset } for each record.
 *
 * Uses SyncAccessHandle reads — all operations are synchronous.
 */
export function* scanLog(
  log: OPFSLog,
  fromByteOffset = 0,
): Generator<LogScanEntry> {
  let offset = fromByteOffset;
  const headerBuf = new Uint8Array(HEADER_BYTES);

  while (offset < log.size) {
    const bytesRead = log.syncHandle.read(headerBuf, { at: offset });
    if (bytesRead < HEADER_BYTES) break;

    const view = new DataView(headerBuf.buffer);
    const payloadLength = view.getUint32(8, true);
    const nextOffset = view.getUint32(4, true);

    // Sanity-check header fields before allocating / reading payload.
    // A corrupt or partial final write produces wild values here.
    if (
      payloadLength === 0 ||
      payloadLength > 10_000_000 ||
      nextOffset <= offset ||
      nextOffset > log.size + 1_000_000
    ) {
      // Truncate to the last known-good offset so future opens are clean.
      try { log.syncHandle.truncate(offset); log.size = offset; } catch { /* best effort */ }
      break;
    }

    const payload = new Uint8Array(payloadLength);
    log.syncHandle.read(payload, { at: offset + HEADER_BYTES });

    let event: EoEvent;
    try {
      event = unpack(payload) as EoEvent;
    } catch {
      // Corrupt or truncated msgpack at the tail of the log — stop here and
      // truncate so this entry is not re-encountered on the next open.
      console.warn('[EO-DB] OPFS log: corrupt entry at offset', offset, '— truncating and stopping scan');
      try { log.syncHandle.truncate(offset); log.size = offset; } catch { /* best effort */ }
      break;
    }

    yield { event, byteOffset: offset, nextOffset };
    offset = nextOffset;
  }
}
