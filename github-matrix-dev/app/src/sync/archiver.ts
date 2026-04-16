/**
 * Memory-fading archiver — the EVA→REC slot of the DEF→EVA→REC archival loop.
 *
 * The cache site's ⊢DEF (from `operators.ts`, built/edited through the UI)
 * defines the retention schema: `enabled`, watermarks, attestation floor,
 * hot window. This module is the recurring evaluation pass over the
 * projection: it measures usage (⊨EVA), selects pieces that satisfy the
 * archival predicate, uploads their bytes to a durable URI backend, and
 * emits the REC events that record the demotion.
 *
 * Design notes:
 *
 *   - No state of its own. `selectForArchival` is pure; `runArchiverTick`
 *     composes pure selection with side-effectful IO (measure + upload +
 *     emit). Same projection + same usage + same DEF → same selection.
 *
 *   - Hysteresis: archiving starts when usage > high_watermark_mb and
 *     continues until it drops below low_watermark_mb. This is the "DEF
 *     resistance" that keeps the loop from thrashing.
 *
 *   - Never drops bytes without an archive URI. If the upload fails, no
 *     REC is emitted and the piece stays resident. Availability is
 *     preserved by construction.
 *
 *   - The scheduler's rarest-first request path already handles rehydrate:
 *     an `archived` piece with no `instantiatedHash` is skipped by
 *     `pieceStatus` filters (scheduler only requests absent/signaled/
 *     contested), so rehydrate is an explicit act — a consumer needs the
 *     bytes and calls `rehydratePiece` which reads from the archive URI
 *     (or swarm) and emits INS on verify.
 */

import type { SyncProjection, PieceProjection } from './projection';
import { pieceStatus } from './projection';
import type { EoEvent, LoggableOperator } from '../db/types';
import type {
  ArchiveScheme,
  CacheDefOperand,
  CacheEvaOperand,
  PieceRecArchivedOperand,
  SwarmSigOperand,
} from './operators';
import { DEFAULT_CACHE_DEF } from './operators';
import { cacheSite, swarmSite } from './sites';
import { stableDerivedId } from './derived';

// ─── Usage measurement ───────────────────────────────────────────────────

export interface UsageMeasurement {
  usage_mb: number;
  quota_mb: number | null;
  /** Pieces whose bytes are held in this device's local log right now. */
  resident_pieces: number;
  /** Pieces whose bytes have been archived off this device. */
  archived_pieces: number;
}

/**
 * Measure current OPFS+IDB+etc. usage via `navigator.storage.estimate()`.
 * Returns null on platforms that don't expose the API. The caller combines
 * this with `countResidencyFromProjection` to build a full measurement.
 */
export async function measureStorageBytes(): Promise<{ usage_bytes: number; quota_bytes: number | null } | null> {
  const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const est = await storage.estimate();
    if (!est || typeof est.usage !== 'number') return null;
    return {
      usage_bytes: est.usage,
      quota_bytes: typeof est.quota === 'number' ? est.quota : null,
    };
  } catch {
    return null;
  }
}

/** Derive per-piece residency counts from the projection. */
export function countResidencyFromProjection(proj: SyncProjection): { resident_pieces: number; archived_pieces: number } {
  let resident = 0;
  let archived = 0;
  for (const p of proj.pieces.values()) {
    if (p.archive && !p.instantiatedHash) archived += 1;
    if (p.instantiatedHash) resident += 1;
  }
  return { resident_pieces: resident, archived_pieces: archived };
}

const BYTES_PER_MB = 1024 * 1024;

export function bytesToMb(bytes: number): number {
  return bytes / BYTES_PER_MB;
}

// ─── Selection (pure) ────────────────────────────────────────────────────

export interface SelectionInput {
  projection: SyncProjection;
  def: CacheDefOperand;
  usage_mb: number;
  /** Per-piece last-access timestamp (epoch ms). Entries older than
   *  `hot_window_ms` become archival candidates. Absent = never-accessed. */
  lastAccessMsByPieceSite: Map<string, number>;
  nowMs: number;
  /**
   * Estimate of how many bytes each piece holds locally. If absent for a
   * piece, selection falls back to a default per-piece estimate so the loop
   * still makes forward progress without perfect accounting.
   */
  pieceSizeBytesBySite: Map<string, number>;
  /** Default piece size in bytes when `pieceSizeBytesBySite` lacks an entry. */
  defaultPieceSizeBytes: number;
}

