/**
 * Layer 1 — OPFS append-only log (two-file format, Phase A slice 5).
 *
 * Plaintext msgpack. No per-event encryption. Worker-only write path.
 * openLog() MUST only be called from a Worker context — it requires
 * FileSystemSyncAccessHandle, which is exclusively a Worker-side API.
 *
 * ─── Format ────────────────────────────────────────────────────────────────
 *
 * The log lives in TWO files:
 *
 *   eodb.idx — fixed-stride 40-byte index records.
 *
 *     Bytes  0     : operator nibble (high) + resolution nibble (low)
 *     Bytes  1- 8  : site hash (64-bit xxHash64 of the target string, BE)
 *     Bytes  9-14  : sequence number (48-bit unsigned, BE)
 *     Bytes 15-20  : timestamp ms since epoch (48-bit unsigned, BE)
 *     Bytes 21-28  : payload offset in eodb.pay (64-bit unsigned, BE)
 *     Bytes 29-32  : payload length in eodb.pay (32-bit unsigned, BE)
 *     Bytes 33-39  : reserved (zero) — alignment padding
 *
 *     Operator high-nibble encoding:
 *       NUL=0  SIG=1  INS=2  SEG=3  CON=4  SYN=5  DEF=6  EVA=7  REC=8
 *
 *     Resolution low-nibble encoding (the nine canonical stances; 0 = unspecified):
 *       0 unspecified
 *       1 Clearing      4 Tending       7 Cultivating
 *       2 Dissecting    5 Binding       8 Making
 *       3 Unraveling    6 Tracing       9 Composing
 *
 *   eodb.pay — append-only blob of variable-length msgpack payloads, indexed
 *             by the (offset, length) pair stored in the corresponding
 *             eodb.idx record.
 *
 * ─── Why two files ─────────────────────────────────────────────────────────
 *
 * Headers stay cache-hot — they're 40 bytes each, contiguous, and a forward
 * scan of the index file is a single sequential read with no length-prefix
 * parsing. Phase B's wave barrier and the init-cache builder both walk the
 * full log on startup; that walk is now ~6× smaller in bytes than the old
 * single-file format because the variable payloads are skipped.
 *
 * Random-access by seq becomes O(1) when seqs are dense: index offset =
 * (seq - first_seq) * 40. Even when seqs are sparse, the index file is a
 * fixed-stride array suitable for binary search, where the old single-file
 * format required walking next_offset pointers from the front.
 *
 * Corrupt-payload recovery is also cleaner: a torn payload write can be
 * truncated to the index record's recorded length without rewriting any
 * header positions.
 *
 * ─── Migration from the old single-file format ─────────────────────────────
 *
 * On openLog(), the presence of log.bin is treated as "migration has not yet
 * completed". A clean migration writes ALL events to eodb.idx + eodb.pay,
 * flushes both, and only THEN unlinks log.bin. So if openLog sees log.bin
 * still present:
 *
 *   - either no migration has ever run (eodb.idx is absent), in which case
 *     we run a fresh migration into freshly-created eodb.idx + eodb.pay; or
 *
 *   - a previous migration was killed mid-flight (eodb.idx and/or eodb.pay
 *     exist with partial content), in which case we TRUNCATE both new files
 *     to zero and restart the migration from the legacy log. The legacy log
 *     is the source of truth until the unlink at the end of a successful
 *     migration; partial new-file content is unrecoverable on its own.
 *
 * After a successful migration, log.bin is gone and subsequent opens take
 * the fast path that skips migration logic entirely.
 */

import { pack, unpack } from 'msgpackr';
import type { EoEvent, LoggableOperator, Resolution } from './types';
import { RESOLUTION_NIBBLE, NIBBLE_TO_RESOLUTION } from './types';
import { xxhash64 } from './xxhash64';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OPFSLog {
  /** Fixed-stride index file (40-byte records). */
  idxFileHandle: FileSystemFileHandle;
  /** Variable-length payload file (msgpack blobs). */
  payFileHandle: FileSystemFileHandle;
  /** Index file sync handle — Worker-only. */
  idxHandle: FileSystemSyncAccessHandle;
  /** Payload file sync handle — Worker-only. */
  payHandle: FileSystemSyncAccessHandle;
  /**
   * Combined byte size of both files. Used by the init-cache as a content-
   * change primitive: if the cache key matches `log.size`, the cache is
   * fresh. Either file growing changes this value.
   */
  size: number;
  /** Bytes in eodb.idx. == event count × INDEX_RECORD_BYTES (40). */
  idxBytes: number;
  /** Bytes in eodb.pay. */
  payBytes: number;
  /**
   * Back-compat shim — close both files. Pre-Phase-A callers used
   * `log.syncHandle.close()`; this object's `close()` closes both. The
   * read/write/flush methods on this shim throw because callers should
   * never have used them directly — appendEvent/scanLog are the public
   * surface.
   */
  syncHandle: { close(): void };
}

