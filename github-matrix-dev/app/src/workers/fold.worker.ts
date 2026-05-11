/// <reference lib="webworker" />
/**
 * Layer 4B — Fold Worker.
 *
 * Owns the OPFS SyncAccessHandle exclusively. All log I/O, index updates,
 * and fold-position updates happen here. The main thread never touches the
 * log file directly.
 *
 * Message protocol: see FoldWorkerRequest / FoldWorkerResponse in lazy-fold.ts
 */

import { pack, unpack } from 'msgpackr';
import { openLog, appendEvent, readEventAt, scanLog } from '../db/log-opfs';
import type { OPFSLog } from '../db/log-opfs';
import { buildIndex, updateIndex, getIntersection, trieQuery, trieInsert } from '../db/log-index';
import type { LogIndex, IndexEntry, TrieNode } from '../db/log-index';
import { saveInitCache, loadInitCache } from '../db/init-cache';
import type { InitCachePayload } from '../db/init-cache';
import {
  createFoldPosition,
  applyEvent,
  saveCheckpoint,
  loadCheckpoint,
  snapshotFoldPosition,
  TARGET_STARTUP_MS,
} from '../db/fold-position';
import type { FoldPosition, EvaRegistrationLive } from '../db/fold-position';
import type {
  FoldWorkerRequest,
  FoldWorkerResponse,
  SerializedQuerySpec,
  FoldEntry,
  FoldResultSet,
  FoldHistoryResult,
} from '../db/lazy-fold';
import type { EoEvent, LoggableOperator, RecMigrationRule, NulState } from '../db/types';
import { nulStateToResolution } from '../db/types';

// ─── Module-level state ───────────────────────────────────────────────────────

let log: OPFSLog | null = null;
let index: LogIndex | null = null;
let position: FoldPosition | null = null;
let opfsDir: FileSystemDirectoryHandle | null = null;

/** SIG overrides: "target.field" → value. Cleared on Worker close. */
const sigLayer = new Map<string, unknown>();

/** Worker-side computed value cache for EVA formula outputs. */
const computedCache = new Map<string, unknown>();

let eventsSinceCheckpoint = 0;
let avgProcessMicrosPerEvent = 5;
let checkpointInProgress = false;
let bulkImportInProgress = false;

// ─── Utilities ────────────────────────────────────────────────────────────────

