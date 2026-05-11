/**
 * Layer 4A — Main-thread query API and Worker client.
 *
 * Creates and manages the fold.worker.ts Worker. Provides the third-degree
 * query interface. This is what the rest of the app calls.
 *
 * The query language is the operator vocabulary:
 *   SEG  = WHERE (over transformation space)
 *   CON  = JOIN  (graph traversal)
 *   EVA  = WHERE-over-governance
 *   REC  = WHERE-over-system-behavior
 *
 * Multi-record data is ONLY accessible through query().resolve(). getField()
 * is the only single-record escape hatch. This enforces the third-degree
 * interface and closes the second-degree escape hatch.
 */

import type { EoEvent, LoggableOperator, RecMigrationRule } from './types';
import type { EvaRegistrationLive } from './fold-position';

// ─── Wire types ───────────────────────────────────────────────────────────────

export interface SerializedQuerySpec {
  prefix?: string;
  opFilters: LoggableOperator[];
  structuralFilters: Array<
    | { type: 'whereEva' }
    | { type: 'whereEvaUnresolved' }
    | { type: 'whereContested' }
    | { type: 'whereRec'; minTimes: number }
  >;
  graphTraversal?: {
    startTarget: string;
    op: 'CON' | 'SYN';
    depth: number;
    direction: 'fwd' | 'rev' | 'both';
  };
  historySpec?: {
    target: string;
    field?: string;
    metrics: Array<'defDepth' | 'agents' | 'supersessionRate'>;
  };
  withFields?: string[];
  limit?: number;
}

export interface FoldEntry {
  target: string;
  ops: LoggableOperator[];
  exists: boolean;
  evaRegistration?: EvaRegistrationLive;
  lastSeq: number;
}

export interface FoldResultSet {
  entries: FoldEntry[];
  count: number;
  values?: Map<string, Record<string, unknown>>;
}

/** Payload-only union (no id) — used internally by send(). */
export type FoldWorkerPayload =
  | { type: 'init'; spaceId: string }
  | { type: 'writeEvent'; event: EoEvent }
  | { type: 'writeSig'; target: string; field: string; value: unknown }
  | { type: 'writeEventsBulk'; events: EoEvent[] }
  | { type: 'getField'; target: string; field: string }
  | { type: 'resolveQuery'; spec: SerializedQuerySpec }
  | { type: 'applyMigration'; rules: RecMigrationRule[]; triggeredBy: number }
  /**
   * appendRaw — append an already-folded event to the OPFS log without
   * running EVA/REC evaluation. Used by the MemoryStore persistence hook
   * so that fold.ts (main-thread fold engine) drives the logic while
   * the worker handles durable storage.
   */
  | { type: 'appendRaw'; event: EoEvent }
  /**
   * scanLog — stream all events whose seq > `since` back to the main
   * thread for replay into a fresh MemoryStore on page load.
   */
  | { type: 'scanLog'; since: number }
  /**
   * saveKvSnapshot — serialize and write the MemoryStore kv map to
   * 'kv-snapshot.bin' in the space's OPFS directory for fast restore
   * on next page load. `recentTail` is the last ~2 000 events the UI
   * should show — persisted alongside the kv so refresh can skip the
   * per-init `readLogSince` scan of the in-memory store.
   */
  /**
   * `hydratedHead` is the block-chain event id the snapshot's kv map has
   * already folded up to (null = no block chain or pre-genesis). Same
   * value that `block-hydration.writePersistedHydratedHead` writes to
   * localStorage; keeping it in the snapshot makes the boundary marker
   * atomic with the kv map — a snapshot restore brings its own cursor
   * along, and a missing localStorage key no longer means "re-walk the
   * whole chain". (V9 of HELIX-AUDIT-2026-05-11.md.)
   */
  | { type: 'saveKvSnapshot'; entries: [string, unknown][]; recentTail: EoEvent[]; seq: number; hydratedHead?: string | null }
  /**
   * loadKvSnapshot — read 'kv-snapshot.bin' and return its entries,
   * or null if no snapshot exists.
   */
  | { type: 'loadKvSnapshot' }
  /**
   * saveInitCache — tell the worker to persist its own LogIndex + computed
   * cache snapshot to 'init-cache.bin'. The worker builds the payload from
   * its own state; no arguments needed.
   */
  | { type: 'saveInitCache' };

