/**
 * Block-chain hydration — replaces the snapshot-chain walk.
 *
 * Four phases:
 *   1. Read `m.eo.head` state event.
 *   2. Walk the block chain backwards (`prior_block_event_id`) to gather
 *      every block-message-event in the chain.
 *   3. Download + decrypt every block in parallel; parse the `.eodb`.
 *   4. Apply events to the fold engine in chain order, then walk the room
 *      timeline forward from `tail_cutoff_event_id` and apply tail events.
 *
 * Failure modes are fatal: a missing block on `mxc://` or a hash mismatch
 * surfaces to the caller. There is no fallback storage.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import {
  EO_EVENT_TYPE,
  EO_BLOCK_TYPE,
  EO_BLOCK_DISABLED_STATE_TYPE,
  EO_HEAD_STATE_TYPE,
  downloadEncryptedAttachment,
  matrixEventToEo,
} from '../matrix/event-bridge';
import { EodbStreamReader, FRAME_TYPES } from '../db/eodb';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput, EoEvent } from '../db/types';
import { processEvent } from '../db/fold';
import { readHeadState, type BlockMessage } from './block-sealer';
import { fetchBlockFromDriveMirror, type BlockDriveMirrorDeps } from './block-drive-mirror';

// ─── Block event fetch ─────────────────────────────────────────────────

/**
 * Fetch a block message event by id. Prefers the live-timeline cache when
 * available; falls back to {@link MatrixClient.fetchRoomEvent} so older
 * blocks that have aged out of the local timeline are still reachable.
 *
 * Returns the parsed content (`BlockMessage`) plus the event id so callers
 * can recurse via `prior_block_event_id`.
 */
async function fetchBlockMessage(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<BlockMessage> {
  const room = client.getRoom(roomId);
  const local = room?.findEventById?.(eventId) as MatrixEvent | undefined;
  if (local) {
    const content = local.getContent() as Partial<BlockMessage>;
    if (content.file && typeof content.block_index === 'number') {
      return content as BlockMessage;
    }
  }

  // Slow path: HTTP fetch. The SDK decrypts Megolm transparently on read
  // so the returned content has the cleartext block metadata.
  const raw: any = await (client as any).fetchRoomEvent?.(roomId, eventId);
  if (!raw) {
    throw new Error(`Block event ${eventId} not found in room ${roomId}`);
  }
  const content = (raw.content ?? raw) as Partial<BlockMessage>;
  if (!content.file || typeof content.block_index !== 'number') {
    throw new Error(`Event ${eventId} is not a well-formed m.eo.block (missing file/index)`);
  }
  return content as BlockMessage;
}

/**
 * Walk the chain backwards from the latest block. Returns the chain in
 * chronological order (genesis first, head last).
 *
 * If `stopAtBlockEventId` is set, the walk halts as soon as it reaches
 * that event (exclusive — the stop block is treated as already-known and
 * not included in the returned chain). Used by incremental hydration to
 * fetch only the blocks added since the last successful hydrate.
 */
export async function walkBlockChain(
  client: MatrixClient,
  roomId: string,
  latestBlockEventId: string,
  stopAtBlockEventId: string | null = null,
): Promise<Array<{ eventId: string; content: BlockMessage }>> {
  const chain: Array<{ eventId: string; content: BlockMessage }> = [];
  let cursor: string | null = latestBlockEventId;
  const seen = new Set<string>();

  while (cursor) {
    if (cursor === stopAtBlockEventId) break;
    if (seen.has(cursor)) {
      throw new Error(`Block chain cycle detected at ${cursor}`);
    }
    seen.add(cursor);

    const block = await fetchBlockMessage(client, roomId, cursor);
    chain.push({ eventId: cursor, content: block });
    cursor = block.prior_block_event_id;
  }

  chain.reverse();
  return chain;
}

// ─── Block payload reading ─────────────────────────────────────────────

/**
 * Decode an `.eodb` block payload into the event list it carries.
 * Reads only the LOG_SEGMENT frames; other frame types are skipped
 * (forward-compatible).
 */
export async function readBlockEvents(payload: Uint8Array): Promise<EoEvent[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(payload); c.close(); },
  });
  const reader = new EodbStreamReader(stream);
  await reader.readHeader();

  const events: EoEvent[] = [];
  let frame = await reader.readNextFrame();
  while (frame) {
    if (frame.type === FRAME_TYPES.LOG_SEGMENT) {
      const { unpack } = await import('msgpackr');
      const segEvents = unpack(frame.payload) as EoEvent[];
      events.push(...segEvents);
    } else if (frame.type === FRAME_TYPES.TRAILER || frame.type === FRAME_TYPES.EOF) {
      break;
    }
    frame = await reader.readNextFrame();
  }
  return events;
}