export interface SelectedPiece {
  piece: PieceProjection;
  size_bytes: number;
  content_hash: string;
}

/**
 * Rank eligible pieces coldest-first and return enough of them to bring
 * projected usage below `low_watermark_mb`. The predicate for eligibility:
 *
 *   - status ∈ {'instantiated', 'swarm_attested'} (bytes are local, safe
 *     to demote; archived pieces already satisfy the target)
 *   - NOT unrecoverable (nothing to archive)
 *   - swarm-attestation contributor count >= def.min_attestation
 *   - last access is older than def.hot_window_ms (cold)
 *   - has a defined content hash to archive under
 */
export function selectForArchival(input: SelectionInput): SelectedPiece[] {
  const { projection, def, usage_mb, lastAccessMsByPieceSite, nowMs, pieceSizeBytesBySite, defaultPieceSizeBytes } = input;
  if (!def.enabled) return [];
  if (usage_mb <= def.high_watermark_mb) return [];

  const targetMb = def.low_watermark_mb;
  const candidates: { piece: PieceProjection; size_bytes: number; content_hash: string; lastAccessMs: number }[] = [];

  for (const piece of projection.pieces.values()) {
    if (piece.unrecoverable) continue;
    if (piece.archive && !piece.instantiatedHash) continue; // already archived
    const status = pieceStatus(piece);
    if (status !== 'instantiated' && status !== 'swarm_attested') continue;

    // Attestation floor: require N independent verifying deliveries on this
    // hash. If swarm_attested is set, it already crossed DEFAULT_SYN_THRESHOLD;
    // otherwise count verifying deliveries directly.
    const attestation = countVerifyingDeliveries(piece);
    if (attestation < def.min_attestation) continue;

    const content_hash =
      piece.authorHash ?? piece.swarmAttestedHash ?? piece.definedHash ?? piece.instantiatedHash;
    if (!content_hash) continue;

    const lastAccessMs = lastAccessMsByPieceSite.get(piece.piece_site) ?? 0;
    if (nowMs - lastAccessMs < def.hot_window_ms) continue; // still hot

    const size_bytes = pieceSizeBytesBySite.get(piece.piece_site) ?? defaultPieceSizeBytes;
    candidates.push({ piece, size_bytes, content_hash, lastAccessMs });
  }

  // Coldest-first. Ties broken by piece_site for determinism.
  candidates.sort((a, b) => {
    if (a.lastAccessMs !== b.lastAccessMs) return a.lastAccessMs - b.lastAccessMs;
    if (a.piece.piece_site < b.piece.piece_site) return -1;
    if (a.piece.piece_site > b.piece.piece_site) return 1;
    return 0;
  });

  const selected: SelectedPiece[] = [];
  let projected_mb = usage_mb;
  for (const c of candidates) {
    if (projected_mb <= targetMb) break;
    selected.push({ piece: c.piece, size_bytes: c.size_bytes, content_hash: c.content_hash });
    projected_mb -= bytesToMb(c.size_bytes);
  }
  return selected;
}

function countVerifyingDeliveries(piece: PieceProjection): number {
  if (piece.swarmAttestedHash) return Math.max(1, piece.deliveries.size);
  let n = 0;
  for (const d of piece.deliveries.values()) {
    if (d.verified) n += 1;
  }
  return n;
}

// ─── Pipeline ────────────────────────────────────────────────────────────

export interface ArchiveBackend {
  scheme: ArchiveScheme;
  /**
   * Upload bytes for a piece. Must succeed deterministically: returns a
   * stable URI that addresses these bytes and can be fetched later.
   * Implementations are expected to verify integrity by hash before
   * returning. On failure, throw — the archiver will leave the piece
   * resident.
   */
  uploadPiece(args: {
    piece_site: string;
    content_hash: string;
    bytes: Uint8Array;
  }): Promise<{ archive_uri: string; size_bytes: number }>;
}