export type FoldWorkerRequest = FoldWorkerPayload & { id: number };

export type FoldWorkerResponse =
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; message: string }
  /**
   * `ready` is posted once after `init` completes. `headSeq` lets the main
   * thread compare it against the kv-snapshot seq and skip `scanLog`
   * entirely when the log hasn't advanced since the snapshot was written.
   * `fastPath` is true when the worker restored from its init-cache (i.e.
   * skipped `buildIndex`) — purely informational, for logging.
   */
  | { id: -1; type: 'ready'; headSeq: number; fastPath: boolean }
  | { id: -1; type: 'recOscillation'; target: string; cyclingStates: Record<string, unknown>[]; suggestedFix: RecMigrationRule[] }
  | { id: -1; type: 'eventEmitted'; event: EoEvent }
  | { id: -1; type: 'progress'; current: number; total: number }
  /**
   * Push-telemetry for the PressureMonitor (see src/perf/pressure-monitor.ts).
   * Emitted at init completion and intermittently from checkAdaptiveCheckpoint.
   */
  | { id: -1; type: 'telemetry'; avgMicrosPerEvent: number };

// ─── FoldWorkerClient ─────────────────────────────────────────────────────────

export interface FoldWorkerClient {
  worker: Worker;
  pendingRequests: Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>;
  nextId: number;
  /**
   * Latches to `true` once the underlying Worker has fired its `onerror`
   * (unrecoverable crash). All subsequent `send()` calls reject
   * immediately rather than postMessage'ing into a dead worker that
   * would never respond. The host should observe this via `onDied` and
   * either re-init the space (which creates a fresh client) or surface
   * an error to the user.
   */
  dead: boolean;
  onRecOscillation?: (ev: {
    target: string;
    cyclingStates: Record<string, unknown>[];
    suggestedFix: RecMigrationRule[];
  }) => void;
  onEventEmitted?: (ev: EoEvent) => void;
  onProgress?: (current: number, total: number) => void;
  onTelemetry?: (t: { avgMicrosPerEvent: number }) => void;
  /**
   * Fires when the underlying Worker dies. The host is expected to tear
   * down this client and either recreate it from scratch (re-run
   * `createFoldWorkerClient` + `initFoldWorker`) or report the failure.
   * Same event delivered to `worker.onerror`.
   */
  onDied?: (e: ErrorEvent) => void;
}

// ─── createFoldWorkerClient ───────────────────────────────────────────────────

export function createFoldWorkerClient(): FoldWorkerClient {
  const worker = new Worker(
    new URL('../workers/fold.worker.ts', import.meta.url),
    { type: 'module' },
  );

  const client: FoldWorkerClient = {
    worker,
    pendingRequests: new Map(),
    nextId: 1,
    dead: false,
  };

  worker.onmessage = (e: MessageEvent<FoldWorkerResponse>) => {
    const msg = e.data;
    if (msg.id === -1) {
      // Push notification
      switch (msg.type) {
        case 'ready':
          // handled by initFoldWorker's pending request
          break;
        case 'recOscillation':
          client.onRecOscillation?.({
            target: msg.target,
            cyclingStates: msg.cyclingStates,
            suggestedFix: msg.suggestedFix,
          });
          break;
        case 'eventEmitted':
          client.onEventEmitted?.(msg.event);
          break;
        case 'progress':
          client.onProgress?.(msg.current, msg.total);
          break;
        case 'telemetry':
          client.onTelemetry?.({ avgMicrosPerEvent: msg.avgMicrosPerEvent });
          break;
      }
      return;
    }

    const pending = client.pendingRequests.get(msg.id);
    if (!pending) return;
    client.pendingRequests.delete(msg.id);

    if (msg.type === 'error') {
      pending.reject(new Error(msg.message));
    } else {
      pending.resolve((msg as { id: number; type: 'result'; value: unknown }).value);
    }
  };

  worker.onerror = (e) => {
    // Latch dead so subsequent send() calls fail fast instead of posting
    // into a worker that will never respond.
    client.dead = true;
    // Reject all pending on unrecoverable Worker error
    for (const [, pending] of client.pendingRequests) {
      pending.reject(new Error(`Worker error: ${e.message}`));
    }
    client.pendingRequests.clear();
    // Notify the host so it can re-init (replaces this client) or
    // surface the failure. Synchronous — host doesn't get to await.
    try {
      client.onDied?.(e);
    } catch (cbErr) {
      console.warn('[EO-DB] fold-worker onDied handler threw:', cbErr);
    }
  };

  return client;
}

