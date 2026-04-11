/**
 * Phase A constitutive site model — AddressingHorizon + DeclaredHorizon.
 *
 * The fold's two horizon layers, persisted to the EoStore alongside helix
 * state. Together they implement Phase A's site-existence floor: every site
 * the fold has ever touched is constituted in the AddressingHorizon, and the
 * DeclaredHorizon overlays explicit boundary content for sites that have
 * received an actual SEG event.
 *
 * Why two layers, not one
 * -----------------------
 *
 * The roadmap distinguishes "addressing" from "declaring" because CON, EVA,
 * and DEF are constitutive acts in their own right — the act of targeting a
 * site is itself an implicit SEG. A CON pointing at a site that has never
 * been explicitly SEG'd is still valid: the addressing event constitutes the
 * site at its own seq. The wave barrier, the snapshot writer, and the seq
 * allocator all need to know "does this site exist yet?" — and the answer is
 * "is it in the AddressingHorizon?", not "has it been explicitly SEG'd?".
 *
 * The DeclaredHorizon is the second-layer overlay: only sites with an actual
 * SEG event live there, and the SEG's payload (boundary content like type,
 * name, partition) is what the layer stores.
 *
 * SIG lifecycle
 * -------------
 *
 * SIGs are ephemeral by default. A site whose only addressing events are SIGs
 * is a draft — somebody started typing but never committed anything else. The
 * AddressingHorizon does NOT promote it on snapshot; replays start clean.
 *
 * If any non-SIG event subsequently fires on the same site, the SIG is
 * promoted: the AddressingRecord's firstSeq is BACKDATED to the SIG's seq
 * (so chronologically the site existed from the SIG's moment), and the
 * lifecycle moves out of 'ephemeral'. From then on, the site is permanent.
 *
 * The roadmap names three lifecycle states — ephemeral, pending-promotion,
 * permanent. In the current implementation, touch() collapses ephemeral →
 * permanent in a single transition: no caller today defers finalization
 * across waves. The pending-promotion state is reserved in the type union
 * for future use by callers that want to stage a promotion and finalize it
 * at a later barrier (e.g. a partition split that needs to atomically
 * promote a batch of SIGs together).
 */

import type { EoStore } from './encrypted-store';
import type { LoggableOperator, Resolution } from './types';

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * SIG lifecycle state.
 *
 *   'ephemeral'         — only SIG events have touched the site.
 *                          Filtered from snapshots; not persisted on replay.
 *   'pending-promotion' — non-SIG event has fired but the caller has chosen
 *                          to defer finalization (reserved; not used today).
 *   'permanent'         — site has been promoted; replays restore it.
 */
export type SigLifecycle = 'ephemeral' | 'pending-promotion' | 'permanent';

/**
 * Per-site record in the AddressingHorizon. Stored at `addressing:${site}`.
 *
 * Monotonically grows in lifecycle order:
 *   ephemeral → pending-promotion → permanent
 *
 * Once permanent, never moves backwards.
 */
export interface AddressingRecord {
  /**
   * Seq at which the site became constituted. Backdated to the SIG's seq if
   * the site was SIG-first then promoted by a later operator — so chronology
   * reflects when the user *signaled* intent, not when they committed.
   */
  firstSeq: number;
  /** Operator that first addressed the site. */
  firstOp: LoggableOperator;
  /** Current lifecycle state. */
  lifecycle: SigLifecycle;
  /** Seq of the event that promoted a SIG-first site. Unset if first op was non-SIG. */
  promotedAtSeq?: number;
  /** Operator that promoted a SIG-first site. Unset if first op was non-SIG. */
  promotedByOp?: LoggableOperator;
}

/**
 * Per-site record in the DeclaredHorizon. Stored at `declared:${site}`.
 *
 * Set by explicit SEG events only. Carries the boundary content the SEG
 * provided so wave-barrier consumers and the schema layer can answer
 * "what kind of site is this?" without re-walking the log.
 */
export interface DeclaredRecord {
  /** Seq of the SEG event that created or last updated this declaration. */
  seq: number;
  /** Whatever the SEG operand contained — type, name, partition, etc. */
  boundary: unknown;
}

/**
 * A single NUL observation on a site. NUL events are typed facts — the event's
 * resolution is the flavor of absence (Clearing, Tracing, Unraveling, …) and
 * the seq pins the moment the observation was made. A site can accumulate
 * many observations with different resolutions over time: e.g. first a
 * Tracing (we looked and didn't find), later a Clearing (we deliberately
 * removed the value).
 */
export interface NulObservation {
  site: string;
  resolution: Resolution;
  seq: number;
}

// ─── Storage layout ─────────────────────────────────────────────────────────

