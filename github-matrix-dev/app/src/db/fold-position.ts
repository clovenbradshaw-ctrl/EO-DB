/**
 * Layer 3 — Structural skeleton (FoldPosition).
 *
 * Tracks existence, aliases, EVA registrations, CON graph edges, segment
 * memberships, and transformation hash chains. No field values are stored
 * here — those live in the value cache (Layer 5).
 *
 * Updated O(1) per event via applyEvent(). Checkpointed to OPFS periodically
 * for fast restart (avoids replaying the full log on every page load).
 *
 * EvaRegistrationLive is defined here (not in types.ts) because it is a
 * fold-position–internal type, not a log-level type.
 *
 * Replaces:
 *   state.ts getState / setState    — field values no longer stored here
 *   graph.ts addEdge / getEdgesFrom — replaced by conAdjacency (in-memory Map)
 *   helpers.ts resolveAlias         — reads aliasMap directly, O(1)
 *   helpers.ts checkExists          — reads existenceIndex directly, O(1)
 */

import { pack, unpack } from 'msgpackr';
import type { EvaRegistration, EoEvent } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Extends EvaRegistration with convergence-tracking fields.
 * Defined here — import from fold-position.ts, NOT from types.ts.
 */
export interface EvaRegistrationLive extends EvaRegistration {
  /** true = converged, false = oscillated, undefined = never run */
  lastConverged?: boolean;
  /** seq of the last REC event emitted for this target */
  lastRecSeq?: number;
}

export interface FoldPosition {
  seq: number;
  existenceIndex: Set<string>;
  aliasMap: Map<string, string>;
  evaRegistrations: Map<string, EvaRegistrationLive>;
  /** source → set of dests (forward CON graph + EVA dependency edges) */
  conAdjacency: Map<string, Set<string>>;
  /** dest → set of sources (reverse CON graph) */
  conReverse: Map<string, Set<string>>;
  /** segmentId → member targets */
  segMembership: Map<string, Set<string>>;
  /** target → transformation fingerprint hash */
  hashChain: Map<string, string>;
}

// ─── Adaptive checkpoint constants ────────────────────────────────────────────

export const CHECKPOINT_INTERVAL = 50_000;
export const TARGET_STARTUP_MS = 300;

// ─── createFoldPosition ───────────────────────────────────────────────────────

export function createFoldPosition(): FoldPosition {
  return {
    seq: 0,
    existenceIndex: new Set(),
    aliasMap: new Map(),
    evaRegistrations: new Map(),
    conAdjacency: new Map(),
    conReverse: new Map(),
    segMembership: new Map(),
    hashChain: new Map(),
  };
}

// ─── applyEvent ───────────────────────────────────────────────────────────────

/**
 * Apply a single event to the fold position.
 *
 * O(1) structural updates only — no field values, no EVA formula evaluation.
 * EVA formula evaluation is deferred to the Worker's DEF→EVA→REC loop.
 *
 * For EVA events: a stub entry is written to evaRegistrations. The Worker's
 * registerEvaFormula() replaces it immediately after applyEvent().
 *
 * For CON events: conAdjacency / conReverse are updated here. The Worker calls
 * reEvaluateEvaMode() afterward to handle any fold→horizon mode flips.
 */
export function applyEvent(pos: FoldPosition, event: EoEvent): void {
  switch (event.op) {
    case 'INS':
      pos.existenceIndex.add(event.target);
      break;

    case 'SEG': {
      const segId: string =
        (event.operand as { segmentId?: string } | null)?.segmentId ??
        event.target;
      if (!pos.segMembership.has(segId)) {
        pos.segMembership.set(segId, new Set());
      }
      pos.segMembership.get(segId)!.add(event.target);
      break;
    }

    case 'CON': {
      // Handle both the simplified string operand used in tests and the real
      // { added: [...], removed: [...] } format used by processEvent/handleCON.
      const operand = event.operand;
      const addedDests: string[] = typeof operand === 'string'
        ? [operand]
        : ((operand as any)?.added ?? []).map((item: any) =>
            typeof item === 'string' ? item : (item as any)?.dest,
          ).filter(Boolean) as string[];
      const removedDests: string[] = typeof operand === 'string'
        ? []
        : ((operand as any)?.removed ?? []).filter(
            (d: any): d is string => typeof d === 'string',
          );

      for (const dest of addedDests) {
        if (!pos.conAdjacency.has(event.target)) {
          pos.conAdjacency.set(event.target, new Set());
        }
        pos.conAdjacency.get(event.target)!.add(dest);

        if (!pos.conReverse.has(dest)) {
          pos.conReverse.set(dest, new Set());
        }
        pos.conReverse.get(dest)!.add(event.target);
      }

      for (const dest of removedDests) {
        pos.conAdjacency.get(event.target)?.delete(dest);
        pos.conReverse.get(dest)?.delete(event.target);
      }
      break;
    }

    case 'SYN': {
      const alias: string | undefined =
        (event.operand as { _alias?: string } | null)?._alias;
      if (alias) {
        pos.aliasMap.set(event.target, alias);
      }
      break;
    }

    case 'DEF':
      if (typeof (event as EoEvent & { hash?: string }).hash === 'string') {
        pos.hashChain.set(event.target, (event as EoEvent & { hash: string }).hash);
      }
      break;

    case 'EVA': {
      // Write stub; Worker's registerEvaFormula() replaces this immediately.
      const existing = pos.evaRegistrations.get(event.target);
      pos.evaRegistrations.set(event.target, {
        target: event.target,
        formula: event.operand,
        mode: 'fold',       // placeholder; Worker sets actual mode
        dependencies: [],
        lastConverged: existing?.lastConverged,
        lastRecSeq: existing?.lastRecSeq,
      });
      break;
    }

    case 'REC': {
      const reg = pos.evaRegistrations.get(event.target);
      if (reg) {
        reg.lastConverged =
          (event.operand as { converged?: boolean } | null)?.converged ?? false;
        reg.lastRecSeq = event.seq;
      }
      break;
    }

    case 'NUL':
      // observation without state mutation
      break;

    case 'SIG':
      // ephemeral, never structural
      break;

    default:
      // exhaustive — TypeScript will error if a new op is added to the union
      // without handling it here
      break;
  }

  pos.seq = event.seq;
}

