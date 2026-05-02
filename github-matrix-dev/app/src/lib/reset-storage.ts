/**
 * Crash-recovery wipe.
 *
 * If a sync (Airtable, peer, etc.) writes more data into OPFS than the device
 * can fit into a single in-memory snapshot, every subsequent page load tries
 * to re-load the same oversized state and crashes before any UI is reachable.
 * The user is locked out of the very settings panel that would let them clear
 * the cache.
 *
 * `resetLocalStorage()` is the escape hatch: it nukes the on-disk state that
 * the boot path tries to load, without ever instantiating React or touching
 * the fold worker. It is invoked pre-render from `main.tsx` when the URL
 * hash matches `#/reset-storage`.
 *
 * Scope:
 *   - OPFS root, recursively: every `space.<id>/` subdir plus any top-level
 *     log/snapshot/checkpoint files used by local-mode.
 *   - Matrix crypto IndexedDB databases: stale device-id state that survives
 *     OPFS wipes would otherwise cause login failures on the next session.
 *
 * Out of scope (intentional):
 *   - localStorage: holds the OAuth refresh token, theme, the
 *     `eo-selected-space` pointer. None of these can be 500 MB and removing
 *     them logs the user out unnecessarily.
 *   - The encrypted-store IndexedDB databases. These hold per-space metadata
 *     that's small (cursors, sync log, hydration checkpoint). Leaving them
 *     intact is fine because the OPFS wipe drops the events those metas
 *     describe — on the next run, the metas point to a fresh empty log and
 *     a re-sync re-derives them.
 */

const OPFS_FILES_TO_REMOVE = [
  // Local-mode (no spaceId) writes these directly under the OPFS root.
  // Worker-managed; safe to delete while no worker is running.
  'eodb.idx',
  'eodb.pay',
  'log.bin',
  'kv-snapshot.bin',
  'kv-snapshot.tmp',
  'fold-position.bin',
  'init-cache.bin',
];

export interface ResetReport {
  spacesRemoved: number;
  rootFilesRemoved: number;
  cryptoDbsRemoved: number;
  errors: string[];
}

export async function resetLocalStorage(): Promise<ResetReport> {
  const report: ResetReport = {
    spacesRemoved: 0,
    rootFilesRemoved: 0,
    cryptoDbsRemoved: 0,
    errors: [],
  };

  // ── OPFS ────────────────────────────────────────────────────────────────
  try {
    const root = await navigator.storage.getDirectory();

    // Iterate every entry in the root and remove anything that matches a
    // known EO-DB artifact. We avoid `for await` on a typed handle because
    // the `entries()` async iterator isn't in the lib.dom typings yet.
    const entries: AsyncIterable<[string, FileSystemHandle]> = (
      root as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
    ).entries();

    for await (const [name] of entries) {
      const isSpaceDir = name.startsWith('space.');
      const isKnownRootFile = OPFS_FILES_TO_REMOVE.includes(name);
      if (!isSpaceDir && !isKnownRootFile) continue;
      try {
        await root.removeEntry(name, { recursive: true });
        if (isSpaceDir) report.spacesRemoved++;
        else report.rootFilesRemoved++;
      } catch (e) {
        report.errors.push(`opfs:${name}: ${describe(e)}`);
      }
    }
  } catch (e) {
    report.errors.push(`opfs:root: ${describe(e)}`);
  }

  // ── Matrix crypto IndexedDB ─────────────────────────────────────────────
  // Mirrors the deletion list in components/Layout.tsx — keeping the two in
  // sync matters because logout() deletes these on the way out, but a crashed
  // app never reaches logout. Without this, a user who recovers via
  // #/reset-storage and then logs back in hits a device-id mismatch.
  try {
    const dbs = await indexedDB.databases();
    const targets = dbs
      .map((d) => d.name)
      .filter(
        (n): n is string =>
          typeof n === 'string' &&
          (n.includes('matrix') || n.includes('rust-crypto')),
      );
    await Promise.all(
      targets.map(
        (name) =>
          new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => {
              report.cryptoDbsRemoved++;
              resolve();
            };
            req.onerror = () => {
              report.errors.push(`idb:${name}: deleteDatabase errored`);
              resolve();
            };
            // Blocked means another tab still has the DB open. Resolve so the
            // overall reset doesn't hang forever — the user can close other
            // tabs and re-run the reset URL if it matters.
            req.onblocked = () => {
              report.errors.push(`idb:${name}: blocked by another tab`);
              resolve();
            };
          }),
      ),
    );
  } catch (e) {
    report.errors.push(`idb: ${describe(e)}`);
  }

  return report;
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * The hash that triggers `resetLocalStorage()` in `main.tsx`. Defined here
 * so the route shape lives next to the implementation it gates.
 */
export const RESET_STORAGE_HASH = '#/reset-storage';