const ADDRESSING_PREFIX = 'addressing:';
const DECLARED_PREFIX = 'declared:';
const NUL_PREFIX = 'nul:';

function addressingKey(site: string): string {
  return `${ADDRESSING_PREFIX}${site}`;
}

function declaredKey(site: string): string {
  return `${DECLARED_PREFIX}${site}`;
}

function nulKey(site: string): string {
  return `${NUL_PREFIX}${site}`;
}

// ─── AddressingHorizon ──────────────────────────────────────────────────────

/**
 * The constitutive site model. Every event that addresses a site flows
 * through `touch()`, which is the single mutation surface; reads go through
 * `isConstituted()` / `getRecord()`. Snapshot consumers iterate via
 * `snapshotSites()`, which filters out ephemeral SIGs.
 *
 * The interface is deliberately narrow so a future in-memory or shared-buffer
 * implementation can drop in without rewiring fold.ts.
 */
export interface AddressingHorizon {
  /** True if `site` has ever been addressed by any non-ephemeral event. */
  isConstituted(site: string): Promise<boolean>;

  /** Read the full record, or null if the site has never been touched. */
  getRecord(site: string): Promise<AddressingRecord | null>;

  /**
   * Record that `op` fired on `site` at `seq`. Returns the post-touch record.
   *
   * First touch:
   *   - SIG → ephemeral record at seq
   *   - any other op → permanent record at seq
   *
   * Subsequent touches:
   *   - if existing is ephemeral and op is SIG → no-op (multiple SIGs don't
   *     promote each other; the user is still drafting)
   *   - if existing is ephemeral and op is non-SIG → promote: lifecycle
   *     becomes 'permanent', firstSeq is BACKDATED to the SIG's seq, the
   *     promoting op + seq are recorded in promotedAtSeq / promotedByOp
   *   - if existing is permanent → no-op (idempotent)
   */
  touch(site: string, op: LoggableOperator, seq: number): Promise<AddressingRecord>;

  /**
   * Return every site that should appear in a snapshot. Filters out records
   * still in 'ephemeral' lifecycle so draft SIGs don't bloat the snapshot or
   * leak partial-edit state across replays.
   */
  snapshotSites(): Promise<Array<{ site: string; record: AddressingRecord }>>;
}

/** EoStore-backed canonical AddressingHorizon. */
export class StoreAddressingHorizon implements AddressingHorizon {
  constructor(private readonly store: EoStore) {}

  async isConstituted(site: string): Promise<boolean> {
    const rec = await this.getRecord(site);
    if (!rec) return false;
    // Ephemeral records do not count as constituted for wave-barrier purposes;
    // they represent in-progress drafts, not real sites.
    return rec.lifecycle !== 'ephemeral';
  }

  async getRecord(site: string): Promise<AddressingRecord | null> {
    return (await this.store.get(addressingKey(site))) as AddressingRecord | null;
  }

  async touch(site: string, op: LoggableOperator, seq: number): Promise<AddressingRecord> {
    const existing = await this.getRecord(site);

    // First touch ever — create the record at this seq.
    if (!existing) {
      const record: AddressingRecord = {
        firstSeq: seq,
        firstOp: op,
        lifecycle: op === 'SIG' ? 'ephemeral' : 'permanent',
      };
      await this.store.put(addressingKey(site), record);
      return record;
    }

    // Already permanent — touches are no-ops. The first-fire seq is locked in.
    if (existing.lifecycle === 'permanent') {
      return existing;
    }

    // Pending-promotion is reserved for future use; treat as permanent for now.
    if (existing.lifecycle === 'pending-promotion') {
      return existing;
    }

    // Existing is ephemeral. A subsequent SIG keeps the site in draft.
    if (op === 'SIG') {
      return existing;
    }

    // Existing is ephemeral and a non-SIG event has now fired — promote.
    // firstSeq is BACKDATED to the original SIG's seq so chronologically the
    // site has existed from that moment. The promoting op's seq is preserved
    // in promotedAtSeq for audit / debugging.
    const promoted: AddressingRecord = {
      firstSeq: existing.firstSeq, // already the SIG's seq from the first touch
      firstOp: existing.firstOp,   // 'SIG'
      lifecycle: 'permanent',
      promotedAtSeq: seq,
      promotedByOp: op,
    };
    await this.store.put(addressingKey(site), promoted);
    return promoted;
  }

  async snapshotSites(): Promise<Array<{ site: string; record: AddressingRecord }>> {
    const entries = await this.store.iterator(ADDRESSING_PREFIX);
    const out: Array<{ site: string; record: AddressingRecord }> = [];
    for (const [key, value] of entries) {
      const record = value as AddressingRecord;
      if (record.lifecycle === 'ephemeral') continue;
      out.push({ site: key.slice(ADDRESSING_PREFIX.length), record });
    }
    return out;
  }
}

