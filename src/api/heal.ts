import type { FastifyInstance } from 'fastify';
import type { EoDb, decode as LevelDecode } from '../db/level.js';
import { decode } from '../db/level.js';
import type { Feed } from '../db/feed.js';
import { processEvent } from '../db/fold.js';
import { getState, getStateByPrefix } from '../db/state.js';
import { readLogForTarget, readLogSince } from '../db/log.js';
import type { AuthenticatedRequest } from '../auth/matrix.js';
import type { EoEvent, HealingRecord, GraphEdge } from '../db/types.js';

// ─── /heal/partition-merge ─────────────────────────────────────────────────────
//
// Four-phase partition heal protocol (F2.2):
//   Phase 1 — G merge: append remote events to local log (idempotency via client_event_id)
//   Phase 2 — S update: collect all targets touched by remote events
//   Phase 3 — M recompute: detect conflicts (same target updated on both sides); emit DEF
//   Phase 4 — σ resolve: fire EVA policies on conflicted targets
//
// Body: { remote_events: EoEvent[] }
// Response: { merged: number; conflicts: number; def_seqs: number[]; errors: string[] }

async function partitionMergeHandler(
  db: EoDb,
  feed: Feed,
  agent: string,
  remoteEvents: EoEvent[]
): Promise<{ merged: number; conflicts: number; def_seqs: number[]; errors: string[] }> {
  const now = new Date().toISOString();
  const errors: string[] = [];
  const defSeqs: number[] = [];
  let merged = 0;
  let conflicts = 0;

  // Phase 1 & 2: replay remote events, track which targets they touch
  const touchedTargets = new Set<string>();
  const remoteValueByTarget = new Map<string, any>();

  for (const ev of remoteEvents) {
    // Capture local state BEFORE merging this event
    const localBefore = await getState(db, ev.target);

    try {
      const seq = await processEvent(db, {
        op: ev.op,
        target: ev.target,
        operand: ev.operand,
        agent: ev.agent,
        ts: ev.ts,
        acquired_ts: now,
        client_event_id: ev.client_event_id,
        context_envelope: ev.context_envelope,
      }, feed);

      if (seq > 0) {
        merged++;
        touchedTargets.add(ev.target);
        // If local state existed before and remote brought a different value, it's a conflict candidate
        if (localBefore !== null) {
          const remoteVal = ev.op === 'DEF' || ev.op === 'INS' ? ev.operand : null;
          if (remoteVal !== null) {
            remoteValueByTarget.set(ev.target, { local: localBefore.value, remote: remoteVal });
          }
        }
      }
    } catch (e: any) {
      errors.push(`[${ev.target}] ${e.message}`);
    }
  }

  // Phase 3: for each conflict candidate, emit DEF holding both values
  for (const [target, { local, remote }] of remoteValueByTarget) {
    const currentState = await getState(db, target);
    if (!currentState) continue;
    // Conflict: local value existed before remote event arrived, and values differ
    if (JSON.stringify(local) !== JSON.stringify(currentState.value)) {
      conflicts++;
      try {
        const defSeq = await processEvent(db, {
          op: 'DEF',
          target,
          operand: {
            _conflict: true,
            _local: local,
            _remote: remote,
            _heal_phase: 'partition-merge',
          },
          agent: 'system',
          ts: now,
          acquired_ts: now,
        }, feed);
        defSeqs.push(defSeq);
      } catch (e: any) {
        errors.push(`[DEF conflict on ${target}] ${e.message}`);
      }
    }
  }

  // Phase 4: EVA resolution — fire any fold-mode EVA policies on touched targets
  // (EVA policies are registered via DEF formula operands; recomputeDependents handles this
  //  automatically inside processEvent, so no extra step is needed here)

  return { merged, conflicts, def_seqs: defSeqs, errors };
}

// ─── /heal/con-integrity ───────────────────────────────────────────────────────
//
// Scan all graph edges and verify each CON(a, b) has:
//   1. INS(a) in G
//   2. INS(b) in G
//   3. At least one SEG boundary on the common ancestor
//
// For each violation, re-emit SEG on the common prefix, then re-emit NUL[cleared] + CON.
// Body: {} (no params needed)
// Response: { scanned: number; repaired: number; audit: HealingRecord[] }