// ─── Schema dispatch ───────────────────────────────────────────────────

/**
 * Apply a block's events to the store. Currently every schema version
 * dispatches to the same fold path — the switch is here so future
 * schema bumps (e.g. operand-shape changes) can branch without touching
 * the surrounding hydration code.
/**
 * Chunk size for the yielding-fallback loop. Sized so each chunk takes a
 * few ms at worst-case event cost; between chunks we yield to the macro-
 * task queue so user input + render don't starve. Used when no
 * `bulkApply` hook is wired (tests, brand-new caller).
 */
const FOLD_YIELD_CHUNK = 250;

/**
 * Fold `events` through `processEvent` while yielding to the event loop
 * every `FOLD_YIELD_CHUNK` events. Only called when `bulkApply` is not
 * available — the wired UI path goes through `useEoStore.batchImport`
 * which is worker-pooled and inherently chunked. This fallback is here
 * so tests and ad-hoc callers don't pin the main thread on large inputs.
 */
async function foldWithYield(
  store: EoStore,
  events: EoEventInput[],
  onEvent?: (ev: EoEvent) => void,
): Promise<void> {
  for (let i = 0; i < events.length; i++) {
    await processEvent(store, events[i], onEvent);
    if ((i + 1) % FOLD_YIELD_CHUNK === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
}

/**
 * Apply a block's events to the store. Currently every schema version
 * dispatches to the same fold path — the switch is here so future schema
 * bumps (e.g. operand-shape changes) can branch without touching the
 * surrounding hydration code.
 *
 * When `bulkApply` is supplied, events go through it in one call
 * (chunked, worker-pooled, yield-aware — see `useEoStore.batchImport`).
 * Without it we fall back to {@link foldWithYield}, which yields between
 * chunks so the main thread stays responsive even on the fallback path.
 */
async function applyBlockEvents(
  store: EoStore,
  events: EoEventInput[],
  schemaVersion: string,
  onEvent?: (ev: EoEvent) => void,
  bulkApply?: (events: EoEventInput[]) => Promise<unknown>,
): Promise<void> {
  switch (schemaVersion) {
    case 'eo-2026-04':
    default:
      if (events.length === 0) return;
      if (bulkApply) {
        await bulkApply(events);
        return;
      }
      await foldWithYield(store, events, onEvent);
      return;
  }
}

// ─── Tail walk ─────────────────────────────────────────────────────────

/**
 * Walk the room timeline forward from `cutoffEventId` and fold every EO
 * event found. If `cutoffEventId` is null, the entire timeline is folded
 * (room has no sealed blocks yet).
 *
 * When `bulkApply` is supplied, the tail events are bundled and handed
 * to the chunked, worker-pooled fold path in a single call — same hook
 * used by {@link applyBlockEvents}. Without it the fallback yields
 * between chunks so a long tail doesn't pin the main thread.
 */
async function applyTail(
  client: MatrixClient,
  roomId: string,
  cutoffEventId: string | null,
  store: EoStore,
  onEvent?: (ev: EoEvent) => void,
  bulkApply?: (events: EoEventInput[]) => Promise<unknown>,
): Promise<number> {
  const room = client.getRoom(roomId);
  if (!room) return 0;

  const timeline = room.getLiveTimeline().getEvents();
  const tail: EoEventInput[] = [];
  let passedCutoff = cutoffEventId === null;

  for (const ev of timeline) {
    if (!passedCutoff) {
      if (ev.getId() === cutoffEventId) passedCutoff = true;
      continue;
    }
    if (ev.getType() !== EO_EVENT_TYPE) continue;
    tail.push(matrixEventToEo(ev));
  }
  if (tail.length === 0) return 0;

  if (bulkApply) {
    await bulkApply(tail);
  } else {
    await foldWithYield(store, tail, onEvent);
  }
  return tail.length;
}

// ─── Top-level entry point ─────────────────────────────────────────────

export interface HydrationProgress {
  phase: 'head' | 'chain' | 'download' | 'apply' | 'tail' | 'done';
  blockCount?: number;
  eventCount?: number;
  tailEventCount?: number;
}

export interface HydrationResult {
  blockCount: number;
  blockEventCount: number;
  tailEventCount: number;
  /** The chain head this hydrate covered, or null if the chain is empty. */
  latestBlockEventId: string | null;
}

export interface HydrationOptions {
  /**
   * Halt the chain walk when this block event id is reached. Used by
   * incremental hydration to skip blocks already folded on a prior run.
   */
  stopAtBlockEventId?: string | null;
  /**
   * Optional bulk-apply hook for the fold phase. When provided, block
   * events go through it in one call per block — wire to
   * `useEoStore.getState().batchImport` so the chunked, worker-pooled,
   * yield-aware fold path is used. Without it, hydration falls back to
   * a per-event `processEvent` loop that pins the main thread on large
   * blocks (~ tens of seconds for an 80k-event chain).
   */
  bulkApply?: (events: EoEventInput[]) => Promise<unknown>;
  /**
   * When supplied, block downloads try the canonical `mxc://` first and
   * fall back to the Drive mirror only if the Matrix download throws.
   * Same deps the sealer uses to write the mirror — pass `null`/omit to
   * stick with mxc-only.
   */
  mirror?: BlockDriveMirrorDeps | null;
}

/**
 * Fetch a block's plaintext `.eodb` bytes. Tries the canonical Matrix
 * media path first (`downloadEncryptedAttachment`); on failure, falls
 * back to the Drive mirror keyed by the same mxc URI. Re-throws the
 * original Matrix error if both fail (the mirror is a recovery cache,
 * not a primary).
 */
async function fetchBlockBytes(
  client: MatrixClient,
  file: BlockMessage['file'],
  mirror: BlockDriveMirrorDeps | null | undefined,
): Promise<Uint8Array> {
  try {
    return await downloadEncryptedAttachment(client, file);
  } catch (matrixErr) {
    if (!mirror) throw matrixErr;
    try {
      const fromMirror = await fetchBlockFromDriveMirror(mirror, file.url);
      if (fromMirror) return fromMirror;
    } catch (mirrorErr) {
      console.warn('[EO-DB] block Drive mirror read failed:', mirrorErr);
    }
    throw matrixErr;
  }
}

/**
 * Hydrate the local store from the block chain + tail.
 *
 * No-ops cleanly if the room has no `m.eo.head` yet: phase 1 returns an
 * empty head, phases 2–4 short-circuit, phase 5 still walks the entire
 * timeline (which for a brand-new room is empty / very small).
 */
export async function hydrateFromBlocks(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  onEvent?: (ev: EoEvent) => void,
  onProgress?: (p: HydrationProgress) => void,
  opts: HydrationOptions = {},
): Promise<HydrationResult> {
  onProgress?.({ phase: 'head' });
  const head = readHeadState(client, roomId);

  if (!head.latest_block_event_id) {
    // Brand-new room: nothing sealed yet. Fold the entire timeline.
    onProgress?.({ phase: 'tail' });
    const tailApplied = await applyTail(client, roomId, null, store, onEvent, opts.bulkApply);
    onProgress?.({ phase: 'done', tailEventCount: tailApplied });
    return {
      blockCount: 0,
      blockEventCount: 0,
      tailEventCount: tailApplied,
      latestBlockEventId: null,
    };
  }

  // Phase 2: walk the chain (short-circuited by stopAtBlockEventId for
  // incremental hydration).
  onProgress?.({ phase: 'chain' });
  const fullChain = await walkBlockChain(
    client,
    roomId,
    head.latest_block_event_id,
    opts.stopAtBlockEventId ?? null,
  );

  // Filter out disabled blocks before download+fold. The chain pointers
  // (prior_block_event_id) stay intact server-side; we just skip
  // downloading the payload and folding the events for any block whose
  // m.eo.block.disabled state event is set.
  const disabled = readDisabledBlocks(client, roomId);
  const chain = disabled.size > 0
    ? fullChain.filter((b) => !disabled.has(b.eventId))
    : fullChain;

  // Phase 3: parallel download + decrypt + parse.
  onProgress?.({ phase: 'download', blockCount: chain.length });
  const decoded = await Promise.all(
    chain.map(async ({ content }) => {
      const bytes = await fetchBlockBytes(client, content.file, opts.mirror);
      const events = await readBlockEvents(bytes);
      return { schemaVersion: content.schema_version, events };
    }),
  );

  // Phase 4: apply in chain order.
  let totalBlockEvents = 0;
  onProgress?.({ phase: 'apply', blockCount: chain.length });
  for (const block of decoded) {
    await applyBlockEvents(
      store,
      block.events as EoEventInput[],
      block.schemaVersion,
      onEvent,
      opts.bulkApply,
    );
    totalBlockEvents += block.events.length;
  }

  // Phase 5: walk the tail forward from the cutoff.
  onProgress?.({ phase: 'tail' });
  const tailApplied = await applyTail(client, roomId, head.tail_cutoff_event_id, store, onEvent, opts.bulkApply);

  onProgress?.({
    phase: 'done',
    blockCount: chain.length,
    eventCount: totalBlockEvents,
    tailEventCount: tailApplied,
  });
  return {
    blockCount: chain.length,
    blockEventCount: totalBlockEvents,
    tailEventCount: tailApplied,
    latestBlockEventId: head.latest_block_event_id,
  };
}

// ─── Incremental, idempotent hydration entry point ─────────────────────

const HYDRATED_HEAD_LS_KEY_PREFIX = 'eo-db-hydrated-head:';

function readPersistedHydratedHead(roomId: string): string | null {
  try {
    return localStorage.getItem(HYDRATED_HEAD_LS_KEY_PREFIX + roomId);
  } catch {
    return null;
  }
}

/**
 * Public read accessor — same value `readPersistedHydratedHead` returns,
 * exported so the boot path can compare a kv-snapshot's `hydratedHead`
 * against the localStorage marker and reconcile any mismatch. (V9.)
 */
export function getPersistedHydratedHead(roomId: string): string | null {
  return readPersistedHydratedHead(roomId);
}

/**
 * Public write accessor — used by the boot path to backfill a missing
 * localStorage marker from a snapshot's `hydratedHead` field so the two
 * stores stay in sync. (V9.)
 */
export function setPersistedHydratedHead(roomId: string, blockEventId: string | null): void {
  writePersistedHydratedHead(roomId, blockEventId);
}

function writePersistedHydratedHead(roomId: string, blockEventId: string | null): void {
  try {
    if (blockEventId) {
      localStorage.setItem(HYDRATED_HEAD_LS_KEY_PREFIX + roomId, blockEventId);
    } else {
      localStorage.removeItem(HYDRATED_HEAD_LS_KEY_PREFIX + roomId);
    }
  } catch {
    // localStorage write failures are non-fatal — worst case we re-hydrate
    // unnecessarily on the next load (fold engine dedups by client_event_id).
  }
}

/**
 * Wipe every persisted hydration cursor in localStorage. Called on logout
 * so a new session can't inherit a "we already hydrated up to X" marker
 * from the prior account — without this, re-login with a populated OPFS
 * but a fresh chain head would silently skip blocks.
 */
export function clearAllHydratedHeadMarkers(): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(HYDRATED_HEAD_LS_KEY_PREFIX)) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
  } catch {
    // ignore — same rationale as writePersistedHydratedHead
  }
}

