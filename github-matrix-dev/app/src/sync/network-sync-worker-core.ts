/**
 * Pure logic for the EO-native sync worker.
 *
 * Extracted out of the Web Worker entry so it can be driven directly from
 * tests (no `worker_threads` shim, no Workerized bundler). The Web Worker
 * file is a thin wrapper: it forwards `postMessage` into
 * `NetworkSyncWorkerCore.handle()` and posts the returned commands back.
 *
 * ── Operator story this module encodes ──
 *
 *   ⊢DEF (piece) — emitted when the projection is in a state where a
 *     piece's hash can be stabilized (author SEG, N independent verifying
 *     deliveries, or single verified delivery with no conflicts).
 *     Classification: "this togetherness is this kind of thing."
 *
 *   ⊨EVA (peer) — emitted after the worker hash-verifies inbound bulk
 *     bytes. `predicate: 'satisfies_claimed_hash', result: bool` records
 *     the model-theoretic satisfaction check: "does this configuration
 *     count as that type?"
 *
 *   ↬REC (peer, piece) — emitted to restructure eligibility when a peer
 *     delivered bytes that did not satisfy the hash claim, or to
 *     recognize that a piece is `unrecoverable_pending_author`. REC is
 *     NOT iteration. It is the operator by which the system's encounter
 *     with its own data forces a rewrite of its own categories.
 *
 * The worker's state outside the projection is kept minimal:
 *   - `inFlight`: short-lived outbound request bookkeeping (cleared on
 *     response/timeout). The spec calls this the only acceptable mutable
 *     worker state beyond the projection.
 *   - `emittedDerivedIds`: dedupes derived-event emits across ticks.
 *   - `pendingServeReads` / `dcState`: bookkeeping for serving side.
 *
 * Everything else (piece table, bitfield, blacklist) is queried off the
 * projection.
 */

import type { EoEvent, LoggableOperator } from '../db/types';
import {
  applyEvent,
  emptyProjection,
  pieceStatus,
  type SyncProjection,
} from './projection';
import {
  computeDerivedEvents,
  stableDerivedId,
  DEFAULT_SYN_THRESHOLD,
  DEFAULT_REPUTATION_THRESHOLD,
  type DerivedKnobs,
} from './derived';
import {
  schedule,
  DEFAULT_KNOBS,
  type SchedulerInput,
  type SchedulerIntent,
  type SchedulerKnobs,
} from './scheduler';
import { parsePeerSite } from './sites';
import type {
  ControlMessage,
  BulkMessage,
  StartInit,
  WorkerCommand,
  WorkerInbound,
  PeerId,
  PieceSiteStr,
} from './network-sync-protocol';

// ─── Configuration ──────────────────────────────────────────────────────

export interface NetworkSyncCoreConfig {
  synThreshold: number;
  reputationThreshold: number;
  systemAgent: string;
  schedulerKnobs: SchedulerKnobs;
  /**
   * How long a verified delivery failure blacklists a peer for a piece.
   */
  blacklistDurationMs: number;
  /**
   * Per-peer serving token bucket — capacity (burst) and refill per ms.
   */
  servingCapacity: number;
  servingRefillPerMs: number;
}

export const DEFAULT_CORE_CONFIG: NetworkSyncCoreConfig = {
  synThreshold: DEFAULT_SYN_THRESHOLD,
  reputationThreshold: DEFAULT_REPUTATION_THRESHOLD,
  systemAgent: 'system:network-sync',
  schedulerKnobs: DEFAULT_KNOBS,
  blacklistDurationMs: 10 * 60 * 1000,
  servingCapacity: DEFAULT_KNOBS.seedTokenBucketBurst,
  servingRefillPerMs: DEFAULT_KNOBS.seedTokenBucketRefillPerSec / 1000,
};

// ─── Internal state ─────────────────────────────────────────────────────

interface InFlightEntry {
  peers: Set<PeerId>;
  /** Latest epoch ms the piece was dispatched at. */
  dispatched_at: number;
  /** Per-peer expected timeout (ms since epoch). */
  deadlines: Map<PeerId, number>;
  expected_hash: string;
}