// ─── Low-level send ───────────────────────────────────────────────────────────

function send<T>(client: FoldWorkerClient, msg: FoldWorkerPayload): Promise<T> {
  if (client.dead) {
    return Promise.reject(
      new Error('Fold worker is dead — host must re-init before sending again'),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const id = client.nextId++;
    client.pendingRequests.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    client.worker.postMessage({ ...msg, id } as FoldWorkerRequest);
  });
}

// ─── initFoldWorker ───────────────────────────────────────────────────────────

/**
 * Initialize the Worker with a space ID. Resolves when the Worker posts
 * the `ready` push notification. The resolved value carries `headSeq` so the
 * caller can compare it against its kv-snapshot seq and skip delta replay
 * entirely when the log hasn't advanced since the snapshot was written.
 * `fastPath` indicates whether the worker restored from its init-cache.
 */
export function initFoldWorker(
  client: FoldWorkerClient,
  spaceId: string,
): Promise<{ headSeq: number; fastPath: boolean }> {
  return new Promise<{ headSeq: number; fastPath: boolean }>((resolve, reject) => {
    const id = client.nextId++;
    // Intercept the 'ready' push notification for this init call.
    const originalOnMessage = client.worker.onmessage;
    client.worker.onmessage = (e: MessageEvent<FoldWorkerResponse>) => {
      const msg = e.data;
      if (msg.id === -1 && msg.type === 'ready') {
        client.worker.onmessage = originalOnMessage;
        resolve({ headSeq: msg.headSeq, fastPath: msg.fastPath });
        return;
      }
      originalOnMessage?.call(client.worker, e);
    };
    client.pendingRequests.set(id, {
      resolve: () => { /* init ack handled above */ },
      reject,
    });
    client.worker.postMessage({ id, type: 'init', spaceId } satisfies FoldWorkerRequest);
  });
}

// ─── Write API ────────────────────────────────────────────────────────────────

export function writeEvent(
  client: FoldWorkerClient,
  event: EoEvent,
): Promise<{ seq: number; byteOffset: number }> {
  return send(client, { type: 'writeEvent', event });
}

export function writeSig(
  client: FoldWorkerClient,
  target: string,
  field: string,
  value: unknown,
): Promise<void> {
  return send(client, { type: 'writeSig', target, field, value });
}

export function writeEventsBulk(
  client: FoldWorkerClient,
  events: EoEvent[],
  onProgress?: (current: number, total: number) => void,
): Promise<number> {
  if (onProgress) client.onProgress = onProgress;
  return send(client, { type: 'writeEventsBulk', events });
}

export function applyMigration(
  client: FoldWorkerClient,
  rules: RecMigrationRule[],
  triggeredBy: number,
): Promise<void> {
  return send(client, { type: 'applyMigration', rules, triggeredBy });
}

/**
 * Append an already-folded event to the OPFS log without triggering
 * the worker's EVA/REC evaluation pass. The main-thread fold engine
 * (fold.ts + MemoryStore) drives logic; this call handles persistence only.
 */
export function appendRaw(
  client: FoldWorkerClient,
  event: EoEvent,
): Promise<void> {
  return send(client, { type: 'appendRaw', event });
}