/**
 * Run block-chain hydration only when the chain has advanced beyond
 * what's already been folded locally.
 *
 * Reads `m.eo.head.latest_block_event_id` and compares against a
 * locally-persisted "last successfully hydrated head" (in
 * `localStorage`, keyed per room). If they match, hydration is a no-op.
 * Otherwise, it runs {@link hydrateFromBlocks} stopping at the
 * already-hydrated boundary so only the new blocks are downloaded and
 * folded. The fold engine dedups by `client_event_id`, so the
 * worst-case "stale localStorage but stale store" pair re-folds events
 * idempotently — never duplicates.
 *
 * Designed to be cheap on the refresh path: when the chain hasn't
 * moved, returns without touching the network.
 *
 * Returns `null` when nothing was done; otherwise the hydration result.
 */
export async function hydrateBlocksIfStale(
  client: MatrixClient,
  roomId: string,
  store: EoStore,
  opts: HydrationOptions & {
    onEvent?: (ev: EoEvent) => void;
    onProgress?: (p: HydrationProgress) => void;
    /**
     * Force a full re-walk back to genesis even when the persisted head
     * matches. Used after a "wipe + restore from chain" admin action.
     */
    force?: boolean;
  } = {},
): Promise<HydrationResult | null> {
  const head = readHeadState(client, roomId);
  const persistedHead = readPersistedHydratedHead(roomId);

  if (!head.latest_block_event_id) {
    // Empty chain — clear stale persisted head if any, then still let
    // hydrateFromBlocks walk the tail.
    if (persistedHead) writePersistedHydratedHead(roomId, null);
    const result = await hydrateFromBlocks(
      client,
      roomId,
      store,
      opts.onEvent,
      opts.onProgress,
      { bulkApply: opts.bulkApply, mirror: opts.mirror },
    );
    return result;
  }

  // Chain hasn't moved since the last successful hydrate — skip.
  if (!opts.force && persistedHead === head.latest_block_event_id) {
    return null;
  }

  const result = await hydrateFromBlocks(
    client,
    roomId,
    store,
    opts.onEvent,
    opts.onProgress,
    {
      bulkApply: opts.bulkApply,
      mirror: opts.mirror,
      // When force is set we re-walk to genesis. Otherwise stop where
      // we left off — the fold engine still dedups inside that range
      // via client_event_id, so a missed gap (e.g. localStorage cleared
      // mid-hydrate last time) is recovered by walking further back.
      stopAtBlockEventId: opts.force ? null : persistedHead,
    },
  );

  // Persist the new head only on success. Failure leaves the
  // localStorage value untouched so the next load re-attempts the same
  // gap rather than skipping it.
  writePersistedHydratedHead(roomId, result.latestBlockEventId);
  return result;
}