export interface ArchiverIO {
  /** Read the piece's current local bytes. Must return null if the bytes are
   *  not actually held locally (in which case archival is skipped). */
  readPieceBytes(piece_site: string, content_hash: string): Promise<Uint8Array | null>;
  /** Delete the piece's local bytes. Called ONLY after a successful upload
   *  and after the REC/SIG events have been durably appended to the log. */
  dropPieceBytes(piece_site: string, content_hash: string): Promise<void>;
  /** Append events to the EO log. */
  appendEvents(events: EoEvent[]): Promise<void>;
  /** Current wall time, injected for determinism in tests. */
  nowIso(): string;
}

export interface ArchiverKnobs {
  /** Matrix deviceId/userId pair formatted for event.agent. */
  systemAgent: string;
  /** This device's id — names the cache site to address. */
  myDeviceId: string;
  /** Matrix roomId whose swarm this archive participates in. Used as the
   *  target for the SIG event. */
  roomId: string;
  /** User-site string (peer_site) this device is addressed as in the swarm —
   *  used as `advertised_by` on the SIG. For URI-backed advertisements we
   *  prefix the scheme so the scheduler can route differently; see
   *  `formatUriAdvertiser`. */
  myPeerSite: string;
  /** Maximum number of pieces archived in one tick. Keeps tick latency
   *  bounded even when usage is far over the high watermark. */
  maxArchivesPerTick: number;
}

export const DEFAULT_ARCHIVER_KNOBS: Omit<ArchiverKnobs, 'systemAgent' | 'myDeviceId' | 'roomId' | 'myPeerSite'> = {
  maxArchivesPerTick: 16,
};

/**
 * The archiver tick. Idempotent: re-running with the same inputs produces
 * the same selection, and event `client_event_id`s are stable so the log
 * will not accrete duplicates.
 *
 * Flow (per selected piece):
 *
 *   1. Read local bytes (abort if absent — projection and log out of sync).
 *   2. Upload to the archive backend. On failure, skip this piece.
 *   3. Append three events to the log atomically:
 *      - SIG on swarm:<room> advertising the archive URI as a source
 *      - REC on piece:* recognized=locally_archived with the URI
 *      - EVA on cache:<deviceId> recording the new usage estimate
 *   4. Drop local bytes.
 *
 * Step 4 after step 3 is intentional: if step 3 fails, we keep the bytes.
 * If step 4 fails, we have a harmless duplicate archive (bytes in URI +
 * bytes locally) that the next tick will reconcile.
 */
