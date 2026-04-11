/**
 * Branch Explorer — Zustand store for branch UI state and projection cache.
 *
 * Branches are first-class log entities (created via INS + DEF dispatched on
 * useEoStore). The branch store keeps the UI session state — currently viewed
 * branch subject, scrubber position, world / stance selection — and owns
 * the in-memory ProjectionEngine cache.
 */

import { create } from 'zustand';
import { useEoStore } from './eo-store';
import { ProjectionEngine } from '../projection/ProjectionEngine';
import type { EoEvent, EoEventInput } from '../db/types';
import type {
  BranchPolicy,
  BranchRecord,
  EvaStance,
  ProjectedState,
  WorldType,
} from '../types/branch';
import { readLogSince } from '../db/log';

interface BranchStoreState {
  /** Active branches loaded for the current session, keyed by branch_id. */
  branches: BranchRecord[];

  /** Per-world cached projections, keyed by branch_id:world:stance:atTs. */
  projectionCache: Map<string, ProjectedState>;

  /** Subject of the merge currently being explored. */
  activeBranchSubject: string | null;

  /** UI selection state. */
  selectedWorld: WorldType;
  selectedStance: EvaStance;
  /** Scrubber position 0..1 across the visible time range. */
  scrubberT: number;

  /** True while a projection is being computed (cache miss in flight). */
  projecting: boolean;

  /** The shared ProjectionEngine instance — created lazily on first use. */
  engine: ProjectionEngine | null;

  // ─── Actions ──────────────────────────────────────────────────────────────

  /** Lazy-init the engine using the live EoStore. */
  ensureEngine(): ProjectionEngine | null;

  /**
   * Load all branches whose subject matches `subject`. Falls back to scanning
   * the live log for branch entities (key prefix `state:branch:`).
   */
  loadBranchesForSubject(subject: string): Promise<void>;

  /**
   * Create the three branch records for a SYN event and dispatch the matching
   * INS + DEF events into the Given-Log. The new branches become the active
   * subject so the UI can switch to them immediately.
   */
  createBranchSet(synEvent: EoEvent): Promise<BranchRecord[]>;

  setActiveBranchSubject(subject: string | null): void;
  setScrubberT(t: number): void;
  setWorld(w: WorldType): void;
  setStance(s: EvaStance): void;

  /**
   * Returns a cached projection if present, otherwise triggers a fetch and
   * returns null. The store re-renders subscribers once the fetch resolves.
   */
  getProjection(world: WorldType, atTs: string): ProjectedState | null;

  /** Drop all cached projections — call when new log events arrive. */
  invalidate(): void;
}

const POLICY_PREFIX = 'branch.';