// ─── DeclaredHorizon ────────────────────────────────────────────────────────

/**
 * Overlay on top of the AddressingHorizon. Records ONLY sites that have
 * received an explicit SEG event, along with the boundary content the SEG
 * carried. The wave barrier and snapshot writer use this to answer "what
 * type of site is this and what does its declared boundary look like?" —
 * questions that AddressingHorizon alone can't answer because it tracks
 * existence, not content.
 */
export interface DeclaredHorizon {
  /** True if `site` has ever received an explicit SEG event. */
  isDeclared(site: string): Promise<boolean>;

  /** Read the boundary record, or null if no SEG has fired. */
  getRecord(site: string): Promise<DeclaredRecord | null>;

  /** Record that an explicit SEG event fired on `site` at `seq`. */
  declare(site: string, seq: number, boundary: unknown): Promise<DeclaredRecord>;

  /** Return every declared site for snapshot writing. */
  snapshotSites(): Promise<Array<{ site: string; record: DeclaredRecord }>>;
}

/** EoStore-backed canonical DeclaredHorizon. */
export class StoreDeclaredHorizon implements DeclaredHorizon {
  constructor(private readonly store: EoStore) {}

  async isDeclared(site: string): Promise<boolean> {
    const rec = await this.getRecord(site);
    return rec !== null;
  }

  async getRecord(site: string): Promise<DeclaredRecord | null> {
    return (await this.store.get(declaredKey(site))) as DeclaredRecord | null;
  }

  async declare(site: string, seq: number, boundary: unknown): Promise<DeclaredRecord> {
    const record: DeclaredRecord = { seq, boundary };
    await this.store.put(declaredKey(site), record);
    return record;
  }

  async snapshotSites(): Promise<Array<{ site: string; record: DeclaredRecord }>> {
    const entries = await this.store.iterator(DECLARED_PREFIX);
    return entries.map(([key, value]) => ({
      site: key.slice(DECLARED_PREFIX.length),
      record: value as DeclaredRecord,
    }));
  }
}

// ─── NulHorizon ─────────────────────────────────────────────────────────────

/**
 * NulHorizon — projection of the NUL slice onto the site axis.
 *
 * Not a table of missing values. A table of stable addresses where absence
 * has been explicitly observed, each tagged with the resolution (flavor of
 * absence) the observation carried and the seq it was made at.
 *
 * A site may accumulate multiple NUL entries with different resolutions —
 * e.g. first a Tracing (we looked and didn't find), later a Clearing (we
 * deliberately removed the value). The ordering is seq-ascending.
 *
 * Wired into the fold alongside AddressingHorizon and DeclaredHorizon; every
 * NUL event flows through `record()` after dispatch so the horizon's view of
 * absence survives replay.
 */
export interface NulHorizon {
  /** Record a NUL observation on `site`. O(1) — append to the per-site list. */
  record(site: string, resolution: Resolution, seq: number): Promise<void>;

  /** All observations on `site` in seq-ascending order. Empty array if none. */
  getObservations(site: string): Promise<NulObservation[]>;

  /** Most recent observation on `site` (highest seq), or undefined if none. */
  getLatest(site: string): Promise<NulObservation | undefined>;

  /** True if any NUL has ever fired on `site`. */
  isExplicitlyAbsent(site: string): Promise<boolean>;

  /** Every observation across every site — flattened, unordered. */
  snapshot(): Promise<NulObservation[]>;
}

/** EoStore-backed canonical NulHorizon. */
export class StoreNulHorizon implements NulHorizon {
  constructor(private readonly store: EoStore) {}

  async record(site: string, resolution: Resolution, seq: number): Promise<void> {
    const existing = ((await this.store.get(nulKey(site))) as NulObservation[] | null) ?? [];
    existing.push({ site, resolution, seq });
    await this.store.put(nulKey(site), existing);
  }

  async getObservations(site: string): Promise<NulObservation[]> {
    return ((await this.store.get(nulKey(site))) as NulObservation[] | null) ?? [];
  }

  async getLatest(site: string): Promise<NulObservation | undefined> {
    const obs = await this.getObservations(site);
    return obs.length === 0 ? undefined : obs[obs.length - 1];
  }

  async isExplicitlyAbsent(site: string): Promise<boolean> {
    const rec = (await this.store.get(nulKey(site))) as NulObservation[] | null;
    return rec !== null && rec.length > 0;
  }

  async snapshot(): Promise<NulObservation[]> {
    const entries = await this.store.iterator(NUL_PREFIX);
    const out: NulObservation[] = [];
    for (const [, value] of entries) {
      const obs = value as NulObservation[];
      for (const o of obs) out.push(o);
    }
    return out;
  }
}