export const INDEX_RECORD_BYTES = 40;

const IDX_FILE = 'eodb.idx';
const PAY_FILE = 'eodb.pay';
const LEGACY_LOG_FILE = 'log.bin';
const LEGACY_HEADER_BYTES = 16;

// ─── Operator + resolution nibble encoding ──────────────────────────────────

const OP_TO_NIBBLE: Record<LoggableOperator, number> = {
  NUL: 0,
  SIG: 1,
  INS: 2,
  SEG: 3,
  CON: 4,
  SYN: 5,
  DEF: 6,
  EVA: 7,
  REC: 8,
};

const NIBBLE_TO_OP: LoggableOperator[] = [
  'NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC',
];

// Resolution nibble encoding is canonicalized in db/types.ts (RESOLUTION_NIBBLE).
// log-opfs consumes that single source of truth so the two tables can never
// drift apart.

function encodeOpResolution(op: LoggableOperator, resolution?: Resolution): number {
  const opNibble = OP_TO_NIBBLE[op];
  const resNibble: number = resolution ? (RESOLUTION_NIBBLE[resolution] ?? 0) : 0;
  return ((opNibble & 0x0f) << 4) | (resNibble & 0x0f);
}

function decodeOp(byte: number): LoggableOperator {
  const opNibble = (byte >> 4) & 0x0f;
  const op = NIBBLE_TO_OP[opNibble];
  if (!op) throw new Error(`log-opfs: unknown operator nibble ${opNibble}`);
  return op;
}

// ─── 48-bit BE helpers ──────────────────────────────────────────────────────

function writeUint48BE(view: DataView, offset: number, value: number): void {
  if (value < 0 || value > 0xffffffffffff) {
    throw new Error(`log-opfs: 48-bit value out of range: ${value}`);
  }
  // Top 16 bits, then bottom 32 bits.
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  view.setUint16(offset, high, false);
  view.setUint32(offset + 2, low, false);
}

function readUint48BE(view: DataView, offset: number): number {
  const high = view.getUint16(offset, false);
  const low = view.getUint32(offset + 2, false);
  return high * 0x100000000 + low;
}

function writeUint64BE(view: DataView, offset: number, value: number): void {
  // We use Number for offsets up to 2^53 — practical OPFS file sizes never
  // approach that. The high half is `Math.floor(value / 2^32)`.
  const high = Math.floor(value / 0x100000000);
  const low = value >>> 0;
  view.setUint32(offset, high, false);
  view.setUint32(offset + 4, low, false);
}

function readUint64BE(view: DataView, offset: number): number {
  const high = view.getUint32(offset, false);
  const low = view.getUint32(offset + 4, false);
  return high * 0x100000000 + low;
}

// ─── Index record encode / decode ───────────────────────────────────────────

interface IndexRecord {
  op: LoggableOperator;
  /** Depth coordinate — low nibble of byte 0. Defaults to 'unspecified'. */
  resolution?: Resolution;
  siteHash: bigint;
  seq: number;
  ts: number;            // ms since epoch
  payloadOffset: number; // bytes into eodb.pay
  payloadLength: number;
}

function encodeIndexRecord(
  buf: Uint8Array,
  offset: number,
  rec: IndexRecord,
): void {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, INDEX_RECORD_BYTES);

  // Byte 0: op high nibble + resolution low nibble — the compound glyph
  // defined by the lattice model. Events whose resolution is unspecified
  // (or unset) write nibble 0 in the low half.
  view.setUint8(0, encodeOpResolution(rec.op, rec.resolution));

  // Bytes 1-8: site hash (64-bit BE)
  let h = rec.siteHash;
  for (let i = 7; i >= 0; i--) {
    view.setUint8(1 + i, Number(h & 0xffn));
    h >>= 8n;
  }

  // Bytes 9-14: 48-bit seq (BE)
  writeUint48BE(view, 9, rec.seq);

  // Bytes 15-20: 48-bit timestamp ms (BE)
  writeUint48BE(view, 15, rec.ts);

  // Bytes 21-28: 64-bit payload offset (BE)
  writeUint64BE(view, 21, rec.payloadOffset);

  // Bytes 29-32: 32-bit payload length (BE)
  view.setUint32(29, rec.payloadLength, false);

  // Bytes 33-39: reserved (zero) — alignment padding.
  for (let i = 33; i < INDEX_RECORD_BYTES; i++) view.setUint8(i, 0);
}