/**
 * Return all events in the OPFS log whose seq > `since` (default 0),
 * in ascending seq order. Used on page load to replay into a fresh
 * MemoryStore.
 */
export function scanLog(
  client: FoldWorkerClient,
  since = 0,
): Promise<EoEvent[]> {
  return send<EoEvent[]>(client, { type: 'scanLog', since });
}

// ─── kv snapshot ─────────────────────────────────────────────────────────────

/**
 * Serialize the MemoryStore kv map to 'kv-snapshot.bin' in OPFS so the next
 * page load can restore state without replaying the full event log. The
 * `recentTail` array (last ~2 000 events) is persisted alongside so that the
 * main-thread init can skip re-scanning the in-memory store's log: entries.
 */
export function saveKvSnapshot(
  client: FoldWorkerClient,
  entries: [string, unknown][],
  recentTail: EoEvent[],
  seq: number,
  hydratedHead?: string | null,
): Promise<void> {
  return send(client, { type: 'saveKvSnapshot', entries, recentTail, seq, hydratedHead });
}

/**
 * Load a previously saved kv snapshot from OPFS. Returns null if no snapshot
 * exists yet (first load) or if the file is corrupt. `recentTail` is the last
 * ~2 000 events captured at save time — used directly as Zustand state on the
 * no-change refresh path. `hydratedHead`, when present, is the block-chain
 * event id the snapshot already covers; older snapshots without this field
 * return `undefined` so callers can fall back to the legacy localStorage
 * marker.
 */
export function loadKvSnapshot(
  client: FoldWorkerClient,
): Promise<{ entries: [string, unknown][]; recentTail: EoEvent[]; seq: number; hydratedHead?: string | null } | null> {
  return send<{ entries: [string, unknown][]; recentTail: EoEvent[]; seq: number; hydratedHead?: string | null } | null>(
    client,
    { type: 'loadKvSnapshot' },
  );
}

/**
 * Ask the worker to persist its LogIndex + computedCache snapshot to
 * 'init-cache.bin'. Fire-and-forget from the caller's perspective — the
 * worker uses its own state to build the payload. A subsequent worker init
 * that finds a matching `logByteSize` will skip `buildIndex()` entirely.
 */
export function saveInitCache(client: FoldWorkerClient): Promise<void> {
  return send(client, { type: 'saveInitCache' });
}

// ─── getField ─────────────────────────────────────────────────────────────────

export function getField(
  client: FoldWorkerClient,
  target: string,
  field: string,
): Promise<unknown> {
  return send(client, { type: 'getField', target, field });
}

// ─── FoldQueryBuilder ─────────────────────────────────────────────────────────

export class FoldQueryBuilder {
  private client: FoldWorkerClient;
  private spec: SerializedQuerySpec = { opFilters: [], structuralFilters: [] };

  constructor(client: FoldWorkerClient) {
    this.client = client;
  }

  within(prefix: string): this {
    this.spec.prefix = prefix;
    return this;
  }

  whereOp(op: LoggableOperator): this {
    this.spec.opFilters = [op];
    return this;
  }

  andOp(op: LoggableOperator): this {
    this.spec.opFilters.push(op);
    return this;
  }

  andNot(_predicate: (entry: FoldEntry) => boolean): this {
    // Predicates are serialised to the Worker as part of the spec.
    // For now, andNot is recorded as a structural filter with a placeholder;
    // runtime evaluation happens in resolveQuery via closures on the main thread
    // after the Worker returns the candidate set.
    // This is handled in resolve() below.
    this._andNotPredicates.push(_predicate);
    return this;
  }
  private _andNotPredicates: Array<(entry: FoldEntry) => boolean> = [];

  whereEva(): this {
    this.spec.structuralFilters.push({ type: 'whereEva' });
    return this;
  }

  whereEvaUnresolved(): this {
    this.spec.structuralFilters.push({ type: 'whereEvaUnresolved' });
    return this;
  }

  whereContested(): this {
    this.spec.structuralFilters.push({ type: 'whereContested' });
    return this;
  }