// ─── Block list + admin toggle ─────────────────────────────────────────

export interface BlockListEntry {
  eventId: string;
  blockIndex: number;
  eventCount: number;
  priorBlockEventId: string | null;
  sealedAt: string;
  sealedBy: { user_id: string; device_id: string };
  disabled: boolean;
  disabledReason?: string;
  disabledBy?: string;
}

/**
 * Read every `m.eo.block.disabled` state event in the room and return
 * the set of disabled block-event-ids (where `content.disabled === true`).
 * Cheap — pure local read against the SDK room state, no network.
 */
export function readDisabledBlocks(
  client: MatrixClient,
  roomId: string,
): Set<string> {
  const room = client.getRoom(roomId);
  if (!room) return new Set();
  const events = room.currentState.getStateEvents(EO_BLOCK_DISABLED_STATE_TYPE);
  const result = new Set<string>();
  for (const ev of events) {
    const stateKey = ev.getStateKey();
    if (!stateKey) continue;
    const content = ev.getContent() as { disabled?: boolean };
    if (content.disabled === true) result.add(stateKey);
  }
  return result;
}

/**
 * List every block in the room's chain (newest first), annotated with
 * its current disabled state. Used by the admin UI that shows uploaded
 * blocks and lets operators toggle them on/off.
 */