export async function runArchiverTick(args: {
  projection: SyncProjection;
  selection: SelectedPiece[];
  usage_mb: number;
  quota_mb: number | null;
  io: ArchiverIO;
  backend: ArchiveBackend;
  knobs: ArchiverKnobs;
}): Promise<{ archived: number; skipped: number; errors: Error[] }> {
  const { projection, selection, usage_mb, quota_mb, io, backend, knobs } = args;

  let archived = 0;
  let skipped = 0;
  const errors: Error[] = [];
  const cap = Math.max(0, Math.min(selection.length, DEFAULT_ARCHIVER_KNOBS.maxArchivesPerTick));

  let currentUsageBytes = usage_mb * BYTES_PER_MB;

  for (let i = 0; i < cap; i++) {
    const sel = selection[i];
    try {
      const bytes = await io.readPieceBytes(sel.piece.piece_site, sel.content_hash);
      if (!bytes) {
        skipped += 1;
        continue;
      }
      const up = await backend.uploadPiece({
        piece_site: sel.piece.piece_site,
        content_hash: sel.content_hash,
        bytes,
      });
      const archivedAt = io.nowIso();
      const events = buildArchiveEvents({
        piece_site: sel.piece.piece_site,
        author_device_id: sel.piece.author_device_id,
        piece_index: sel.piece.piece_index,
        content_hash: sel.content_hash,
        size_bytes: up.size_bytes,
        archive_uri: up.archive_uri,
        scheme: backend.scheme,
        archived_at: archivedAt,
        knobs,
      });
      await io.appendEvents(events);
      await io.dropPieceBytes(sel.piece.piece_site, sel.content_hash);
      currentUsageBytes = Math.max(0, currentUsageBytes - up.size_bytes);
      archived += 1;
    } catch (e) {
      skipped += 1;
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }

  // Emit an EVA on cache:<deviceId> summarizing the post-tick state, so the
  // UI sees fresh numbers without needing a separate probe.
  if (archived > 0) {
    const residency = countResidencyFromProjection(projection);
    const evaOperand: CacheEvaOperand = {
      predicate: 'usage_measurement',
      usage_mb: bytesToMb(currentUsageBytes),
      quota_mb,
      // The projection handed in is pre-tick; the archived count will catch
      // up on the next fold cycle. Reflect the delta here for immediacy.
      resident_pieces: Math.max(0, residency.resident_pieces - archived),
      archived_pieces: residency.archived_pieces + archived,
    };
    const evaEvent = buildCacheEvaEvent(knobs, evaOperand, io.nowIso());
    try {
      await io.appendEvents([evaEvent]);
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }

  return { archived, skipped, errors };
}

// ─── Event construction ──────────────────────────────────────────────────

/**
 * URI-as-advertiser format. The scheduler reads `advertised_by` as a
 * peer_site; for URI advertisers we use a reserved prefix
 * `uri:<scheme>:<uri>` that `parsePeerSite` rejects, so the scheduler's
 * normal peer lookup falls through to URI-aware handling (wired separately
 * in transport).
 */
export function formatUriAdvertiser(scheme: ArchiveScheme, uri: string): string {
  return `uri:${scheme}:${uri}`;
}

export interface BuildArchiveEventsArgs {
  piece_site: string;
  author_device_id: string;
  piece_index: number;
  content_hash: string;
  size_bytes: number;
  archive_uri: string;
  scheme: ArchiveScheme;
  archived_at: string;
  knobs: ArchiverKnobs;
}

export function buildArchiveEvents(args: BuildArchiveEventsArgs): EoEvent[] {
  const sigOperand: SwarmSigOperand = {
    author_device_id: args.author_device_id,
    piece_index: args.piece_index,
    expected_hash: args.content_hash,
    advertised_by: formatUriAdvertiser(args.scheme, args.archive_uri),
  };
  const sigEvent = buildEvent(
    'SIG',
    swarmSite(args.knobs.roomId),
    sigOperand as unknown as Record<string, unknown>,
    ['archive_sig', args.piece_site, args.content_hash, args.archive_uri],
    args.knobs,
    args.archived_at,
  );

  const recOperand: PieceRecArchivedOperand = {
    recognized: 'locally_archived',
    archive_uri: args.archive_uri,
    archive_scheme: args.scheme,
    content_hash: args.content_hash,
    archived_at: args.archived_at,
    size_bytes: args.size_bytes,
  };
  const recEvent = buildEvent(
    'REC',
    args.piece_site,
    recOperand as unknown as Record<string, unknown>,
    ['archive_rec', args.piece_site, args.content_hash, args.archive_uri],
    args.knobs,
    args.archived_at,
  );

  return [sigEvent, recEvent];
}

function buildCacheEvaEvent(knobs: ArchiverKnobs, operand: CacheEvaOperand, now: string): EoEvent {
  return buildEvent(
    'EVA',
    cacheSite(knobs.myDeviceId),
    operand as unknown as Record<string, unknown>,
    ['cache_eva', knobs.myDeviceId, String(Math.round(operand.usage_mb))],
    knobs,
    now,
  );
}

function buildEvent(
  op: LoggableOperator,
  target: string,
  operand: Record<string, unknown>,
  derivationInputs: string[],
  knobs: ArchiverKnobs,
  now: string,
): EoEvent {
  return {
    seq: -1,
    op,
    target,
    operand,
    agent: knobs.systemAgent,
    ts: now,
    acquired_ts: now,
    level: 2,
    client_event_id: stableDerivedId(op, target, derivationInputs),
    meta: { derived: true, archiver: true, derivation_inputs: derivationInputs.slice() },
  };
}

// ─── DEF helpers used by the UI ──────────────────────────────────────────

/** Build the DEF event the UI dispatches when the toggle/slider changes. */
export function buildCacheDefEvent(args: {
  systemAgent: string;
  myDeviceId: string;
  patch: Partial<CacheDefOperand>;
  nowIso: string;
}): EoEvent {
  const operand: Partial<CacheDefOperand> = { ...args.patch };
  const target = cacheSite(args.myDeviceId);
  // Unlike the derived archiver events, DEF events are human-authored —
  // their client_event_id is a fresh random-ish id so back-to-back edits
  // each land as distinct versions of the retention schema.
  const client_event_id =
    'cache_def:' + args.myDeviceId + ':' + Math.round(Date.parse(args.nowIso)).toString(36);
  return {
    seq: -1,
    op: 'DEF',
    target,
    operand: operand as Record<string, unknown>,
    agent: args.systemAgent,
    ts: args.nowIso,
    acquired_ts: args.nowIso,
    level: 1,
    client_event_id,
    meta: { cache_policy: true },
  };
}

/** Resolve the retention schema for a device, merging any cache-site DEF on
 *  top of the defaults. Use from the UI (to seed controls) and from the
 *  archiver (to pick up policy updates on the next tick). */
export function resolveCacheDef(projection: SyncProjection, deviceId: string): CacheDefOperand {
  const c = projection.caches.get(deviceId);
  if (!c) return { ...DEFAULT_CACHE_DEF };
  return { ...c.def };
}

// ─── Rehydrate ───────────────────────────────────────────────────────────

export interface RehydrateIO {
  /** Fetch bytes from the given archive URI. Must verify the content hash
   *  before returning. Throws on mismatch or unavailability. */
  fetchArchive(args: { archive_uri: string; scheme: ArchiveScheme; content_hash: string }): Promise<Uint8Array>;
  /** Write bytes into the local log so the piece becomes instantiated again. */
  writePieceBytes(piece_site: string, content_hash: string, bytes: Uint8Array): Promise<void>;
  appendEvents(events: EoEvent[]): Promise<void>;
  nowIso(): string;
}

/**
 * Bring an archived piece back into local residency. Looks at the piece's
 * projection state, fetches from the archive URI, verifies, writes bytes,
 * and emits an INS on the piece site (which clears the `archive` marker in
 * the projection — see applyPieceEvent INS branch).
 *
 * Callers should only invoke this when they actually need the bytes; it is
 * not automatic. The scheduler does not rehydrate archived pieces because
 * archive is a local policy decision, not a swarm demand.
 */
export async function rehydratePiece(args: {
  projection: SyncProjection;
  piece_site: string;
  io: RehydrateIO;
  knobs: Pick<ArchiverKnobs, 'systemAgent' | 'myPeerSite'>;
}): Promise<{ ok: boolean; reason?: string }> {
  const piece = args.projection.pieces.get(args.piece_site);
  if (!piece) return { ok: false, reason: 'unknown_piece' };
  if (piece.instantiatedHash) return { ok: true }; // already resident
  if (!piece.archive) return { ok: false, reason: 'no_archive' };

  const { archive_uri, scheme, content_hash } = piece.archive;
  const bytes = await args.io.fetchArchive({ archive_uri, scheme, content_hash });
  await args.io.writePieceBytes(args.piece_site, content_hash, bytes);
  const now = args.io.nowIso();
  const insEvent: EoEvent = {
    seq: -1,
    op: 'INS',
    target: args.piece_site,
    operand: {
      content_hash,
      verified_at: now,
      delivered_by: args.knobs.myPeerSite,
    },
    agent: args.knobs.systemAgent,
    ts: now,
    acquired_ts: now,
    level: 2,
    client_event_id: stableDerivedId('INS', args.piece_site, ['rehydrate', content_hash, archive_uri]),
    meta: { derived: true, rehydrated_from: scheme, rehydrate_uri: archive_uri },
  };
  await args.io.appendEvents([insEvent]);
  return { ok: true };
}