function decodeIndexRecord(buf: Uint8Array, offset: number): IndexRecord {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, INDEX_RECORD_BYTES);
  const byte0 = view.getUint8(0);
  const op = decodeOp(byte0);
  const resNibble = byte0 & 0x0f;
  const resolution: Resolution = (
    resNibble >= 0 && resNibble < NIBBLE_TO_RESOLUTION.length
      ? NIBBLE_TO_RESOLUTION[resNibble]
      : 'unspecified'
  );

  let siteHash = 0n;
  for (let i = 0; i < 8; i++) {
    siteHash = (siteHash << 8n) | BigInt(view.getUint8(1 + i));
  }

  const seq = readUint48BE(view, 9);
  const ts = readUint48BE(view, 15);
  const payloadOffset = readUint64BE(view, 21);
  const payloadLength = view.getUint32(29, false);

  return { op, resolution, siteHash, seq, ts, payloadOffset, payloadLength };
}

// ─── openLog ─────────────────────────────────────────────────────────────────

/**
 * Open (or create) the append-only two-file log.
 *
 * WORKER-ONLY: FileSystemSyncAccessHandle is only available inside a
 * DedicatedWorkerGlobalScope. Calling this from the main thread will throw
 * a DOMException at the createSyncAccessHandle() call.
 *
 * Migration: if neither eodb.idx nor eodb.pay exist but log.bin (the old
 * pre-slice-5 format) does and is non-empty, this function walks the old
 * log once and re-emits every record into the new two-file format, then
 * unlinks log.bin. The migration is one-shot — subsequent opens see only
 * the new files.
 */
export async function openLog(
  opfsDir: FileSystemDirectoryHandle,
): Promise<OPFSLog> {
  // log.bin presence == "migration not yet complete". A successful migration
  // unlinks log.bin AS ITS LAST STEP, so seeing it now means either no
  // migration has run, or one was killed mid-flight. Either way, run (or
  // re-run) the migration before opening the new files for normal use.
  const legacyExists = await fileExists(opfsDir, LEGACY_LOG_FILE);
  if (legacyExists) {
    await migrateLegacyLog(opfsDir);
  }

  const idxFileHandle = await opfsDir.getFileHandle(IDX_FILE, { create: true });
  const payFileHandle = await opfsDir.getFileHandle(PAY_FILE, { create: true });
  const idxHandle = await idxFileHandle.createSyncAccessHandle();
  const payHandle = await payFileHandle.createSyncAccessHandle();

  const idxBytes = idxHandle.getSize();
  const payBytes = payHandle.getSize();

  const log: OPFSLog = {
    idxFileHandle,
    payFileHandle,
    idxHandle,
    payHandle,
    idxBytes,
    payBytes,
    size: idxBytes + payBytes,
    syncHandle: {
      close() {
        try { idxHandle.close(); } catch { /* best-effort */ }
        try { payHandle.close(); } catch { /* best-effort */ }
      },
    },
  };

  return log;
}

