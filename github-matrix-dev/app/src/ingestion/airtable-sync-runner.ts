/**
 * In-process gate around every Airtable-side sync. Every caller — the
 * continuous tick, the manual "Run sync" buttons, and resumable hydration
 * — funnels through `runAirtableSync` so two paths can never fold into the
 * same EoStore at once.
 *
 * Why a separate gate instead of relying on the existing locks?
 *
 *   - `eo.airtable.head` (Matrix room state) and the to-device lock signal
 *     coordinate ACROSS devices. They don't help when two surfaces on the
 *     same tab fire at once: the continuous service's tick + a manual
 *     "Run Test Sync" click + a "Resumable hydration" click are all the
 *     same agent, same device, same head claim.
 *   - `foldMutex` (db/fold.ts) serializes individual processEvent calls,
 *     not whole hydration runs. Two hydrations interleaved at page
 *     granularity still trample each other's cursor writes and waste the
 *     Airtable rate budget.
 *
 * The contract:
 *   - `runAirtableSync(label, fn)` runs `fn` if no other sync is active,
 *     or rejects with a `BUSY` `SyncBusyError` if one is.
 *   - `awaitCurrentSync()` resolves once the active run (if any) finishes,
 *     letting passive surfaces (like the continuous tick) defer instead
 *     of throwing.
 *   - The gate is local to the JS realm. It does NOT replace the existing
 *     cross-device locks — those still apply on top.
 */

export class SyncBusyError extends Error {
  readonly code = 'BUSY' as const;
  constructor(public readonly active: string, requested: string) {
    super(`Airtable sync already active ("${active}") — ignoring request for "${requested}"`);
    this.name = 'SyncBusyError';
  }
}

interface ActiveSync {
  label: string;
  startedAt: number;
  promise: Promise<unknown>;
}

let active: ActiveSync | null = null;

/**
 * Acquire the gate, run `fn`, release the gate. Rejects synchronously with
 * `SyncBusyError` if another sync is already active.
 *
 * `label` is a short identifier for diagnostics ("continuous-tick",
 * "manual-hydrate", "resumable-hydrate", etc.) and shows up in the error
 * message when a second caller is rejected.
 */
export async function runAirtableSync<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (active) {
    throw new SyncBusyError(active.label, label);
  }
  // Reserve the slot before invoking `fn` so a synchronous re-entrant call
  // (during e.g. a synchronous progress callback) sees the gate closed.
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  active = { label, startedAt: Date.now(), promise: done };
  try {
    return await fn();
  } finally {
    active = null;
    resolveDone();
  }
}

/**
 * If a sync is in flight, return its completion promise (success-or-fail).
 * Otherwise resolve immediately. Use this from passive surfaces that want
 * to defer rather than fail when the gate is held.
 */
export function awaitCurrentSync(): Promise<void> {
  if (!active) return Promise.resolve();
  return active.promise.then(() => {}, () => {});
}

/** Diagnostic: which run currently holds the gate, if any. */
export function activeSyncLabel(): string | null {
  return active ? active.label : null;
}