  whereRec(minTimes = 1): this {
    this.spec.structuralFilters.push({ type: 'whereRec', minTimes });
    return this;
  }

  withFields(fields: string[]): this {
    this.spec.withFields = fields;
    return this;
  }

  limit(n: number): this {
    this.spec.limit = n;
    return this;
  }

  graph(target: string): FoldGraphQuery {
    return new FoldGraphQuery(this.client, target);
  }

  history(target: string, field?: string): FoldHistoryQuery {
    return new FoldHistoryQuery(this.client, target, field);
  }

  branches(): FoldBranchQuery {
    return new FoldBranchQuery(this.client);
  }

  async resolve(): Promise<FoldResultSet> {
    const result = await send<FoldResultSet>(this.client, {
      type: 'resolveQuery',
      spec: this.spec,
    });

    // Apply andNot predicates on main thread (closures not serialisable)
    if (this._andNotPredicates.length > 0) {
      result.entries = result.entries.filter(
        entry => !this._andNotPredicates.some(pred => pred(entry)),
      );
      result.count = result.entries.length;
    }

    return result;
  }
}

// ─── query ────────────────────────────────────────────────────────────────────

export function query(client: FoldWorkerClient): FoldQueryBuilder {
  return new FoldQueryBuilder(client);
}

// ─── Sub-builders ─────────────────────────────────────────────────────────────

export interface FoldGraphResult {
  nodes: string[];
  edges: Array<{ source: string; dest: string }>;
}

export class FoldGraphQuery {
  private client: FoldWorkerClient;
  private startTarget: string;
  private traversalOp: 'CON' | 'SYN' = 'CON';
  private depth = 3;
  private direction: 'fwd' | 'rev' | 'both' = 'fwd';

  constructor(client: FoldWorkerClient, startTarget: string) {
    this.client = client;
    this.startTarget = startTarget;
  }

  traverse(op: 'CON' | 'SYN', opts: { depth?: number; direction?: 'fwd' | 'rev' | 'both' } = {}): this {
    this.traversalOp = op;
    this.depth = opts.depth ?? this.depth;
    this.direction = opts.direction ?? this.direction;
    return this;
  }

  async resolve(): Promise<FoldResultSet> {
    const spec: SerializedQuerySpec = {
      opFilters: [],
      structuralFilters: [],
      graphTraversal: {
        startTarget: this.startTarget,
        op: this.traversalOp,
        depth: this.depth,
        direction: this.direction,
      },
    };
    return send<FoldResultSet>(this.client, { type: 'resolveQuery', spec });
  }
}

export interface FoldHistoryResult {
  target: string;
  field?: string;
  defDepth?: number;
  agents?: string[];
  supersessionRate?: number;
}

export class FoldHistoryQuery {
  private client: FoldWorkerClient;
  private target: string;
  private field?: string;
  private metrics: Array<'defDepth' | 'agents' | 'supersessionRate'> = [];

  constructor(client: FoldWorkerClient, target: string, field?: string) {
    this.client = client;
    this.target = target;
    this.field = field;
  }

  defDepth(): this { this.metrics.push('defDepth'); return this; }
  agents(): this { this.metrics.push('agents'); return this; }
  supersessionRate(): this { this.metrics.push('supersessionRate'); return this; }

  async resolve(): Promise<FoldHistoryResult> {
    const spec: SerializedQuerySpec = {
      opFilters: [],
      structuralFilters: [],
      historySpec: { target: this.target, field: this.field, metrics: this.metrics },
    };
    return send<FoldHistoryResult>(this.client, { type: 'resolveQuery', spec });
  }
}

export interface FoldBranchResult {
  branches: string[];
}

export class FoldBranchQuery {
  private client: FoldWorkerClient;

  constructor(client: FoldWorkerClient) {
    this.client = client;
  }

  async resolve(): Promise<FoldBranchResult> {
    const spec: SerializedQuerySpec = { opFilters: [], structuralFilters: [] };
    return send<FoldBranchResult>(this.client, { type: 'resolveQuery', spec });
  }
}