async function fileExists(
  opfsDir: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await opfsDir.getFileHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

// ─── Migration from log.bin ─────────────────────────────────────────────────

/**
 * Migration from the pre-slice-5 single-file format (log.bin, 16-byte header
 * + variable msgpack payload) to the two-file format. Walks every entry in
 * the legacy log, writes the corresponding records into a freshly-truncated
 * eodb.idx + eodb.pay, flushes both, and ONLY THEN unlinks log.bin.
 *
 * The legacy file is the source of truth until that final unlink — if the
 * process dies at any earlier point, the next openLog() will see log.bin
 * still present, truncate any partial new files, and re-run from scratch.
 *
 * Runs serially with createSyncAccessHandle holding exclusive locks. Failure
 * to read any single entry truncates the migration to the last valid prefix
 * and still completes the unlink: corrupt suffix data is irrecoverable
 * either way and there is no benefit to keeping the partially-corrupt
 * legacy log around.
 */
async function migrateLegacyLog(opfsDir: FileSystemDirectoryHandle): Promise<void> {
  const legacyHandle = await opfsDir.getFileHandle(LEGACY_LOG_FILE, { create: false });
  const legacy = await legacyHandle.createSyncAccessHandle();
  const legacySize = legacy.getSize();

  // Empty legacy log: just unlink it and we're done.
  if (legacySize === 0) {
    legacy.close();
    try { await opfsDir.removeEntry(LEGACY_LOG_FILE); } catch { /* best effort */ }
    return;
  }

  // Open the new files for the duration of the migration. If a previous
  // migration left partial content, truncate them to zero before writing.
  const idxFileHandle = await opfsDir.getFileHandle(IDX_FILE, { create: true });
  const payFileHandle = await opfsDir.getFileHandle(PAY_FILE, { create: true });
  const idxHandle = await idxFileHandle.createSyncAccessHandle();
  const payHandle = await payFileHandle.createSyncAccessHandle();

  // Restart-from-scratch invariant: log.bin presence means we cannot trust
  // the new files' current state, so wipe them before writing fresh content.
  try { idxHandle.truncate(0); } catch { /* best effort */ }
  try { payHandle.truncate(0); } catch { /* best effort */ }

  let migrationFinishedCleanly = false;

  try {
    let offset = 0;
    const headerBuf = new Uint8Array(LEGACY_HEADER_BYTES);
    let idxCursor = 0;
    let payCursor = 0;

    while (offset < legacySize) {
      const bytesRead = legacy.read(headerBuf, { at: offset });
      if (bytesRead < LEGACY_HEADER_BYTES) break;

      const view = new DataView(headerBuf.buffer);
      const payloadLength = view.getUint32(8, true);
      const nextOffset = view.getUint32(4, true);

      // Sanity-check before allocating / reading payload (mirrors the
      // robustness checks in the old scanLog).
      if (
        payloadLength === 0 ||
        payloadLength > 10_000_000 ||
        nextOffset <= offset ||
        nextOffset > legacySize + 1_000_000
      ) {
        // Stop migration here — the legacy log is corrupt past this point.
        break;
      }

      const payload = new Uint8Array(payloadLength);
      legacy.read(payload, { at: offset + LEGACY_HEADER_BYTES });

      let event: EoEvent;
      try {
        event = unpack(payload) as EoEvent;
      } catch {
        // Corrupt entry at the tail — stop, leave a clean prefix migrated.
        break;
      }

      // Write the new payload (the bytes are unchanged — same msgpack), then
      // the new index record pointing at it.
      payHandle.write(payload, { at: payCursor });

      const idxBuf = new Uint8Array(INDEX_RECORD_BYTES);
      encodeIndexRecord(idxBuf, 0, {
        op: event.op as LoggableOperator,
        resolution: event.resolution ?? 'unspecified',
        siteHash: xxhash64(event.target),
        seq: event.seq,
        ts: Date.parse(event.ts) || 0,
        payloadOffset: payCursor,
        payloadLength: payload.length,
      });
      idxHandle.write(idxBuf, { at: idxCursor });

      idxCursor += INDEX_RECORD_BYTES;
      payCursor += payload.length;
      offset = nextOffset;
    }

    // Both new files have been fully written. Flush before closing so the
    // OS commits everything to durable storage; the legacy unlink at the
    // very end of openLog is the migration's commit point.
    idxHandle.flush();
    payHandle.flush();
    migrationFinishedCleanly = true;
  } finally {
    idxHandle.close();
    payHandle.close();
    legacy.close();
  }

  // Commit point: ONLY now is it safe to unlink the legacy log. If we get
  // killed before this line runs, the next openLog() sees log.bin still
  // present and re-runs the migration from scratch (truncating the partial
  // new files first).
  if (migrationFinishedCleanly) {
    try { await opfsDir.removeEntry(LEGACY_LOG_FILE); } catch { /* best-effort */ }
  }
}

// ─── appendEvent ─────────────────────────────────────────────────────────────

/**
 * Append a single event to the log. Fully synchronous after the log is open.
 * Returns the byte offset at which the event's INDEX RECORD was written.
 *
 * The returned `byteOffset` is the eodb.idx offset, NOT a payload offset.
 * That keeps the contract with seqToOffset / readEventAt unchanged from the
 * pre-slice-5 API: callers store this value, then later pass it to
 * readEventAt() to fetch the event.
 */
export function appendEvent(
  log: OPFSLog,
  event: EoEvent,
): { byteOffset: number } {
  const payload = pack(event) as Uint8Array;

  const idxOffset = log.idxBytes;
  const payOffset = log.payBytes;

  // Write the payload first so a partial write before the index update
  // leaves the index in a known-clean state.
  log.payHandle.write(payload, { at: payOffset });

  // Build and write the 40-byte index record.
  // Byte 0 is the compound lattice glyph: operator high nibble + resolution
  // low nibble. Events with no explicit resolution write low nibble 0
  // ('unspecified') — the default for every pre-slice-6 event.
  const idxBuf = new Uint8Array(INDEX_RECORD_BYTES);
  encodeIndexRecord(idxBuf, 0, {
    op: event.op as LoggableOperator,
    resolution: event.resolution ?? 'unspecified',
    siteHash: xxhash64(event.target),
    seq: event.seq,
    ts: Date.parse(event.ts) || 0,
    payloadOffset: payOffset,
    payloadLength: payload.length,
  });
  log.idxHandle.write(idxBuf, { at: idxOffset });

  log.payHandle.flush();
  log.idxHandle.flush();

  log.payBytes += payload.length;
  log.idxBytes += INDEX_RECORD_BYTES;
  log.size = log.idxBytes + log.payBytes;

  return { byteOffset: idxOffset };
}

// ─── readEventAt ─────────────────────────────────────────────────────────────

/**
 * Read a single event by its INDEX FILE offset. Synchronous.
 *
 * Looks up the index record at `byteOffset` (which must be a multiple of
 * INDEX_RECORD_BYTES), then dereferences the payload offset/length stored
 * inside it.
 */
export function readEventAt(log: OPFSLog, byteOffset: number): EoEvent {
  const idxBuf = new Uint8Array(INDEX_RECORD_BYTES);
  log.idxHandle.read(idxBuf, { at: byteOffset });
  const rec = decodeIndexRecord(idxBuf, 0);

  const payload = new Uint8Array(rec.payloadLength);
  log.payHandle.read(payload, { at: rec.payloadOffset });

  return unpack(payload) as EoEvent;
}

// ─── scanLog ─────────────────────────────────────────────────────────────────

export interface LogScanEntry {
  event: EoEvent;
  byteOffset: number;
  nextOffset: number;
}

/**
 * Forward scan of the log from a given INDEX FILE offset. Yields
 * { event, byteOffset, nextOffset } for each record in the index.
 *
 * Walks the index file with fixed-stride reads — no length-prefix parsing,
 * no per-record header decoding beyond the 40-byte record itself. The
 * payload file is read once per record, only when the entry is yielded.
 */
export function* scanLog(
  log: OPFSLog,
  fromByteOffset = 0,
): Generator<LogScanEntry> {
  // Snap to a record boundary if the caller hands us a non-aligned offset.
  let offset = fromByteOffset - (fromByteOffset % INDEX_RECORD_BYTES);
  const idxBuf = new Uint8Array(INDEX_RECORD_BYTES);

  while (offset < log.idxBytes) {
    const bytesRead = log.idxHandle.read(idxBuf, { at: offset });
    if (bytesRead < INDEX_RECORD_BYTES) break;

    let rec: IndexRecord;
    try {
      rec = decodeIndexRecord(idxBuf, 0);
    } catch {
      // Unknown operator nibble — corrupt index entry. Truncate the index
      // file at this point so we don't re-encounter it on the next open.
      try {
        log.idxHandle.truncate(offset);
        log.idxBytes = offset;
        log.size = log.idxBytes + log.payBytes;
      } catch { /* best effort */ }
      break;
    }

    // Sanity-check the payload pointer before reading.
    if (
      rec.payloadLength === 0 ||
      rec.payloadLength > 10_000_000 ||
      rec.payloadOffset + rec.payloadLength > log.payBytes + 1_000_000
    ) {
      try {
        log.idxHandle.truncate(offset);
        log.idxBytes = offset;
        log.size = log.idxBytes + log.payBytes;
      } catch { /* best effort */ }
      break;
    }

    const payload = new Uint8Array(rec.payloadLength);
    log.payHandle.read(payload, { at: rec.payloadOffset });

    let event: EoEvent;
    try {
      event = unpack(payload) as EoEvent;
    } catch {
      console.warn('[EO-DB] log-opfs: corrupt payload at idx offset', offset, '— truncating index and stopping scan');
      try {
        log.idxHandle.truncate(offset);
        log.idxBytes = offset;
        log.size = log.idxBytes + log.payBytes;
      } catch { /* best effort */ }
      break;
    }

    const nextOffset = offset + INDEX_RECORD_BYTES;
    yield { event, byteOffset: offset, nextOffset };
    offset = nextOffset;
  }
}