export async function listBlockChain(
  client: MatrixClient,
  roomId: string,
): Promise<BlockListEntry[]> {
  const head = readHeadState(client, roomId);
  if (!head.latest_block_event_id) return [];
  const chain = await walkBlockChain(client, roomId, head.latest_block_event_id);
  const disabled = readDisabledBlocks(client, roomId);
  const disabledMeta = readDisabledMeta(client, roomId);

  const entries: BlockListEntry[] = chain.map(({ eventId, content }) => {
    const meta = disabledMeta.get(eventId);
    return {
      eventId,
      blockIndex: content.block_index,
      eventCount: content.event_count,
      priorBlockEventId: content.prior_block_event_id,
      sealedAt: content.sealed_at,
      sealedBy: content.sealed_by,
      disabled: disabled.has(eventId),
      disabledReason: meta?.reason,
      disabledBy: meta?.setBy,
    };
  });

  // Newest first for UI ergonomics.
  entries.reverse();
  return entries;
}

function readDisabledMeta(
  client: MatrixClient,
  roomId: string,
): Map<string, { reason?: string; setBy?: string }> {
  const out = new Map<string, { reason?: string; setBy?: string }>();
  const room = client.getRoom(roomId);
  if (!room) return out;
  const events = room.currentState.getStateEvents(EO_BLOCK_DISABLED_STATE_TYPE);
  for (const ev of events) {
    const stateKey = ev.getStateKey();
    if (!stateKey) continue;
    const content = ev.getContent() as { reason?: string; set_by?: string };
    out.set(stateKey, { reason: content.reason, setBy: content.set_by });
  }
  return out;
}