interface PendingServeRead {
  peer: PeerId;
  piece_site: PieceSiteStr;
  expected_hash: string;
  req_id: string;
}

interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

export interface NetworkSyncCoreSnapshot {
  projection: SyncProjection;
  inFlightCount: number;
  emittedDerivedCount: number;
  dcOpenPeers: PeerId[];
}

// ─── Core class ─────────────────────────────────────────────────────────

export class NetworkSyncWorkerCore {
  private readonly config: NetworkSyncCoreConfig;
  private projection: SyncProjection = emptyProjection();
  /** piece_site → in-flight request bookkeeping. */
  private readonly inFlight = new Map<PieceSiteStr, InFlightEntry>();
  /** reqId → pending serve-side disk read. */
  private readonly pendingServeReads = new Map<string, PendingServeRead>();
  /** Dedup set for derived-event emits; keyed by the stable client_event_id. */
  private readonly emittedDerivedIds = new Set<string>();
  /** Dedup set for worker-originated peer/piece EVA/REC/CON emits. */
  private readonly emittedWorkerIds = new Set<string>();
  /** Per-peer DC state (open/closed/error). */
  private readonly dcState = new Map<PeerId, 'open' | 'closed' | 'error'>();
  /** Per-peer serving token bucket. */
  private readonly buckets = new Map<PeerId, TokenBucket>();
  private seed = 0;
  private myDeviceId = '';
  private myUserId = '';
  private roomId = '';
  private started = false;

  constructor(config: Partial<NetworkSyncCoreConfig> = {}) {
    this.config = { ...DEFAULT_CORE_CONFIG, ...config };
  }

  /** Top-level dispatch: consume one inbound message, return commands. */
  handle(inbound: WorkerInbound): WorkerCommand[] {
    switch (inbound.kind) {
      case 'start':
        return this.onStart(inbound.init);
      case 'stop':
        return this.onStop();
      case 'folded_event':
        return this.onFoldedEvent(inbound.event, inbound.nowMs);
      case 'inbound_control':
        return this.onInboundControl(inbound.msg, inbound.fromPeer, inbound.nowMs);
      case 'inbound_bulk':
        return this.onInboundBulk(inbound.msg, inbound.fromPeer, inbound.nowMs);
      case 'peer_join':
        return this.onPeerJoin(inbound.peer, inbound.nowMs);
      case 'peer_leave':
        return this.onPeerLeave(inbound.peer, inbound.nowMs);
      case 'dc_state':
        return this.onDcState(inbound.peer, inbound.state, inbound.nowMs);
      case 'piece_events_response':
        return this.onPieceEventsResponse(inbound.reqId, inbound.events, inbound.nowMs);
      case 'tick':
        return this.tick(inbound.nowMs);
    }
  }