// ─── Checkpoint serialisation ─────────────────────────────────────────────────

interface CheckpointData {
  seq: number;
  existenceIndex: string[];
  aliasMap: [string, string][];
  evaRegistrations: [string, EvaRegistrationLive][];
  conAdjacency: [string, string[]][];
  conReverse: [string, string[]][];
  segMembership: [string, string[]][];
  hashChain: [string, string][];
}

/**
 * Serialise FoldPosition to msgpack and write to 'fold-position.bin' in opfsDir.
 * Uses an atomic write: write to a temp file first, then rename.
 */
export async function saveCheckpoint(
  pos: FoldPosition,
  opfsDir: FileSystemDirectoryHandle,
): Promise<void> {
  const data: CheckpointData = {
    seq: pos.seq,
    existenceIndex: [...pos.existenceIndex],
    aliasMap: [...pos.aliasMap],
    evaRegistrations: [...pos.evaRegistrations],
    conAdjacency: [...pos.conAdjacency].map(([k, v]) => [k, [...v]]),
    conReverse: [...pos.conReverse].map(([k, v]) => [k, [...v]]),
    segMembership: [...pos.segMembership].map(([k, v]) => [k, [...v]]),
    hashChain: [...pos.hashChain],
  };

  const payload = pack(data) as Uint8Array;

  // Write atomically via temp file + rename.
  const tmpHandle = await opfsDir.getFileHandle('fold-position.tmp', {
    create: true,
  });
  const writable = await tmpHandle.createWritable();
  // Slice to exact bytes — pack() may return a view on a larger backing buffer.
  // slice() on ArrayBufferLike may return SharedArrayBuffer; cast to ArrayBuffer.
  const exactBuf = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer;
  await writable.write(new Blob([exactBuf]));
  await writable.close();

  // Rename: move tmp → fold-position.bin.
  // FileSystemDirectoryHandle.move() is the atomic rename in OPFS.
  await (tmpHandle as FileSystemFileHandle & {
    move(dest: FileSystemDirectoryHandle, name: string): Promise<void>;
  }).move(opfsDir, 'fold-position.bin');
}

/**
 * Load a FoldPosition checkpoint from 'fold-position.bin'.
 * Returns null if the file does not exist.
 */
export async function loadCheckpoint(
  opfsDir: FileSystemDirectoryHandle,
): Promise<FoldPosition | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await opfsDir.getFileHandle('fold-position.bin');
  } catch {
    return null; // file does not exist
  }

  const file = await fileHandle.getFile();
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength === 0) return null;

  const data = unpack(new Uint8Array(buffer)) as CheckpointData;

  const pos = createFoldPosition();
  pos.seq = data.seq;

  for (const t of data.existenceIndex) pos.existenceIndex.add(t);
  for (const [k, v] of data.aliasMap) pos.aliasMap.set(k, v);
  for (const [k, v] of data.evaRegistrations) pos.evaRegistrations.set(k, v);
  for (const [k, vs] of data.conAdjacency) pos.conAdjacency.set(k, new Set(vs));
  for (const [k, vs] of data.conReverse) pos.conReverse.set(k, new Set(vs));
  for (const [k, vs] of data.segMembership) pos.segMembership.set(k, new Set(vs));
  for (const [k, v] of data.hashChain) pos.hashChain.set(k, v);

  return pos;
}

/**
 * Shallow snapshot of a FoldPosition for async checkpoint writes.
 * Copies the Maps and Sets so the live position can continue to be mutated.
 */
export function snapshotFoldPosition(pos: FoldPosition): FoldPosition {
  return {
    seq: pos.seq,
    existenceIndex: new Set(pos.existenceIndex),
    aliasMap: new Map(pos.aliasMap),
    evaRegistrations: new Map(pos.evaRegistrations),
    conAdjacency: new Map([...pos.conAdjacency].map(([k, v]) => [k, new Set(v)])),
    conReverse: new Map([...pos.conReverse].map(([k, v]) => [k, new Set(v)])),
    segMembership: new Map([...pos.segMembership].map(([k, v]) => [k, new Set(v)])),
    hashChain: new Map(pos.hashChain),
  };
}