/**
 * Toggle a block's disabled state. Sends a `m.eo.block.disabled` state
 * event keyed by the block's room-event id. Setting `disabled: false`
 * (or sending content `{}`) re-enables the block on the next hydrate.
 *
 * After this call returns, local state is stale relative to the new
 * disabled set — call `hydrateBlocksIfStale(..., { force: true })`
 * followed by a kv-snapshot refresh to actually apply the change.
 * The UI should prompt the user / trigger this re-fold explicitly.
 */
export async function setBlockDisabled(
  client: MatrixClient,
  roomId: string,
  blockEventId: string,
  disabled: boolean,
  reason?: string,
): Promise<void> {
  const userId = client.getUserId?.() ?? '@unknown:unknown';
  const content = disabled
    ? {
        disabled: true,
        reason: reason ?? '',
        set_by: userId,
        set_at: new Date().toISOString(),
      }
    : { disabled: false, set_by: userId, set_at: new Date().toISOString() };
  await client.sendStateEvent(
    roomId,
    EO_BLOCK_DISABLED_STATE_TYPE as any,
    content as any,
    blockEventId,
  );
}

// ─── Auto-ingest: live listener for chain updates ──────────────────────

const AUTO_INGEST_LS_KEY_PREFIX = 'eo-db-auto-ingest:';

/**
 * Read the per-room auto-ingest preference. Default true — new blocks
 * fold automatically as they're sealed by other clients unless the user
 * has explicitly turned it off in the Uploaded Blocks UI.
 */
export function isAutoIngestEnabled(roomId: string): boolean {
  try {
    const v = localStorage.getItem(AUTO_INGEST_LS_KEY_PREFIX + roomId);
    return v !== '0';
  } catch {
    return true;
  }
}

/** Persist the per-room auto-ingest preference. */
export function setAutoIngestEnabled(roomId: string, enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_INGEST_LS_KEY_PREFIX + roomId, enabled ? '1' : '0');
  } catch {
    // localStorage write failures are non-fatal — the preference reverts
    // to the default (enabled) on the next read.
  }
}

/**
 * Listen for chain advances on the room and fire `onHeadChange` whenever
 * `m.eo.head` updates or a new `m.eo.block` lands on the timeline. The
 * caller is responsible for the actual fold (typically
 * `hydrateBlocksIfStale`) and for honoring `isAutoIngestEnabled`.
 *
 * Returns a `cleanup` function — call it on space switch / unmount /
 * matrix-client disposal to remove the listeners.
 *
 * Coalesces back-to-back updates with a small debounce so a burst of
 * state events (e.g. a sync delivering both m.eo.block + m.eo.head in
 * the same response) triggers exactly one fold attempt.
 */
export function listenForChainUpdates(
  client: MatrixClient,
  roomId: string,
  onHeadChange: () => void,
  debounceMs: number = 500,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = () => {
    if (disposed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      try {
        onHeadChange();
      } catch (e) {
        console.warn('[block-hydration] auto-ingest handler threw:', e);
      }
    }, debounceMs);
  };

  const onStateEvent = (event: MatrixEvent) => {
    if (event.getRoomId() !== roomId) return;
    const type = event.getType();
    if (type !== EO_HEAD_STATE_TYPE && type !== EO_BLOCK_DISABLED_STATE_TYPE) return;
    schedule();
  };

  const onTimeline = (event: MatrixEvent) => {
    if (event.getRoomId() !== roomId) return;
    if (event.getType() !== EO_BLOCK_TYPE) return;
    schedule();
  };

  client.on('RoomState.events' as any, onStateEvent);
  client.on('Room.timeline' as any, onTimeline);

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    client.off('RoomState.events' as any, onStateEvent);
    client.off('Room.timeline' as any, onTimeline);
  };
}