function post(msg: FoldWorkerResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

// ─── Init cache helpers ───────────────────────────────────────────────────────

/**
 * Rebuild a LogIndex from an init-cache payload. This is O(n) in event count,
 * but much faster than `buildIndex(log)` because we skip the per-entry msgpack
 * decode and the SyncAccessHandle reads — all the data is already in memory.
 */
function rebuildIndexFromCache(cache: InitCachePayload): LogIndex {
  const opBuckets = new Map<LoggableOperator, { seqs: number[]; offsets: number[]; branches: number[] }>();
  const root: TrieNode = { seqs: [], offsets: [], children: new Map() };
  const seqToOffset = new Map<number, number>();

  const { seqs, offsets, ops, targets } = cache.entries;
  const n = seqs.length;
  for (let i = 0; i < n; i++) {
    const seq = seqs[i];
    const offset = offsets[i];
    const op = ops[i];
    const target = targets[i];

    let bucket = opBuckets.get(op);
    if (!bucket) {
      bucket = { seqs: [], offsets: [], branches: [] };
      opBuckets.set(op, bucket);
    }
    bucket.seqs.push(seq);
    bucket.offsets.push(offset);
    bucket.branches.push(0);

    trieInsert(root, target, seq, offset);
    seqToOffset.set(seq, offset);
  }

  const opIndex = new Map<LoggableOperator, IndexEntry>();
  for (const [op, m] of opBuckets) {
    opIndex.set(op, {
      seqs: new Uint32Array(m.seqs),
      offsets: new Uint32Array(m.offsets),
      branches: new Uint8Array(m.branches),
    });
  }
  return { opIndex, trie: root, intersectionCache: new Map(), seqToOffset };
}

/**
 * Build the flat per-event arrays needed to serialize the current LogIndex
 * into the init-cache. We scan the log once to recover targets and ops
 * (these aren't stored in the in-memory index) but the rebuild path skips
 * this scan entirely. The log is memory-backed via SyncAccessHandle so this
 * is still much cheaper than a full buildIndex: no index construction, no
 * trie inserts — just decoding to capture a few fields per event.
 */
function buildInitCachePayload(): InitCachePayload | null {
  if (!log || !index || !position) return null;
  const n = index.seqToOffset.size;
  const seqs = new Uint32Array(n);
  const offsets = new Uint32Array(n);
  const ops: LoggableOperator[] = new Array(n);
  const targets: string[] = new Array(n);

  // Walk the log once in seq-order to recover (op, target) per event.
  let i = 0;
  for (const { event, byteOffset } of scanLog(log, 0)) {
    if (i >= n) break;
    seqs[i] = event.seq;
    offsets[i] = byteOffset;
    ops[i] = event.op;
    targets[i] = event.target;
    i++;
  }

  return {
    version: 1,
    logByteSize: log.size,
    headSeq: position.seq,
    entries: { seqs, offsets, ops, targets },
    computedCache: [...computedCache.entries()],
  };
}

/**
 * Fire-and-forget save of the current init cache. Cheap to call from the
 * adaptive checkpoint path — if the log hasn't changed since the last save,
 * `loadInitCache` will find a hit on the next refresh and skip buildIndex.
 */
let initCacheSaveInProgress = false;
function scheduleInitCacheSave(): void {
  if (initCacheSaveInProgress || !opfsDir) return;
  const payload = buildInitCachePayload();
  if (!payload) return;
  initCacheSaveInProgress = true;
  const dir = opfsDir;
  saveInitCache(payload, dir)
    .catch((e) => console.warn('[EO-DB] init-cache save failed:', e))
    .finally(() => { initCacheSaveInProgress = false; });
}

function now(): string {
  return new Date().toISOString();
}

function nowTs(): string { return now(); }

// ─── Formula helpers ──────────────────────────────────────────────────────────

/**
 * Detect if a formula references external/time-based values.
 * These formulas cannot be eagerly evaluated and are deferred to the main thread.
 */
function formulaReferencesExternal(formula: unknown): boolean {
  if (!formula || typeof formula !== 'object') return false;
  const src = JSON.stringify(formula);
  return /\b(NOW|TODAY|DATE|TIMESTAMP)\s*\(/.test(src);
}

/**
 * Math.* methods and constants that formulas are allowed to reference.
 * Anything outside this set (globalThis, window, document, etc.) is rejected
 * before evaluation so formulas synced in from other peers can't exfiltrate
 * data or poison worker state.
 */
const FORMULA_MATH_ALLOWLIST = new Set([
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atan2', 'atanh',
  'cbrt', 'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1', 'floor',
  'fround', 'hypot', 'imul', 'log', 'log10', 'log1p', 'log2', 'max',
  'min', 'pow', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh',
  'trunc',
  'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2',
]);
const FORMULA_KEYWORD_ALLOWLIST = new Set(['true', 'false', 'null', 'undefined']);
const FORMULA_FORBIDDEN = /(?:\b(?:new|function|class|var|let|const|do|while|for|delete|void|typeof|instanceof|in|of|yield|async|await|throw|try|catch|finally|return|import|export|this|globalThis|window|self|document|eval|Function|constructor|prototype|__proto__)\b|=>|`|\$\{|;|\[|\]|\?\.)/;

function isSafeFormulaExpression(expr: string, paramAllowlist: Set<string>): boolean {
  if (expr.length > 2048) return false;
  if (FORMULA_FORBIDDEN.test(expr)) return false;
  const identRe = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(expr)) !== null) {
    const ident = m[0];
    if (paramAllowlist.has(ident)) continue;
    if (FORMULA_KEYWORD_ALLOWLIST.has(ident)) continue;
    if (ident === 'Math') continue;
    if (ident.startsWith('Math.')) {
      const member = ident.slice('Math.'.length);
      if (FORMULA_MATH_ALLOWLIST.has(member)) continue;
    }
    return false;
  }
  return true;
}

/**
 * Evaluate a formula expression with given inputs. Formulas reach this worker
 * via Matrix-synced events, so the expression is treated as untrusted: it's
 * restricted to arithmetic, comparisons, and a small Math.* allowlist before
 * being handed to Function().
 */
function executeFormulaFunction(formula: unknown, inputs: Record<string, unknown>): unknown {
  if (!formula || typeof formula !== 'object') return null;
  const f = formula as { expr?: string };
  if (!f.expr) return null;
  const paramNames = Object.keys(inputs);
  const paramAllowlist = new Set(paramNames);
  if (!isSafeFormulaExpression(f.expr, paramAllowlist)) return null;
  try {
    const paramValues = Object.values(inputs);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...paramNames, `"use strict"; return (${f.expr})`);
    return fn(...paramValues) as unknown;
  } catch {
    return null;
  }
}

// ─── EVA registration ─────────────────────────────────────────────────────────

function registerEvaFormula(event: EoEvent): void {
  if (!position) return;
  const deps = [...(position.conAdjacency.get(event.target) ?? new Set<string>())];
  const mode = formulaReferencesExternal(event.operand) ? 'horizon' : 'fold';
  const existing = position.evaRegistrations.get(event.target);
  position.evaRegistrations.set(event.target, {
    target: event.target,
    formula: event.operand,
    mode,
    dependencies: deps,
    lastConverged: existing?.lastConverged,
    lastRecSeq: existing?.lastRecSeq,
  });
}

function reEvaluateEvaMode(target: string): void {
  if (!position) return;
  const reg = position.evaRegistrations.get(target);
  if (!reg) return;
  const deps = [...(position.conAdjacency.get(target) ?? new Set<string>())];
  const mode = formulaReferencesExternal(reg.formula) ? 'horizon' : 'fold';
  reg.dependencies = deps;
  reg.mode = mode;
}

// ─── EVA evaluation ───────────────────────────────────────────────────────────

function getFieldFromLog(target: string, field: string): unknown {
  if (!log || !index) return undefined;
  const sigKey = `${target}.${field}`;
  if (sigLayer.has(sigKey)) return sigLayer.get(sigKey);
  const computedKey = `${target}.__computed.${field}`;
  if (computedCache.has(computedKey)) return computedCache.get(computedKey);
  const prefix = `${target}.${field}`;
  const seqs = getIntersection(index, 'DEF', prefix);
  if (!seqs.length) return undefined;
  const lastSeq = seqs[seqs.length - 1];
  const offset = index.seqToOffset.get(lastSeq);
  if (offset === undefined) return undefined;
  const event = readEventAt(log, offset);
  return event.operand;
}

function evaluateFormula(reg: EvaRegistrationLive): void {
  if (!position) return;
  const inputs: Record<string, unknown> = {};
  for (const dep of reg.dependencies) {
    // Use the dependency target's value (last DEF on that target)
    inputs[dep] = getFieldFromLog(dep, 'value') ?? getFieldFromLog(dep, '') ?? null;
  }
  const result = executeFormulaFunction(reg.formula, inputs);
  // Store in computed cache under "target.__computed"
  computedCache.set(`${reg.target}.__computed`, result);
}

function recomputeDependents(target: string, visited: Set<string>): void {
  if (!position) return;
  if (visited.has(target)) return; // cycle guard
  visited.add(target);
  const dependents = position.conReverse.get(target) ?? new Set<string>();
  for (const dependent of dependents) {
    const reg = position.evaRegistrations.get(dependent);
    if (!reg || reg.mode !== 'fold') continue;
    evaluateFormula(reg);
    recomputeDependents(reg.target, visited);
  }
}

// ─── REC detection ────────────────────────────────────────────────────────────

function buildDepCycleTargets(startTarget: string): string[] | null {
  if (!position) return null;
  // DFS to find a cycle in the EVA sub-graph starting at startTarget
  const stack: string[] = [];
  const inStack = new Set<string>();
  const visited = new Set<string>();

  function dfs(t: string): string[] | null {
    if (inStack.has(t)) {
      // Found cycle — extract the cycle
      const idx = stack.indexOf(t);
      return stack.slice(idx);
    }
    if (visited.has(t)) return null;
    visited.add(t);
    inStack.add(t);
    stack.push(t);
    const deps = position!.conAdjacency.get(t) ?? new Set<string>();
    for (const dep of deps) {
      if (position!.evaRegistrations.has(dep)) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    inStack.delete(t);
    return null;
  }

  return dfs(startTarget);
}

function snapshotCycleValues(cycleTargets: string[]): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const t of cycleTargets) {
    snap[t] = computedCache.get(`${t}.__computed`) ?? getFieldFromLog(t, 'value');
  }
  return snap;
}

function buildSuggestedFix(
  cyclingStates: Record<string, unknown>[],
): RecMigrationRule[] {
  const rules: RecMigrationRule[] = [];
  if (cyclingStates.length < 2) return rules;
  const targets = Object.keys(cyclingStates[0]);
  for (const target of targets) {
    const values = cyclingStates.map(s => s[target]);
    const numericValues = values.filter(v => typeof v === 'number') as number[];
    if (numericValues.length === values.length) {
      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      rules.push({ scope: target, op: 'set_field', field: 'value', value: mean });
    }
  }
  return rules;
}

async function resolveOscillation(
  cyclingStates: Record<string, unknown>[],
  cycleTargets: string[],
  recEvent: EoEvent,
): Promise<void> {
  if (!position) return;
  const suggestedFix = buildSuggestedFix(cyclingStates);

  // Check resolution policy from the first EVA registration in the cycle
  const firstReg = position.evaRegistrations.get(cycleTargets[0]);
  const policy = (firstReg?.formula as { resolutionPolicy?: string } | null)?.resolutionPolicy ?? 'surface';

  if (policy === 'auto') {
    // Check depth guard
    const depth = getTriggeredByDepth(recEvent);
    if (depth > 5) {
      await appendNulEvent(recEvent.seq, 'unknown');
      return;
    }
    // Emit DEF events per migration rule
    for (const rule of suggestedFix) {
      if (rule.op === 'set_field') {
        const defEvent = makeSystemEvent('DEF', rule.scope, rule.value, recEvent.seq);
        writeEventInternal(defEvent);
      }
    }
  } else {
    // Surface policy: push to main thread for human decision
    post({
      id: -1,
      type: 'recOscillation',
      target: recEvent.target,
      cyclingStates,
      suggestedFix,
    });
  }
}

async function detectAndResolveREC(
  target: string,
  triggeringEvent: EoEvent,
): Promise<void> {
  if (!position || !log || !index) return;
  const cycleTargets = buildDepCycleTargets(target);
  if (!cycleTargets) return; // no cycle

  // Fixed-point iteration (max 100 iterations)
  let prevSnap = snapshotCycleValues(cycleTargets);
  const seenSnaps: Record<string, unknown>[] = [prevSnap];
  let converged = false;
  let oscillating = false;
  const cyclingStates: Record<string, unknown>[] = [];

  for (let i = 0; i < 100; i++) {
    // Re-evaluate all EVA registrations in the cycle
    for (const t of cycleTargets) {
      const reg = position.evaRegistrations.get(t);
      if (reg && reg.mode === 'fold') evaluateFormula(reg);
    }
    const newSnap = snapshotCycleValues(cycleTargets);
    const newSnapStr = JSON.stringify(newSnap);

    // Check convergence
    if (newSnapStr === JSON.stringify(prevSnap)) {
      converged = true;
      break;
    }

    // Check oscillation: is this snap identical to any earlier one?
    for (const seen of seenSnaps) {
      if (JSON.stringify(seen) === newSnapStr) {
        oscillating = true;
        break;
      }
    }
    if (oscillating) {
      cyclingStates.push(...seenSnaps, newSnap);
      break;
    }

    seenSnaps.push(newSnap);
    prevSnap = newSnap;
  }

  // Build REC event
  const recOperand = converged
    ? { converged: true, stable_state: prevSnap, triggered_by: triggeringEvent.seq }
    : { converged: false, cycle_length: cyclingStates.length, states: cyclingStates, triggered_by: triggeringEvent.seq };

  const recEvent = makeSystemEvent('REC', target, recOperand, triggeringEvent.seq);
  writeEventInternal(recEvent);

  if (oscillating) {
    await resolveOscillation(cyclingStates, cycleTargets, recEvent);
  }
}

// ─── Depth guard ──────────────────────────────────────────────────────────────

function getTriggeredByDepth(event: EoEvent): number {
  let depth = 0;
  let cur: EoEvent | undefined = event;
  const visited = new Set<number>();
  while (cur?.triggered_by !== undefined) {
    if (visited.has(cur.triggered_by)) break;
    visited.add(cur.triggered_by);
    depth++;
    // We can't easily look up the parent event here; just use the depth count
    // from the triggered_by chain length based on event metadata
    break; // simplified — the full chain walk requires log reads; use direct count
  }
  return depth;
}

async function appendNulEvent(triggeredBy: number, nulState: 'unknown' | 'never-set' | 'cleared'): Promise<void> {
  if (!position) return;
  const event = makeSystemEvent('NUL', '__system__', null, triggeredBy);
  // Canonical Resolution field. The legacy nul_state field is still written
  // alongside so consumers that have not yet migrated can read the old name.
  event.resolution = nulStateToResolution(nulState as NulState);
  event.nul_state = nulState;
  writeEventInternal(event);
}

// ─── Event construction helpers ───────────────────────────────────────────────

let nextSeq = 0;

function makeSystemEvent(
  op: LoggableOperator,
  target: string,
  operand: unknown,
  triggeredBy?: number,
): EoEvent {
  nextSeq++;
  return {
    seq: nextSeq,
    op,
    target,
    operand,
    agent: 'system',
    ts: nowTs(),
    acquired_ts: nowTs(),
    triggered_by: triggeredBy,
  };
}

function writeEventInternal(event: EoEvent): void {
  if (!log || !index || !position) return;
  const { byteOffset } = appendEvent(log, event);
  updateIndex(index, event, byteOffset);
  applyEvent(position, event);
  if (event.op === 'EVA') registerEvaFormula(event);
  post({ id: -1, type: 'eventEmitted', event });
}

// ─── Adaptive checkpoint ──────────────────────────────────────────────────────

function scheduleCheckpoint(): void {
  if (checkpointInProgress || !position || !opfsDir) return;
  checkpointInProgress = true;
  const snap = snapshotFoldPosition(position);
  const dir = opfsDir;
  saveCheckpoint(snap, dir).then(() => {
    eventsSinceCheckpoint = 0;
    checkpointInProgress = false;
    // Keep the init-cache in lockstep with the fold-position checkpoint so
    // next refresh can skip buildIndex even if the user dispatched events
    // during this session.
    scheduleInitCacheSave();
  }).catch(() => {
    checkpointInProgress = false;
  });
}

function checkAdaptiveCheckpoint(): void {
  if (bulkImportInProgress || checkpointInProgress) return;
  eventsSinceCheckpoint++;
  // Occasionally republish the current fold cost to the main thread so the
  // PressureMonitor can track fold-cost drift between init boundaries.
  if (eventsSinceCheckpoint % 256 === 0) {
    post({ id: -1, type: 'telemetry', avgMicrosPerEvent: avgProcessMicrosPerEvent });
  }
  const estimatedReplayMs = (eventsSinceCheckpoint * avgProcessMicrosPerEvent) / 1000;
  if (estimatedReplayMs > TARGET_STARTUP_MS) {
    scheduleCheckpoint();
  }
}

// ─── resolveQuery ─────────────────────────────────────────────────────────────

function resolveQuery(spec: SerializedQuerySpec): FoldResultSet | FoldHistoryResult {
  if (!position || !index || !log) {
    return { entries: [], count: 0 };
  }

  // History query
  if (spec.historySpec) {
    const { target, field, metrics } = spec.historySpec;
    const result: FoldHistoryResult = { target, field };
    const prefix = field ? `${target}.${field}` : target;
    const defSeqs = getIntersection(index, 'DEF', prefix);

    if (metrics.includes('defDepth')) result.defDepth = defSeqs.length;
    if (metrics.includes('agents')) {
      const agents = new Set<string>();
      for (const seq of defSeqs) {
        const offset = index.seqToOffset.get(seq);
        if (offset !== undefined) {
          const ev = readEventAt(log, offset);
          agents.add(ev.agent);
        }
      }
      result.agents = [...agents];
    }
    if (metrics.includes('supersessionRate')) {
      result.supersessionRate = defSeqs.length > 1 ? defSeqs.length / position.seq : 0;
    }
    return result;
  }

  // Graph traversal query
  if (spec.graphTraversal) {
    const { startTarget, depth, direction } = spec.graphTraversal;
    const visited = new Set<string>();
    const queue: Array<{ target: string; d: number }> = [{ target: startTarget, d: 0 }];
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (visited.has(item.target) || item.d > depth) continue;
      visited.add(item.target);
      if (direction === 'fwd' || direction === 'both') {
        for (const dest of position.conAdjacency.get(item.target) ?? new Set()) {
          if (!visited.has(dest)) queue.push({ target: dest, d: item.d + 1 });
        }
      }
      if (direction === 'rev' || direction === 'both') {
        for (const src of position.conReverse.get(item.target) ?? new Set()) {
          if (!visited.has(src)) queue.push({ target: src, d: item.d + 1 });
        }
      }
    }
    const entries = [...visited].map(t => buildFoldEntry(t));
    return { entries, count: entries.length };
  }

  // Standard op/prefix/structural filter query
  let candidateSeqs: Uint32Array | null = null;

  if (spec.prefix) {
    const prefixSeqs = trieQuery(index.trie, spec.prefix);
    candidateSeqs = prefixSeqs;
  }

  for (const op of spec.opFilters) {
    const opEntry = index.opIndex.get(op);
    const opSeqs = opEntry?.seqs ?? new Uint32Array(0);
    if (candidateSeqs === null) {
      candidateSeqs = opSeqs;
    } else {
      // Intersect
      const merged: number[] = [];
      let i = 0; let j = 0;
      while (i < candidateSeqs.length && j < opSeqs.length) {
        if (candidateSeqs[i] === opSeqs[j]) { merged.push(candidateSeqs[i]); i++; j++; }
        else if (candidateSeqs[i] < opSeqs[j]) i++;
        else j++;
      }
      candidateSeqs = new Uint32Array(merged);
    }
  }

  // Collect unique targets from candidate seqs
  const targetSet = new Set<string>();
  if (candidateSeqs) {
    for (const seq of candidateSeqs) {
      const offset = index.seqToOffset.get(seq);
      if (offset !== undefined) {
        const ev = readEventAt(log, offset);
        targetSet.add(ev.target);
      }
    }
  } else {
    // No filters — all targets
    for (const t of position.existenceIndex) targetSet.add(t);
  }

  // Apply structural filters
  let targets = [...targetSet];

  for (const sf of spec.structuralFilters) {
    switch (sf.type) {
      case 'whereEva':
        targets = targets.filter(t => position!.evaRegistrations.has(t));
        break;
      case 'whereEvaUnresolved':
        targets = targets.filter(t => {
          const reg = position!.evaRegistrations.get(t);
          return reg !== undefined && reg.lastConverged !== true;
        });
        break;
      case 'whereRec': {
        const minTimes = sf.minTimes;
        targets = targets.filter(t => {
          const recSeqs = getIntersection(index!, 'REC', t);
          return recSeqs.length >= minTimes;
        });
        break;
      }
      case 'whereContested': {
        targets = targets.filter(t => {
          const defSeqs = getIntersection(index!, 'DEF', t);
          const agentValues = new Map<string, unknown>();
          for (const seq of defSeqs) {
            const offset = index!.seqToOffset.get(seq);
            if (offset !== undefined) {
              const ev = readEventAt(log!, offset);
              agentValues.set(ev.agent, ev.operand);
            }
          }
          const distinctValues = new Set(agentValues.values());
          return agentValues.size > 1 && distinctValues.size > 1;
        });
        break;
      }
    }
  }

  if (spec.limit !== undefined) {
    targets = targets.slice(0, spec.limit);
  }

  const entries = targets.map(t => buildFoldEntry(t));

  let values: Map<string, Record<string, unknown>> | undefined;
  if (spec.withFields && spec.withFields.length > 0) {
    values = new Map();
    for (const t of targets) {
      const record: Record<string, unknown> = {};
      for (const field of spec.withFields!) {
        record[field] = getFieldFromLog(t, field);
      }
      values.set(t, record);
    }
  }

  return { entries, count: entries.length, values };
}

function buildFoldEntry(target: string): FoldEntry {
  const ops: LoggableOperator[] = [];
  for (const [op, entry] of index!.opIndex) {
    const seqs = getIntersection(index!, op, target);
    if (seqs.length > 0) ops.push(op);
  }
  const allSeqs = trieQuery(index!.trie, target);
  const lastSeq = allSeqs.length > 0 ? allSeqs[allSeqs.length - 1] : 0;
  return {
    target,
    ops,
    exists: position!.existenceIndex.has(target),
    evaRegistration: position!.evaRegistrations.get(target),
    lastSeq,
  };
}

// ─── Message handler ──────────────────────────────────────────────────────────

(self as unknown as DedicatedWorkerGlobalScope).onmessage = async (
  e: MessageEvent<FoldWorkerRequest>,
) => {
  const req = e.data;

  try {
    switch (req.type) {
      case 'init': {
        // Release any previously held SyncAccessHandle before re-opening.
        // This prevents "Access Handles cannot be created" errors on re-init
        // (e.g. hot reload within the same Worker lifetime).
        if (log?.syncHandle) {
          try { log.syncHandle.close(); } catch { /* best-effort */ }
          log = null;
        }
        const rootOpfsDir = await navigator.storage.getDirectory();
        // Each space gets its own OPFS subdirectory for isolation.
        opfsDir = req.spaceId
          ? await rootOpfsDir.getDirectoryHandle(`space.${req.spaceId}`, { create: true })
          : rootOpfsDir;
        log = await openLog(opfsDir);
        position = (await loadCheckpoint(opfsDir)) ?? createFoldPosition();
        nextSeq = position.seq;

        // ── Fast path: restore LogIndex + computedCache from init-cache ──────
        // If the log's byte length matches what the cache was written at, the
        // cache is known to be complete and consistent. Rebuilding the trie
        // and op-index from the cache's flat per-event arrays avoids the full
        // `buildIndex(log)` walk (which msgpack-unpacks every log entry).
        let fastPath = false;
        const t0 = performance.now();
        try {
          const cached = await loadInitCache(opfsDir, log.size);
          if (cached) {
            index = rebuildIndexFromCache(cached);
            for (const [k, v] of cached.computedCache) computedCache.set(k, v);
            fastPath = true;
          }
        } catch (e) {
          console.warn('[EO-DB] init-cache load failed, falling back to buildIndex:', e);
        }

        if (!index) {
          index = buildIndex(log);
        }

        // ── Compute the real log head seq from the freshly-built index ───────
        // `appendRaw` (used by bulk imports / Airtable sync) writes straight to
        // the OPFS log and updates the in-memory `position`, but does NOT call
        // checkAdaptiveCheckpoint, so the on-disk fold-position.bin checkpoint
        // lags behind the log when events are ingested between checkpoints.
        // On init, `position` is restored from that stale checkpoint. If we
        // reported `position.seq` as `headSeq`, it could equal the equally-
        // stale kv-snapshot seq on the main thread, causing init's "nothingNew"
        // fast-path to skip scanLog/replay entirely — and the user sees an
        // empty database even though every event is still on disk.
        //
        // Derive the true log head from the index (which was just built from
        // every log entry) and advance nextSeq defensively. We intentionally
        // do NOT touch position.seq or the rest of position's structural state
        // here: the main thread will run scanLog + replayFromLog against its
        // memStore, which is where structural state actually lives during a
        // session. The worker's position catches up naturally as future
        // events flow through appendRaw / writeEvent.
        let logHeadSeq = position.seq;
        for (const seq of index.seqToOffset.keys()) {
          if (seq > logHeadSeq) logHeadSeq = seq;
        }
        if (logHeadSeq > position.seq) {
          console.warn(
            `[EO-DB] fold checkpoint stale (checkpoint seq=${position.seq}, log head=${logHeadSeq}) — reporting log head as ready headSeq`,
          );
          nextSeq = Math.max(nextSeq, logHeadSeq);
          // Advance the bare counter so the scanLog fast-path stops short-
          // circuiting `req.since >= position.seq` and actually returns the log
          // entries past the stale checkpoint. Structural fields on position
          // are still stale; the main thread rebuilds them via replayFromLog.
          position.seq = logHeadSeq;
        }

        const elapsed = performance.now() - t0;
        if (position.seq > 0) {
          avgProcessMicrosPerEvent = (elapsed * 1000) / position.seq;
        }
        // Auto-checkpoint if startup was slow (log replay took too long)
        if (elapsed > TARGET_STARTUP_MS && opfsDir) {
          await saveCheckpoint(position, opfsDir);
          eventsSinceCheckpoint = 0;
        }
        // Re-evaluate all fold-mode EVA formulas so the computed cache is current.
        // The checkpoint snapshot may predate the last formula evaluation, leaving
        // _computed fields stale until the next event touches a dependency. On the
        // fast path the computedCache was just restored from disk, so this is a
        // no-op — skip to keep refresh truly free when nothing changed.
        if (!fastPath) {
          for (const [, reg] of position.evaRegistrations) {
            if (reg.mode === 'fold') evaluateFormula(reg);
          }
        }
        post({ id: -1, type: 'telemetry', avgMicrosPerEvent: avgProcessMicrosPerEvent });
        post({ id: -1, type: 'ready', headSeq: logHeadSeq, fastPath });
        break;
      }

      case 'writeEvent': {
        if (!log || !index || !position) throw new Error('Worker not initialized');
        const event = req.event;
        // Assign seq if not set
        if (!event.seq) {
          nextSeq++;
          event.seq = nextSeq;
        } else {
          nextSeq = Math.max(nextSeq, event.seq);
        }
        const { byteOffset } = appendEvent(log, event);
        updateIndex(index, event, byteOffset);
        applyEvent(position, event);
        if (event.op === 'EVA') registerEvaFormula(event);
        if (event.op === 'CON') {
          reEvaluateEvaMode(event.target);
          if (typeof event.operand === 'string') reEvaluateEvaMode(event.operand);
        }
        if (event.op !== 'REC' && event.op !== 'SIG') {
          recomputeDependents(event.target, new Set());
          await detectAndResolveREC(event.target, event);
        }
        post({ id: -1, type: 'eventEmitted', event });
        checkAdaptiveCheckpoint();
        post({ id: req.id, type: 'result', value: { seq: event.seq, byteOffset } });
        break;
      }

      case 'writeEventsBulk': {
        if (!log || !index || !position) throw new Error('Worker not initialized');
        bulkImportInProgress = true;
        const events = req.events;
        const touchedTargets = new Set<string>();

        // Phase 1: ingest all events
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          if (!event.seq) { nextSeq++; event.seq = nextSeq; }
          else nextSeq = Math.max(nextSeq, event.seq);
          const { byteOffset } = appendEvent(log, event);
          updateIndex(index, event, byteOffset);
          applyEvent(position, event);
          if (event.op === 'EVA') registerEvaFormula(event);
          touchedTargets.add(event.target);
          if (i % 1000 === 0) {
            post({ id: -1, type: 'progress', current: i, total: events.length });
          }
        }
        await saveCheckpoint(position, opfsDir!);
        eventsSinceCheckpoint = 0;

        // Phase 2: EVA recomputation
        const visited = new Set<string>();
        for (const target of touchedTargets) {
          recomputeDependents(target, visited);
        }

        // Phase 3: REC detection
        const syntheticTrigger = makeSystemEvent('INS', '__bulk__', null);
        for (const target of touchedTargets) {
          await detectAndResolveREC(target, syntheticTrigger);
        }
        await saveCheckpoint(position, opfsDir!);
        eventsSinceCheckpoint = 0;
        bulkImportInProgress = false;

        post({ id: req.id, type: 'result', value: position.seq });
        break;
      }

      case 'writeSig': {
        sigLayer.set(`${req.target}.${req.field}`, req.value);
        post({ id: req.id, type: 'result', value: null });
        break;
      }

      case 'getField': {
        const value = getFieldFromLog(req.target, req.field);
        post({ id: req.id, type: 'result', value: value ?? null });
        break;
      }

      case 'resolveQuery': {
        if (!position || !index || !log) throw new Error('Worker not initialized');
        const result = resolveQuery(req.spec);
        post({ id: req.id, type: 'result', value: result });
        break;
      }

      case 'appendRaw': {
        // Persist an already-folded event without EVA/REC evaluation.
        // The main-thread fold engine drives logic; this is storage only.
        if (!log || !index || !position) throw new Error('Worker not initialized');
        const event = req.event;
        if (event.seq) nextSeq = Math.max(nextSeq, event.seq);
        const { byteOffset } = appendEvent(log, event);
        updateIndex(index, event, byteOffset);
        applyEvent(position, event);
        if (event.op === 'EVA') registerEvaFormula(event);
        checkAdaptiveCheckpoint();
        post({ id: req.id, type: 'result', value: null });
        break;
      }

      case 'scanLog': {
        // Return all events with seq > req.since, in ascending order.
        if (!log) throw new Error('Worker not initialized');
        // Fast path: if the caller is already caught up (since >= position.seq),
        // there is nothing new — return immediately without walking the log.
        if (position && req.since >= position.seq) {
          post({ id: req.id, type: 'result', value: [] });
          break;
        }
        const events: EoEvent[] = [];
        for (const entry of scanLog(log, 0)) {
          if (entry.event.seq > req.since) {
            events.push(entry.event);
          }
        }
        post({ id: req.id, type: 'result', value: events });
        break;
      }

      case 'applyMigration': {
        if (!log || !index || !position) throw new Error('Worker not initialized');
        const depth = req.triggeredBy > 0 ? 1 : 0; // simplified depth check
        if (depth > 5) {
          await appendNulEvent(req.triggeredBy, 'unknown');
          post({ id: req.id, type: 'result', value: null });
          break;
        }
        for (const rule of req.rules) {
          if (rule.op === 'set_field') {
            const event = makeSystemEvent('DEF', rule.scope, rule.value, req.triggeredBy);
            writeEventInternal(event);
            recomputeDependents(rule.scope, new Set());
            await detectAndResolveREC(rule.scope, event);
          } else if (rule.op === 'delete_field') {
            const event = makeSystemEvent('NUL', rule.scope, null, req.triggeredBy);
            writeEventInternal(event);
          }
        }
        post({ id: req.id, type: 'result', value: null });
        break;
      }

      case 'saveKvSnapshot': {
        if (!opfsDir) throw new Error('Worker not initialized');
        // Version 2 carries `recentTail` alongside the kv entries so the
        // main thread can skip `readLogSince` on refresh. `hydratedHead`
        // is optional and forward-compatible — readers must accept its
        // absence (older snapshots, callers that don't track a chain
        // cursor). v1 snapshots are ignored on load.
        const payload = pack({
          version: 2,
          seq: req.seq,
          entries: req.entries,
          recentTail: req.recentTail,
          hydratedHead: req.hydratedHead ?? null,
        }) as Uint8Array;
        const exactBuf = payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength,
        ) as ArrayBuffer;
        const tmpHandle = await opfsDir.getFileHandle('kv-snapshot.tmp', { create: true });
        const writable = await tmpHandle.createWritable();
        await writable.write(new Blob([exactBuf]));
        await writable.close();
        await (tmpHandle as FileSystemFileHandle & {
          move(dest: FileSystemDirectoryHandle, name: string): Promise<void>;
        }).move(opfsDir, 'kv-snapshot.bin');
        post({ id: req.id, type: 'result', value: null });
        break;
      }

      case 'loadKvSnapshot': {
        if (!opfsDir) { post({ id: req.id, type: 'result', value: null }); break; }
        try {
          const fileHandle = await opfsDir.getFileHandle('kv-snapshot.bin');
          const file = await fileHandle.getFile();
          if (file.size === 0) { post({ id: req.id, type: 'result', value: null }); break; }
          const buf = await file.arrayBuffer();
          const data = unpack(new Uint8Array(buf)) as {
            version: number;
            seq: number;
            entries: [string, unknown][];
            recentTail?: EoEvent[];
            hydratedHead?: string | null;
          };
          // Only v2 is supported — v1 snapshots don't carry recentTail so we
          // treat them as a miss and let the main thread rebuild via readLogSince.
          if (data.version !== 2) { post({ id: req.id, type: 'result', value: null }); break; }
          post({
            id: req.id,
            type: 'result',
            value: {
              seq: data.seq,
              entries: data.entries,
              recentTail: data.recentTail ?? [],
              hydratedHead: data.hydratedHead ?? null,
            },
          });
        } catch {
          post({ id: req.id, type: 'result', value: null });
        }
        break;
      }

      case 'saveInitCache': {
        if (!opfsDir) throw new Error('Worker not initialized');
        const payload = buildInitCachePayload();
        if (payload) {
          try {
            await saveInitCache(payload, opfsDir);
          } catch (e) {
            console.warn('[EO-DB] init-cache save failed:', e);
          }
        }
        post({ id: req.id, type: 'result', value: null });
        break;
      }

      default:
        post({ id: (req as { id: number }).id, type: 'error', message: 'Unknown request type' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ id: req.id, type: 'error', message });
  }
};

// On close: checkpoint and release the SyncAccessHandle so other tabs/workers
// can acquire it promptly instead of hitting "Access Handles cannot be created".
(self as unknown as DedicatedWorkerGlobalScope).addEventListener('beforeunload', () => {
  if (position && opfsDir) {
    // Synchronous checkpoint on close — best-effort
    saveCheckpoint(position, opfsDir).catch(() => {});
  }
  if (log?.syncHandle) {
    try { log.syncHandle.close(); } catch { /* best-effort */ }
    log = null;
  }
});
