/**
 * Incremental fold cache — maintained on each event, consumed by horizonGet.
 *
 * Trajectory, trajectoryFingerprint, and cadence are stored on EoState._fold
 * and updated in-place by updateFoldCache() on every event. This turns
 * record-view reads from O(events × targets) into O(1), and confines the
 * per-event cost to a single state read + write.
 */

import type { EoStore } from './encrypted-store';
import { getState, setState, getStateByPrefix } from './state';
import { getEdgesFrom, getEdgesTo } from './graph';
import { seedHash, chainHash } from './hash';
import { readLogForTarget } from './log';
import type {
  EoEvent, EoStateFold, TrajectoryEntry, TrajectoryFingerprint,
  CadenceInfo, CadenceClass, LoggableOperator, GraphMetrics, GraphRole,
} from './types';
import { extractCard, getChunkWriter, getCardBuffer } from './card-encoder';

const ALL_LOGGABLE_OPS: LoggableOperator[] = ['NUL', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'];
const INTERVAL_WINDOW = 200;              // cap intervalsSorted length (sliding)
const BURST_WINDOW_MS = 60 * 60 * 1000;   // 1 hour

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function fingerprintOf(trajectory: TrajectoryEntry[]): Promise<TrajectoryFingerprint> {
  const sequence = trajectory.map(t => t.op).join('.');
  const fingerprint = (await sha256Hex(sequence)).slice(0, 16);
  const opCounts = {} as Record<LoggableOperator, number>;
  for (const op of ALL_LOGGABLE_OPS) opCounts[op] = 0;
  for (const t of trajectory) opCounts[t.op] = (opCounts[t.op] || 0) + 1;
  return { sequence, fingerprint, opCounts };
}

/** One-step extension of a compressed trajectory. Returns the new trajectory + running hash head. */
export async function foldTrajectoryStep(
  prev: TrajectoryEntry[],
  prevHead: string,
  event: EoEvent,
): Promise<{ trajectory: TrajectoryEntry[]; head: string }> {
  const head = prev.length === 0
    ? await seedHash(event)
    : await chainHash(prevHead, event);

  const last = prev[prev.length - 1];
  if (last && last.op === event.op) {
    const trajectory = prev.slice(0, -1);
    trajectory.push({ op: last.op, hash: head });
    return { trajectory, head };
  }
  return { trajectory: [...prev, { op: event.op as LoggableOperator, hash: head }], head };
}

/** Cadence classification — pure function over aggregates. */
export function classifyCadence(
  eventCount: number,
  firstTs: string,
  lastTs: string,
  intervalsSorted: number[],
  maxInHour: number,
): CadenceInfo {
  if (eventCount === 0) {
    return { classification: 'sparse', lastEventTs: '', eventCount: 0, description: 'No events' };
  }
  if (eventCount < 2) {
    return { classification: 'sparse', lastEventTs: lastTs, eventCount, description: 'Single event' };
  }

  const daysSinceLast = (Date.now() - new Date(lastTs).getTime()) / (1000 * 60 * 60 * 24);

  let classification: CadenceClass;
  let description: string;

  if (daysSinceLast > 30) {
    classification = 'dormant';
    description = `Dormant — no activity for ${Math.round(daysSinceLast)} days`;
  } else if (maxInHour > 3) {
    classification = 'burst';
    description = `Burst activity — ${maxInHour} events within one hour`;
  } else if (intervalsSorted.length >= 3) {
    const median = intervalsSorted[Math.floor(intervalsSorted.length / 2)];
    const periodic = median > 0
      ? intervalsSorted.filter(i => Math.abs(i - median) / median < 0.2).length
      : 0;
    if (periodic / intervalsSorted.length > 0.6) {
      classification = 'periodic';
      const periodHours = Math.round(median / 3600000);
      description = `Periodic — roughly every ${periodHours > 24 ? Math.round(periodHours / 24) + ' days' : periodHours + ' hours'}`;
    } else {
      classification = 'steady';
      const spanDays = Math.round((new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 86400000);
      description = `Steady — ${eventCount} events over ${spanDays} days`;
    }
  } else {
    classification = 'sparse';
    description = `Sparse — ${eventCount} events total`;
  }

  return { classification, lastEventTs: lastTs, eventCount, description };
}

function insertSorted(arr: number[], v: number, cap: number): number[] {
  // binary insert
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1; else hi = mid;
  }
  const next = arr.slice();
  next.splice(lo, 0, v);
  if (next.length > cap) {
    // Drop the smallest interval to preserve the right tail (most recent activity shape).
    // The cap is a quality-vs-memory tradeoff; classification reads median so this is stable.
    next.shift();
  }
  return next;
}

/**
 * Update the fold cache on state:{target} after the operator handler has written
 * its state row. Safe to call on a freshly-INS'd target (no prior trajectory).
 *
 * Uses a targeted update: reads state, mutates _fold fields, writes state back.
 */
export async function updateFoldCache(store: EoStore, event: EoEvent): Promise<void> {
  const state = await getState(store, event.target);
  if (!state) return; // nothing to attach to (e.g. SYN aliases handled by source target state)

  const prev: EoStateFold | undefined = state._fold;
  const prevTrajectory = prev?.trajectory ?? [];
  const prevHead = prev?.trajectoryHead ?? '';

  const { trajectory, head } = await foldTrajectoryStep(prevTrajectory, prevHead, event);
  const trajectoryFingerprint = await fingerprintOf(trajectory);

  const eventMs = new Date(event.ts).getTime();
  const eventCount = (prev?.eventCount ?? 0) + 1;
  const firstEventTs = prev?.firstEventTs || event.ts;
  const lastEventTs = event.ts;

  let intervalsSorted = prev?.intervalsSorted ?? [];
  if (prev?.lastEventTs) {
    const gap = eventMs - new Date(prev.lastEventTs).getTime();
    if (gap >= 0) intervalsSorted = insertSorted(intervalsSorted, gap, INTERVAL_WINDOW);
  }

  const recentTimestamps = (prev?.recentTimestamps ?? []).filter(t => eventMs - t <= BURST_WINDOW_MS);
  recentTimestamps.push(eventMs);
  const maxInHour = recentTimestamps.length;

  const cadence = classifyCadence(eventCount, firstEventTs, lastEventTs, intervalsSorted, maxInHour);

  // ─── Similarity signals ───
  // touchedAgents: deduplicated list of all agents who wrote to this target
  const prevAgents = prev?.touchedAgents ?? [];
  const touchedAgents = prevAgents.includes(event.agent)
    ? prevAgents
    : [...prevAgents, event.agent];

  // segmentMemberships: string tags from the most recent SEG operand
  let segmentMemberships = prev?.segmentMemberships;
  if (event.op === 'SEG') {
    const op = event.operand;
    if (Array.isArray(op)) {
      segmentMemberships = op.map(String).filter(Boolean);
    } else if (typeof op === 'string' && op) {
      segmentMemberships = [op];
    }
  }

  const _fold: EoStateFold = {
    trajectory,
    trajectoryHead: head,
    trajectoryFingerprint,
    cadence,
    eventCount,
    firstEventTs,
    lastEventTs,
    intervalsSorted,
    recentTimestamps,
    touchedAgents,
    ...(segmentMemberships !== undefined ? { segmentMemberships } : {}),
    ...(prev?.crystallizedIn !== undefined ? { crystallizedIn: prev.crystallizedIn } : {}),
  };

  if (event.op === 'REC') {
    state._lastRecSeq = event.seq;
  }

  await setState(store, { ...state, _fold });

  // ── Card encoder hook: extract compact card summary + persist to chunk ──
  const writer = getChunkWriter();
  if (writer) {
    const card = extractCard(event.target, event, _fold, state.graphMetrics?.degree ?? 0);
    await writer.addRecord(card);
    const buf = getCardBuffer();
    if (buf) buf.upsert(card);
  }
}

/**
 * Compute graph metrics for a target from its current edges. Cached on EoState
 * by CON/SYN handlers when edges change.
 */
export async function computeGraphMetricsFor(store: EoStore, target: string): Promise<GraphMetrics | undefined> {
  const outEdges = await getEdgesFrom(store, target);
  const inEdges = await getEdgesTo(store, target);
  const outDegree = outEdges.length;
  const inDegree = inEdges.length;
  const degree = outDegree + inDegree;
  if (degree === 0) return undefined;

  const outTargets = new Set(outEdges.map(e => e.dest));
  const inSources = new Set(inEdges.map(e => e.source));
  let mutualCount = 0;
  for (const t of outTargets) if (inSources.has(t)) mutualCount++;

  let role: GraphRole;
  if (degree === 1) {
    role = 'leaf';
  } else if (degree >= 6) {
    role = 'hub';
  } else {
    const connectedCollections = new Set<string>();
    for (const e of outEdges) {
      const parts = e.dest.split('.');
      if (parts.length >= 2) connectedCollections.add(parts.slice(0, 2).join('.'));
    }
    for (const e of inEdges) {
      const parts = e.source.split('.');
      if (parts.length >= 2) connectedCollections.add(parts.slice(0, 2).join('.'));
    }
    role = connectedCollections.size >= 2 ? 'bridge' : 'leaf';
  }

  return { role, degree, inDegree, outDegree, mutualCount };
}

/**
 * Refresh cached graphMetrics on a state row. Called from CON/SYN after edge mutations.
 */
export async function refreshGraphMetrics(store: EoStore, target: string): Promise<void> {
  const state = await getState(store, target);
  if (!state) return;
  const graphMetrics = await computeGraphMetricsFor(store, target);
  await setState(store, { ...state, graphMetrics });
}

/**
 * Build a complete _fold for a target by scanning its event log.
 * Used by one-time backfill on stores created before _fold existed.
 */
export async function computeFoldFromLog(store: EoStore, target: string): Promise<EoStateFold | null> {
  const events = await readLogForTarget(store, target);
  if (events.length === 0) return null;

  let trajectory: TrajectoryEntry[] = [];
  let head = '';
  let firstEventTs = events[0].ts;
  let lastEventTs = events[events.length - 1].ts;
  let intervalsSorted: number[] = [];
  let recentTimestamps: number[] = [];
  const lastMs = new Date(lastEventTs).getTime();
  let prevMs: number | null = null;

  for (const event of events) {
    const step = await foldTrajectoryStep(trajectory, head, event);
    trajectory = step.trajectory;
    head = step.head;

    const ms = new Date(event.ts).getTime();
    if (prevMs !== null) {
      const gap = ms - prevMs;
      if (gap >= 0) intervalsSorted = insertSorted(intervalsSorted, gap, INTERVAL_WINDOW);
    }
    prevMs = ms;
    if (lastMs - ms <= BURST_WINDOW_MS) recentTimestamps.push(ms);
  }

  const trajectoryFingerprint = await fingerprintOf(trajectory);
  const cadence = classifyCadence(
    events.length, firstEventTs, lastEventTs, intervalsSorted, recentTimestamps.length,
  );

  return {
    trajectory,
    trajectoryHead: head,
    trajectoryFingerprint,
    cadence,
    eventCount: events.length,
    firstEventTs,
    lastEventTs,
    intervalsSorted,
    recentTimestamps,
  };
}

/**
 * One-time backfill for stores created before _fold existed.
 * Scans state:* once, populates _fold + _lastRecSeq on any row missing them.
 */
export async function backfillFoldCaches(store: EoStore): Promise<number> {
  const states = await getStateByPrefix(store, '');
  let updated = 0;
  for (const state of states) {
    if (state._fold) continue;
    if (state.value?._alias) continue;
    const fold = await computeFoldFromLog(store, state.target);
    if (!fold) continue;

    // Find last REC seq for RecCycleInfo
    const events = await readLogForTarget(store, state.target);
    const lastRec = [...events].reverse().find(e => e.op === 'REC');
    const graphMetrics = await computeGraphMetricsFor(store, state.target);

    await setState(store, {
      ...state,
      _fold: fold,
      _lastRecSeq: lastRec?.seq,
      graphMetrics,
    });
    updated++;
  }
  return updated;
}