  snapshot(): NetworkSyncCoreSnapshot {
    return {
      projection: this.projection,
      inFlightCount: this.inFlight.size,
      emittedDerivedCount: this.emittedDerivedIds.size,
      dcOpenPeers: [...this.dcState.entries()]
        .filter(([, s]) => s === 'open')
        .map(([p]) => p),
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  private onStart(init: StartInit): WorkerCommand[] {
    if (this.started) return [];
    this.started = true;
    this.roomId = init.roomId;
    this.myDeviceId = init.myDeviceId;
    this.myUserId = init.myUserId;
    this.seed = init.seed;
    for (const event of init.seedEvents) {
      this.projection = applyEvent(this.projection, event);
    }
    return this.tick(init.nowMs);
  }

  private onStop(): WorkerCommand[] {
    if (!this.started) return [];
    this.started = false;
    const peers = [...this.dcState.keys()];
    this.dcState.clear();
    this.inFlight.clear();
    this.pendingServeReads.clear();
    return peers.map<WorkerCommand>((peer) => ({ kind: 'close_dc', peer }));
  }

  // ─── Main loop ───────────────────────────────────────────────────────

  private tick(nowMs: number): WorkerCommand[] {
    if (!this.started) return [];
    this.expireInFlight(nowMs);

    const commands: WorkerCommand[] = [];

    // ⊢DEF / SYN / ↬REC — derive new events from the current projection.
    const derived = this.deriveEvents(nowMs);
    for (const event of derived) commands.push({ kind: 'emit_eo_event', event });

    // Scheduler decides which peers to request pieces from.
    const intents = this.runSchedule(nowMs);
    for (const intent of intents) {
      const cmd = this.intentToCommand(intent, nowMs);
      if (cmd) commands.push(cmd);
    }
    return commands;
  }

  private runSchedule(nowMs: number): SchedulerIntent[] {
    const inFlightPeers = new Map<PieceSiteStr, Set<PeerId>>();
    for (const [site, entry] of this.inFlight) inFlightPeers.set(site, new Set(entry.peers));
    const input: SchedulerInput = {
      projection: this.projection,
      inFlight: inFlightPeers,
      myDeviceId: this.myDeviceId,
      nowMs,
      knobs: this.config.schedulerKnobs,
      seed: this.seed,
    };
    return schedule(input);
  }

  private intentToCommand(intent: SchedulerIntent, nowMs: number): WorkerCommand | null {
    switch (intent.kind) {
      case 'request_piece': {
        const req_id = this.allocReqId('req', intent.piece_site, intent.peer, nowMs);
        this.trackInFlight(intent.piece_site, intent.peer, intent.expected_hash, nowMs + intent.timeoutMs);
        const msg: ControlMessage = {
          kind: 'request_piece_bytes',
          req_id,
          piece_site: intent.piece_site,
          expected_hash: intent.expected_hash,
        };
        return { kind: 'send_control', peer: intent.peer, msg };
      }
      case 'escalate_to_author': {
        // Escalation is addressed to the author's first observed peer-site.
        const authorPeer = this.findPeerByDevice(intent.author_device_id);
        if (!authorPeer) return null;
        const req_id = this.allocReqId('esc', intent.piece_site, authorPeer, nowMs);
        this.trackInFlight(intent.piece_site, authorPeer, intent.expected_hash, nowMs + intent.timeoutMs);
        const msg: ControlMessage = {
          kind: 'request_piece_bytes',
          req_id,
          piece_site: intent.piece_site,
          expected_hash: intent.expected_hash,
        };
        return { kind: 'send_control', peer: authorPeer, msg };
      }
    }
  }

  private deriveEvents(nowMs: number): EoEvent[] {
    const reachableAuthors = new Set<string>();
    for (const member of this.projection.swarm.members.values()) {
      if (member.coupling === 'departed') continue;
      const parsed = parsePeerSite(member.peer);
      if (parsed) reachableAuthors.add(parsed.deviceId);
    }
    const knobs: DerivedKnobs = {
      synThreshold: this.config.synThreshold,
      reputationThreshold: this.config.reputationThreshold,
      now: new Date(nowMs).toISOString(),
      systemAgent: this.config.systemAgent,
      reachableAuthors,
    };
    const derived = computeDerivedEvents(this.projection, knobs);
    const fresh: EoEvent[] = [];
    for (const event of derived) {
      const id = event.client_event_id;
      if (!id || this.emittedDerivedIds.has(id)) continue;
      this.emittedDerivedIds.add(id);
      fresh.push(this.tagOriginMeta(event));
    }
    return fresh;
  }

  // ─── Event ingestion ──────────────────────────────────────────────────

  private onFoldedEvent(event: EoEvent, nowMs: number): WorkerCommand[] {
    this.projection = applyEvent(this.projection, event);
    // Successful piece INS from our own fold: clear any in-flight entry.
    if (event.op === 'INS' && event.target.startsWith('piece:')) {
      this.inFlight.delete(event.target);
    }
    // Derived event already folded — make sure we don't re-emit it.
    if (event.client_event_id && event.meta && (event.meta as { derived?: unknown }).derived === true) {
      this.emittedDerivedIds.add(event.client_event_id);
    }
    return this.tick(nowMs);
  }

  private onInboundControl(msg: ControlMessage, fromPeer: PeerId, nowMs: number): WorkerCommand[] {
    switch (msg.kind) {
      case 'request_piece_bytes':
        return this.handleServeRequest(msg, fromPeer, nowMs);
      case 'request_tail_events':
        // Tail serving is out of scope for Phase 4 — no-op.
        return [];
      case 'cancel':
        // Cancel the outbound side if it matches a pending serve read.
        for (const [rid, pending] of this.pendingServeReads) {
          if (pending.req_id === msg.req_id) this.pendingServeReads.delete(rid);
        }
        return [];
    }
  }

  private handleServeRequest(
    msg: Extract<ControlMessage, { kind: 'request_piece_bytes' }>,
    fromPeer: PeerId,
    nowMs: number,
  ): WorkerCommand[] {
    if (!this.checkAndConsumeToken(fromPeer, nowMs)) {
      // Rate-limited — silently drop. The client can retry after backoff.
      return [];
    }
    const reqId = this.allocReqId('srv', msg.piece_site, fromPeer, nowMs);
    this.pendingServeReads.set(reqId, {
      peer: fromPeer,
      piece_site: msg.piece_site,
      expected_hash: msg.expected_hash,
      req_id: msg.req_id,
    });
    return [{ kind: 'read_piece_events', reqId, pieceSite: msg.piece_site }];
  }

  private onInboundBulk(msg: BulkMessage, fromPeer: PeerId, nowMs: number): WorkerCommand[] {
    if (msg.kind !== 'piece_bytes') return [];
    const entry = this.inFlight.get(msg.piece_site);
    // Still accept bytes even if no in-flight record (e.g., race with timeout).
    const expectedHash = entry?.expected_hash ?? msg.content_hash;
    const commands: WorkerCommand[] = [];

    // ⊨EVA — hash check. (Actual byte-level verify is performed upstream
    // by the bridge before this method is called — see the Phase 4 spec:
    // "Verify hash via verifyPieceBytes"; the bridge re-emits this bulk
    // event with a synthetic `content_hash: '__INVALID__'` sentinel to
    // signal a failed verification.)
    const verified = expectedHash === msg.content_hash && msg.content_hash !== '__INVALID__';

    // CON(peer) — record the structural delivery attempt on the peer site.
    commands.push({
      kind: 'emit_eo_event',
      event: this.buildWorkerEvent({
        op: 'CON',
        target: fromPeer,
        operand: {
          joined: msg.piece_site,
          coupling: verified ? 'delivered_verified' : 'delivered_failed',
          expected_hash: expectedHash,
          observed_hash: msg.content_hash,
        },
        idInputs: ['peer_con', fromPeer, msg.piece_site, msg.content_hash, verified ? '1' : '0'],
        nowMs,
      }),
    });

    // EVA(peer) — model-theoretic satisfaction check.
    commands.push({
      kind: 'emit_eo_event',
      event: this.buildWorkerEvent({
        op: 'EVA',
        target: fromPeer,
        operand: {
          predicate: 'satisfies_claimed_hash',
          result: verified,
          evidence: {
            piece_site: msg.piece_site,
            expected_hash: expectedHash,
            observed_hash: msg.content_hash,
          },
        },
        idInputs: ['peer_eva', fromPeer, msg.piece_site, msg.content_hash, verified ? '1' : '0'],
        nowMs,
      }),
    });

    if (!verified) {
      // ↬REC(peer) — rewrite the peer's eligibility category for this
      // piece. The evaluation revealed data the prior definition
      // (peer `eligible`) did not anticipate; we restructure the
      // category to `blacklisted_until_<ts>`.
      const until = nowMs + this.config.blacklistDurationMs;
      commands.push({
        kind: 'emit_eo_event',
        event: this.buildWorkerEvent({
          op: 'REC',
          target: fromPeer,
          operand: {
            restructured_field: `eligibility_for[${msg.piece_site}]`,
            from: 'eligible',
            to: `blacklisted_until_${until}`,
            until,
            reason: 'verify_failed',
          },
          idInputs: ['peer_rec_blacklist', fromPeer, msg.piece_site, String(until)],
          nowMs,
        }),
      });
      // Record failed delivery in local in-flight tracking.
      if (entry) {
        entry.peers.delete(fromPeer);
        entry.deadlines.delete(fromPeer);
        if (entry.peers.size === 0) this.inFlight.delete(msg.piece_site);
      }
      // Re-run scheduler to pick another peer.
      commands.push(...this.tick(nowMs));
    } else {
      // Verified — scheduler retires the piece once the main thread's
      // fold feeds back the resulting INS via `folded_event`. We clear
      // this peer from the in-flight entry so a stalled sibling request
      // doesn't keep the slot.
      if (entry) {
        entry.peers.delete(fromPeer);
        entry.deadlines.delete(fromPeer);
        if (entry.peers.size === 0) this.inFlight.delete(msg.piece_site);
      }
    }
    return commands;
  }

  private onPeerJoin(peer: PeerId, nowMs: number): WorkerCommand[] {
    void nowMs;
    const parsed = parsePeerSite(peer);
    if (!parsed) return [];
    // Opening a DC is a hint — the bridge may defer it if the peer isn't
    // RTC-capable. Idempotent: we only emit once.
    if (this.dcState.get(peer) === 'open') return [];
    return [{ kind: 'open_dc', peer }];
  }

  private onPeerLeave(peer: PeerId, nowMs: number): WorkerCommand[] {
    void nowMs;
    this.dcState.delete(peer);
    return [{ kind: 'close_dc', peer }];
  }

  private onDcState(peer: PeerId, state: 'open' | 'closed' | 'error', nowMs: number): WorkerCommand[] {
    this.dcState.set(peer, state);
    if (state !== 'open') return [];
    return this.tick(nowMs);
  }

  private onPieceEventsResponse(
    reqId: string,
    events: unknown[] | null,
    nowMs: number,
  ): WorkerCommand[] {
    const pending = this.pendingServeReads.get(reqId);
    if (!pending) return [];
    this.pendingServeReads.delete(reqId);
    if (!events || events.length === 0) return [];

    // Canonical msgpack + hash must happen on the main thread (the worker
    // hands back a sentinel content_hash that the bridge replaces with
    // the true hash after canonical encoding). The worker chooses the
    // transport here.
    const preferTransport: 'rtc' | 'matrix' =
      this.dcState.get(pending.peer) === 'open' ? 'rtc' : 'matrix';

    const msg: BulkMessage = {
      kind: 'piece_bytes',
      req_id: pending.req_id,
      piece_site: pending.piece_site,
      content_hash: pending.expected_hash,
      // Bridge fills in canonical bytes from the events array; we stage
      // a zero-length placeholder here. The bridge's `send_bulk` handler
      // owns serialization + hash re-verification before transmission.
      events_msgpack: encodeEventsForWorker(events),
    };
    return [{ kind: 'send_bulk', peer: pending.peer, msg, preferTransport }];
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private trackInFlight(
    piece_site: PieceSiteStr,
    peer: PeerId,
    expected_hash: string,
    deadlineMs: number,
  ): void {
    const entry = this.inFlight.get(piece_site) ?? {
      peers: new Set<PeerId>(),
      dispatched_at: deadlineMs,
      deadlines: new Map<PeerId, number>(),
      expected_hash,
    };
    entry.peers.add(peer);
    entry.deadlines.set(peer, deadlineMs);
    entry.dispatched_at = Math.max(entry.dispatched_at, deadlineMs);
    entry.expected_hash = expected_hash;
    this.inFlight.set(piece_site, entry);
  }

  private expireInFlight(nowMs: number): void {
    for (const [piece_site, entry] of [...this.inFlight.entries()]) {
      for (const [peer, deadline] of [...entry.deadlines.entries()]) {
        if (deadline <= nowMs) {
          entry.peers.delete(peer);
          entry.deadlines.delete(peer);
        }
      }
      if (entry.peers.size === 0) this.inFlight.delete(piece_site);
    }
  }

  private findPeerByDevice(deviceId: string): PeerId | null {
    for (const member of this.projection.swarm.members.values()) {
      const parsed = parsePeerSite(member.peer);
      if (parsed?.deviceId === deviceId) return member.peer;
    }
    return null;
  }

  private checkAndConsumeToken(peer: PeerId, nowMs: number): boolean {
    const bucket = this.buckets.get(peer) ?? {
      tokens: this.config.servingCapacity,
      lastRefillMs: nowMs,
    };
    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(
      this.config.servingCapacity,
      bucket.tokens + elapsed * this.config.servingRefillPerMs,
    );
    bucket.lastRefillMs = nowMs;
    if (bucket.tokens < 1) {
      this.buckets.set(peer, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(peer, bucket);
    return true;
  }

  private allocReqId(prefix: string, site: string, peer: string, nowMs: number): string {
    return `${prefix}:${stableDerivedId(prefix, site, [peer, String(nowMs)])}`;
  }

  private buildWorkerEvent(args: {
    op: LoggableOperator;
    target: string;
    operand: Record<string, unknown>;
    idInputs: string[];
    nowMs: number;
  }): EoEvent {
    const client_event_id = stableDerivedId(args.op, args.target, args.idInputs);
    const iso = new Date(args.nowMs).toISOString();
    const event: EoEvent = {
      seq: -1,
      op: args.op,
      target: args.target,
      operand: args.operand,
      agent:
        this.myUserId && this.myDeviceId
          ? `${this.myUserId}|${this.myDeviceId}`
          : this.config.systemAgent,
      ts: iso,
      acquired_ts: iso,
      level: 2,
      client_event_id,
      meta: {
        derived: true,
        origin_device_id: this.myDeviceId || undefined,
        origin_user_id: this.myUserId || undefined,
      },
    };
    // Dedupe worker-originated emits for the same (op, target, inputs).
    if (this.emittedWorkerIds.has(client_event_id)) {
      // Mark as duplicate so caller can filter (simplest: return a flag
      // via meta.__duplicate; upstream filter drops it).
      (event.meta as Record<string, unknown>).__duplicate = true;
    } else {
      this.emittedWorkerIds.add(client_event_id);
    }
    return event;
  }

  private tagOriginMeta(event: EoEvent): EoEvent {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    if (!meta.origin_device_id && this.myDeviceId) meta.origin_device_id = this.myDeviceId;
    if (!meta.origin_user_id && this.myUserId) meta.origin_user_id = this.myUserId;
    return { ...event, meta };
  }
}

// ─── Helpers for test / wrapper code ────────────────────────────────────

/**
 * Placeholder encoder used by the worker when it hands a pre-read event
 * list off to the bridge. The bridge re-encodes with canonical msgpack
 * before hashing, so the bytes here are informational only.
 */
function encodeEventsForWorker(events: unknown[]): Uint8Array {
  // Deliberately minimal — the bridge owns canonical encoding.
  void events;
  return new Uint8Array(0);
}

/** Filter duplicate worker-built events out of a command batch. */
export function dropDuplicateEmits(commands: WorkerCommand[]): WorkerCommand[] {
  const out: WorkerCommand[] = [];
  for (const cmd of commands) {
    if (cmd.kind !== 'emit_eo_event') {
      out.push(cmd);
      continue;
    }
    const meta = cmd.event.meta as { __duplicate?: unknown } | undefined;
    if (meta?.__duplicate) continue;
    out.push(cmd);
  }
  return out;
}

/** Test-only: pseudo-check that emitted event is well-formed. */
export function pieceInProgress(
  projection: SyncProjection,
  piece_site: PieceSiteStr,
): boolean {
  const piece = projection.pieces.get(piece_site);
  if (!piece) return false;
  const s = pieceStatus(piece);
  return s !== 'instantiated' && s !== 'swarm_attested';
}