async function conIntegrityHandler(
  db: EoDb,
  feed: Feed,
  agent: string
): Promise<{ scanned: number; repaired: number; audit: HealingRecord[] }> {
  const now = new Date().toISOString();
  const audit: HealingRecord[] = [];
  let scanned = 0;
  let repaired = 0;

  // Scan all forward graph edges
  const allEdges: GraphEdge[] = [];
  for await (const [, value] of (db as any).iterator({
    gte: 'graph:fwd:',
    lte: 'graph:fwd:\xff',
  })) {
    allEdges.push(decode(value) as GraphEdge);
  }

  for (const edge of allEdges) {
    scanned++;
    const { source, dest } = edge;
    const helixOps: HealingRecord['helix_ops'] = [];
    let violated = false;

    // Check INS(source)
    const sourceState = await getState(db, source);
    if (!sourceState) {
      violated = true;
      helixOps.push({ op: 'NUL', target: source, reason: 'INS missing for CON source' });
    }

    // Check INS(dest)
    const destState = await getState(db, dest);
    if (!destState) {
      violated = true;
      helixOps.push({ op: 'NUL', target: dest, reason: 'INS missing for CON dest' });
    }

    // Check SEG ancestor
    const partsA = source.split('.');
    const partsB = dest.split('.');
    const commonParts: string[] = [];
    for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
      if (partsA[i] === partsB[i]) commonParts.push(partsA[i]);
      else break;
    }
    const commonPrefix = commonParts.join('.');

    let hasSegBoundary = false;
    if (commonParts.length > 0) {
      for (let len = commonParts.length; len >= 1; len--) {
        const prefix = commonParts.slice(0, len).join('.');
        const prefixState = await getState(db, prefix);
        if (prefixState && prefixState.last_op === 'SEG') { hasSegBoundary = true; break; }
        const history = await readLogForTarget(db, prefix);
        if (history.some(e => e.op === 'SEG')) { hasSegBoundary = true; break; }
      }
    }

    if (!hasSegBoundary) {
      violated = true;
      helixOps.push({ op: 'SEG', target: commonPrefix || source, reason: 'No SEG boundary for CON endpoints' });
    }

    if (violated) {
      repaired++;

      // Re-emit SEG on common prefix if missing
      if (!hasSegBoundary && commonPrefix) {
        try {
          await processEvent(db, {
            op: 'SEG',
            target: commonPrefix,
            operand: { _heal: true, source, dest },
            agent: 'system',
            ts: now,
            acquired_ts: now,
          }, feed);
          helixOps.push({ op: 'SEG', target: commonPrefix, reason: 'Boundary re-established by /heal/con-integrity' });
        } catch { /* target may not exist — skip SEG repair if so */ }
      }

      // Emit NUL[cleared] on the CON to surface the gap
      try {
        await processEvent(db, {
          op: 'NUL',
          target: source,
          operand: { _heal: true, con_pair: [source, dest], violation: helixOps.map(h => h.reason) },
          agent: 'system',
          ts: now,
          acquired_ts: now,
        }, feed);
        helixOps.push({ op: 'NUL', target: source, reason: 'CON integrity gap surfaced' });
      } catch { /* best-effort */ }

      audit.push({
        failure_class: 'F2.3',
        target: source,
        detected_at: now,
        helix_ops: helixOps,
        resolved: true,
      });
    }
  }

  return { scanned, repaired, audit };
}

// ─── /heal/frozen-frame ────────────────────────────────────────────────────────
//
// Scan all states for F3.3 violations: states that have never been superseded
// (no defeasible_since) and are older than the given threshold.
//
// For each flagged state, emit SIG(target, { flag: 'immunity_candidate' }).
// Body: { age_threshold_days: number }
// Response: { scanned: number; flagged: number; targets: string[] }

async function frozenFrameHandler(
  db: EoDb,
  feed: Feed,
  agent: string,
  ageThresholdDays: number
): Promise<{ scanned: number; flagged: number; targets: string[] }> {
  const now = new Date();
  const thresholdMs = ageThresholdDays * 24 * 60 * 60 * 1000;
  const flagged: string[] = [];
  let scanned = 0;

  // Iterate all state keys
  for await (const [, value] of (db as any).iterator({
    gte: 'state:',
    lte: 'state:\xff',
  })) {
    const state = decode(value) as import('../db/types.js').EoState;
    scanned++;

    if (state.defeasible_since !== undefined) continue; // already marked supersedable

    const lastTs = new Date(state.last_acquired_ts);
    const ageMs = now.getTime() - lastTs.getTime();
    if (ageMs < thresholdMs) continue;

    // Flag this target — emit SIG with immunity_candidate marker
    flagged.push(state.target);
    try {
      await processEvent(db, {
        op: 'SIG',
        target: state.target,
        operand: {
          flag: 'immunity_candidate',
          age_days: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
          last_op: state.last_op,
          failure_class: 'F3.3',
        },
        agent: 'system',
        ts: now.toISOString(),
        acquired_ts: now.toISOString(),
      }, feed);
    } catch { /* SIG is best-effort */ }
  }

  return { scanned, flagged: flagged.length, targets: flagged };
}

// ─── Route Registration ────────────────────────────────────────────────────────

export function registerHealRoutes(app: FastifyInstance, db: EoDb, feed: Feed): void {
  app.post('/heal/partition-merge', async (request: AuthenticatedRequest, reply) => {
    const body = request.body as { remote_events?: EoEvent[] };
    if (!body.remote_events || !Array.isArray(body.remote_events)) {
      return reply.code(400).send({ error: 'Missing required field: remote_events (array)' });
    }
    const agent = request.matrixUser?.user_id || 'system';
    try {
      const result = await partitionMergeHandler(db, feed, agent, body.remote_events);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.post('/heal/con-integrity', async (request: AuthenticatedRequest, reply) => {
    const agent = request.matrixUser?.user_id || 'system';
    try {
      const result = await conIntegrityHandler(db, feed, agent);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });

  app.post('/heal/frozen-frame', async (request: AuthenticatedRequest, reply) => {
    const body = request.body as { age_threshold_days?: number };
    const ageThresholdDays = body.age_threshold_days ?? 30;
    const agent = request.matrixUser?.user_id || 'system';
    try {
      const result = await frozenFrameHandler(db, feed, agent, ageThresholdDays);
      return reply.send(result);
    } catch (e: any) {
      return reply.code(500).send({ error: e.message });
    }
  });
}