export const useBranchStore = create<BranchStoreState>((set, get) => ({
  branches: [],
  projectionCache: new Map(),
  activeBranchSubject: null,
  selectedWorld: 'canonical',
  selectedStance: 'clearing',
  scrubberT: 0.3,
  projecting: false,
  engine: null,

  ensureEngine() {
    const existing = get().engine;
    if (existing) return existing;
    const store = useEoStore.getState().store;
    if (!store) return null;
    const engine = new ProjectionEngine({ store });
    set({ engine });
    return engine;
  },

  async loadBranchesForSubject(subject: string) {
    const store = useEoStore.getState().store;
    if (!store) {
      set({ branches: [], activeBranchSubject: subject });
      return;
    }
    // Branch entities live at state:branch.<branch_id>. We scan the prefix
    // and filter by subject. Branches are tiny — no pagination needed yet.
    const entries = await store.iterator(`state:${POLICY_PREFIX}`);
    const branches: BranchRecord[] = [];
    for (const [, value] of entries) {
      const v = value as { value?: unknown } | null;
      if (!v || typeof v !== 'object') continue;
      const inner = (v as { value?: unknown }).value;
      const record = parseBranchRecord(inner);
      if (record && record.subject === subject) branches.push(record);
    }
    set({ branches, activeBranchSubject: subject });
  },

  async createBranchSet(synEvent: EoEvent) {
    const sources = synSources(synEvent);
    if (sources.length < 2) {
      throw new Error('createBranchSet: SYN event has fewer than two source entities');
    }
    const survivor = synSurvivor(synEvent);
    if (!survivor) {
      throw new Error('createBranchSet: SYN event has no survivor target');
    }
    const subject = sources.join(',');
    const author = useEoStore.getState().syncManager
      ? '@user:matrix'
      : '@local:localhost';

    const dispatch = useEoStore.getState().dispatch;
    const created: BranchRecord[] = [];

    const worlds: WorldType[] = ['canonical', 'never-merged', 'always-merged'];
    for (const world of worlds) {
      const branchId = crypto.randomUUID();
      const policy: BranchPolicy = {
        world,
        stance: world === 'always-merged' ? 'clearing' : null,
        suppress_event_ids: world === 'never-merged' ? [String(synEvent.seq)] : [],
        retroject_event_ids: world === 'always-merged' ? [String(synEvent.seq)] : [],
        branch_point_ts: synEvent.ts,
      };
      const record: BranchRecord = {
        branch_id: branchId,
        subject,
        survivor_id: survivor,
        policy,
        epistemic_status: 'projection-sketch',
        author,
        created_at: new Date().toISOString(),
        label: defaultLabel(world),
      };

      const target = `${POLICY_PREFIX}${branchId}`;
      const now = new Date().toISOString();
      const insEvent: EoEventInput = {
        op: 'INS',
        target,
        operand: { kind: 'branch', subject, survivor_id: survivor },
        agent: author,
        ts: now,
        acquired_ts: now,
      };
      const defEvent: EoEventInput = {
        op: 'DEF',
        target,
        operand: serializeBranchRecord(record),
        agent: author,
        ts: now,
        acquired_ts: now,
      };
      try {
        await dispatch(insEvent);
        await dispatch(defEvent);
        created.push(record);
      } catch (e) {
        console.warn('[branch-store] createBranchSet failed for world', world, e);
      }
    }

    set((state) => ({
      branches: [...state.branches, ...created],
      activeBranchSubject: subject,
    }));
    get().invalidate();
    return created;
  },

  setActiveBranchSubject(subject) {
    set({ activeBranchSubject: subject });
  },

  setScrubberT(t) {
    const clamped = Math.max(0, Math.min(1, t));
    set({ scrubberT: clamped });
  },

  setWorld(w) {
    set({ selectedWorld: w });
  },

  setStance(s) {
    set({ selectedStance: s });
  },

  getProjection(world, atTs) {
    const branches = get().branches.filter((b) => b.policy.world === world);
    const branch = branches[branches.length - 1];
    if (!branch) return null;
    const stance = branch.policy.world === 'always-merged'
      ? get().selectedStance
      : (branch.policy.stance ?? null);
    const effectiveBranch: BranchRecord = stance === branch.policy.stance
      ? branch
      : { ...branch, policy: { ...branch.policy, stance } };

    const cache = get().projectionCache;
    const cacheKey = `${effectiveBranch.branch_id}:${world}:${stance ?? '_'}:${atTs}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const engine = get().ensureEngine();
    if (!engine) return null;

    set({ projecting: true });
    engine
      .project(effectiveBranch, atTs)
      .then((projected) => {
        const next = new Map(get().projectionCache);
        next.set(cacheKey, projected);
        set({ projectionCache: next, projecting: false });
      })
      .catch((e) => {
        console.warn('[branch-store] projection failed', e);
        set({ projecting: false });
      });
    return null;
  },

  invalidate() {
    const engine = get().engine;
    if (engine) engine.invalidate();
    set({ projectionCache: new Map() });
  },
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

function defaultLabel(world: WorldType): string {
  switch (world) {
    case 'canonical': return 'W-0 canonical';
    case 'never-merged': return 'W-1 never merged';
    case 'always-merged': return 'W-2 always merged';
  }
}

function serializeBranchRecord(record: BranchRecord): Record<string, unknown> {
  return {
    branch_id: record.branch_id,
    subject: record.subject,
    survivor_id: record.survivor_id,
    policy: { ...record.policy },
    epistemic_status: record.epistemic_status,
    author: record.author,
    created_at: record.created_at,
    label: record.label ?? null,
  };
}

function parseBranchRecord(value: unknown): BranchRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.branch_id !== 'string' || typeof v.subject !== 'string') return null;
  if (typeof v.survivor_id !== 'string') return null;
  const policy = v.policy as BranchPolicy | undefined;
  if (!policy || typeof policy.world !== 'string') return null;
  return {
    branch_id: v.branch_id,
    subject: v.subject,
    survivor_id: v.survivor_id,
    policy,
    epistemic_status: 'projection-sketch',
    author: typeof v.author === 'string' ? v.author : 'unknown',
    created_at: typeof v.created_at === 'string' ? v.created_at : new Date().toISOString(),
    label: typeof v.label === 'string' ? v.label : undefined,
  };
}

function synSources(event: EoEvent): string[] {
  const operand = event.operand as { merge?: unknown[] } | null | undefined;
  if (!operand || !Array.isArray(operand.merge)) return [];
  return operand.merge.map((x) => String(x));
}

function synSurvivor(event: EoEvent): string | null {
  const operand = event.operand as { into?: unknown } | null | undefined;
  if (operand && typeof operand.into === 'string') return operand.into;
  return event.target ?? null;
}

/**
 * Convenience helper for the BranchExplorer: enumerate all SYN events from
 * the live log so the UI can list available merge points to branch from.
 */
export async function listSynEvents(): Promise<EoEvent[]> {
  const store = useEoStore.getState().store;
  if (!store) return [];
  const all = await readLogSince(store, 0);
  return all.filter((e) => e.op === 'SYN');
}
