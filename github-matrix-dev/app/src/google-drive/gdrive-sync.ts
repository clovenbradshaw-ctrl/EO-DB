/**
 * Google Drive sync service — instant op saves + rolling hydration bake.
 *
 * Each operation is saved to Google Drive immediately as an individual
 * op-{seq:08d}.eodb file. When 256 op files accumulate, participating
 * machines "raise their hand" by writing a bake-intent-{userId}.json file
 * to GDrive. The machine with the earliest voted_at timestamp wins and
 * bakes all 256 op files into one hydration-{slot}.eodb file, then deletes
 * the op files. Five hydration slots rotate in a ring (oldest overwritten).
 *
 * Cross-client notification: clients poll GDrive every 15 seconds. On
 * startup, hydration from GDrive is attempted immediately.
 *
 * No Matrix room events are used for coordination — all state lives in Drive.
 */

import type { EoStore } from '../db/encrypted-store';
import type { LocalKeyring } from '../db/crypto-types';
import type { EoEvent } from '../db/types';
import { readLogSince } from '../db/log';
import { encryptSnapshot, decryptSnapshot } from '../crypto/snapshot-crypto';
import { resolveSnapshotKeyId } from '../crypto/segment-keys';
import { packEodb, unpackEodb, type EodbFile } from './eodb-format';
import {
  gdriveList,
  gdriveRetrieve,
  gdriveStoreNamed,
  gdriveListByPrefix,
  gdriveDeleteFile,
  gdriveStoreJson,
} from './gdrive-api';
import { processEvent } from '../db/fold';
import { useGDriveStore } from './gdrive-store';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

/** Fallback GDrive poll interval (used when no external push is available). */
const SYNC_INTERVAL_MS = 15_000;

/** Number of op files on GDrive that triggers a bake. */
const OPS_PER_BAKE = 256;

/** How many hydration slot files to keep (ring buffer). */
const MAX_HYDRATION_SLOTS = 5;

/**
 * Grace period after writing a bake-intent file before checking who won.
 * Gives other machines a chance to also raise their hands.
 */
const BAKE_VOTE_GRACE_MS = 2_000;

/** Intent files older than this are considered expired / abandoned. */
const BAKE_LOCK_TTL_MS = 60_000;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Zero-pad a sequence number to 8 digits for lexicographic sort. */
function seqFileName(seq: number): string {
  return `op-${String(seq).padStart(8, '0')}.eodb`;
}

/** Extract the seq number from an op filename like "op-00000042.eodb". */
function seqFromOpName(name: string): number {
  const m = name.match(/^op-(\d+)\.eodb$/);
  return m ? parseInt(m[1], 10) : -1;
}

/** Sleep for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ──────────────────────────────────────────────────────────────
// Sync service
// ──────────────────────────────────────────────────────────────

export class GDriveSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private destroyed = false;

  /** Local count of op files we have saved since the last bake. */
  private savedOpCount = 0;

  /** Guard: only one bake attempt at a time. */
  private baking = false;

  private store: EoStore;
  private spaceId: string;
  private spaceName: string;
  private userId: string;
  private matrixAccessToken: string;
  private keyring: LocalKeyring;

  /** Callback invoked for each event during hydration (drives UI updates). */
  onEvent?: (event: any) => void;

  /** Called after a successful hydration so the UI can re-init. */
  onHydrated?: () => void;

  /** Callback for UI status updates. */
  onStatus?: (status: 'syncing' | 'synced' | 'error', detail?: string) => void;

  constructor(opts: {
    store: EoStore;
    spaceId: string;
    spaceName: string;
    userId: string;
    matrixAccessToken: string;
    keyring?: LocalKeyring;
    onEvent?: (event: any) => void;
    onHydrated?: () => void;
  }) {
    this.store = opts.store;
    this.spaceId = opts.spaceId;
    this.spaceName = opts.spaceName;
    this.userId = opts.userId;
    this.matrixAccessToken = opts.matrixAccessToken;
    this.keyring = opts.keyring || { keys: new Map() };
    this.onEvent = opts.onEvent;
    this.onHydrated = opts.onHydrated;
  }

  /** Allow updating keyring after construction. */
  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  /** Encrypt binary with keyring if keys are available. */
  private async encryptBinary(binary: Uint8Array): Promise<Uint8Array> {
    const keyId = resolveSnapshotKeyId(this.keyring);
    if (!keyId) return binary;
    return encryptSnapshot(binary, this.keyring, keyId);
  }

  /**
   * Start the sync service.
   * Immediately attempts GDrive hydration, then starts the 15-second poll timer.
   */
  async start(): Promise<void> {
    if (this.timer) return;

    const savedOpCount: number = (await this.store.get('meta:gdrive_saved_op_count')) || 0;
    this.savedOpCount = savedOpCount;

    // Hydrate from GDrive immediately on startup — do not wait for the first poll.
    const dataType = `eodb-${this.spaceId}`;
    try {
      this.onStatus?.('syncing');
      const hydratedSeq = await GDriveSyncService.hydrateFromGDrive(
        this.store, this.matrixAccessToken, dataType, this.onEvent, this.keyring,
      );
      if (hydratedSeq > 0) {
        this.onHydrated?.();
        console.log(`[EO-DB] GDrive startup hydration: reached seq ${hydratedSeq}`);
      }
      this.onStatus?.('synced');
    } catch (e) {
      console.warn('[EO-DB] GDrive startup hydration failed:', e);
      this.onStatus?.('error', e instanceof Error ? e.message : String(e));
    }

    // Start the 15-second fallback poll timer.
    this.timer = setInterval(() => {
      if (!this.syncing && !this.destroyed) {
        this.syncCycle().catch(console.warn);
      }
    }, SYNC_INTERVAL_MS);
  }

  /** Stop the sync timer and mark as destroyed. */
  stop(): void {
    this.destroyed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Save a single operation to Google Drive immediately.
   * Call this right after committing an event to the local store.
   * Fire-and-forget (errors are logged, not thrown).
   */
  async saveOp(event: EoEvent): Promise<void> {
    if (this.destroyed) return;
    const dataType = `eodb-${this.spaceId}`;
    try {
      const opFile: EodbFile = {
        version: 1,
        type: 'op',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: event.seq,
        to_seq: event.seq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events: [event],
        prev_snapshots: [],
      };
      const binary = packEodb(opFile);
      const encrypted = await this.encryptBinary(binary);
      const fileName = seqFileName(event.seq);
      await gdriveStoreNamed(this.matrixAccessToken, encrypted, dataType, fileName);
      this.savedOpCount += 1;
      await this.store.put('meta:gdrive_saved_op_count', this.savedOpCount);
      console.log(`[EO-DB] GDrive op saved: ${fileName} (${this.savedOpCount}/${OPS_PER_BAKE})`);

      if (this.savedOpCount >= OPS_PER_BAKE && !this.baking) {
        // Raise hand — fire and forget
        this.raiseBakeHand().catch(console.warn);
      }
    } catch (e) {
      console.warn('[EO-DB] GDrive saveOp failed (op will be captured in next bake):', e);
    }
  }

  /**
   * "Raise hand" to volunteer as the bake winner.
   * Writes a bake-intent file to GDrive, waits briefly, then checks if we won.
   */
  private async raiseBakeHand(): Promise<void> {
    if (this.baking || this.destroyed) return;
    const dataType = `eodb-${this.spaceId}`;
    const intentFileName = `bake-intent-${this.userId}.json`;
    const votedAt = new Date().toISOString();

    try {
      // Write our intent to GDrive.
      await gdriveStoreJson(this.matrixAccessToken, dataType, intentFileName, {
        voter: this.userId,
        voted_at: votedAt,
        op_count: this.savedOpCount,
      });
      console.log(`[EO-DB] GDrive bake hand raised: ${intentFileName}`);

      // Wait for other machines to also raise their hands.
      await sleep(BAKE_VOTE_GRACE_MS);

      // List all intent files and find the earliest voter.
      const { entries } = await gdriveListByPrefix(this.matrixAccessToken, dataType, 'bake-intent-');
      const now = Date.now();
      const validIntents: Array<{ voter: string; voted_at: string; fileId: string }> = [];

      for (const entry of entries) {
        try {
          // Download each intent file to read its voted_at timestamp.
          // Use gdriveRetrieve which already handles the proxy download.
          const result = await gdriveRetrieve(this.matrixAccessToken, entry.content_hash);
          if (!result.ok || !result.envelope) continue;

          let parsed: Record<string, unknown>;
          if (result.envelope instanceof Uint8Array) {
            parsed = JSON.parse(new TextDecoder().decode(result.envelope));
          } else if (typeof result.envelope === 'string') {
            parsed = JSON.parse(result.envelope);
          } else {
            parsed = result.envelope as Record<string, unknown>;
          }

          const intentTime = new Date(parsed.voted_at as string).getTime();
          if (now - intentTime > BAKE_LOCK_TTL_MS) continue; // expired

          validIntents.push({
            voter: parsed.voter as string,
            voted_at: parsed.voted_at as string,
            fileId: entry.data_id,
          });
        } catch {
          // Skip unreadable intent files
        }
      }

      if (validIntents.length === 0) {
        // No valid intents found; proceed anyway as we know we have ops.
        await this.bakeHydrationFile(dataType, []);
        return;
      }

      // Sort by voted_at ascending — earliest wins.
      validIntents.sort((a, b) =>
        new Date(a.voted_at).getTime() - new Date(b.voted_at).getTime(),
      );

      const winner = validIntents[0];
      if (winner.voter !== this.userId) {
        // Someone else won — clean up our intent and stand down.
        console.log(`[EO-DB] GDrive bake: ${winner.voter} won, standing down`);
        try {
          const myEntry = entries.find(e => e.name === intentFileName);
          if (myEntry) await gdriveDeleteFile(this.matrixAccessToken, myEntry.data_id);
        } catch { /* non-critical */ }
        // Reset savedOpCount so we re-trigger next time ops accumulate.
        this.savedOpCount = 0;
        await this.store.put('meta:gdrive_saved_op_count', 0);
        return;
      }

      // We won — perform the bake.
      const intentFileIds = validIntents.map(i => i.fileId);
      await this.bakeHydrationFile(dataType, intentFileIds);
    } catch (e) {
      console.warn('[EO-DB] GDrive raise-hand failed:', e);
      this.baking = false;
    }
  }

  /**
   * Bake all current op files into one hydration slot file, then delete the op files.
   * @param intentFileIds Drive file IDs of all bake-intent files to clean up after baking.
   */
  private async bakeHydrationFile(dataType: string, intentFileIds: string[]): Promise<void> {
    if (this.baking) return;
    this.baking = true;
    console.log('[EO-DB] GDrive bake: starting hydration file creation');

    try {
      // List all op files on GDrive.
      const { entries: opEntries } = await gdriveListByPrefix(
        this.matrixAccessToken, dataType, 'op-',
      );

      if (opEntries.length === 0) {
        console.log('[EO-DB] GDrive bake: no op files found, aborting');
        return;
      }

      // Sort by filename (lexicographic = seq order).
      opEntries.sort((a, b) => a.name.localeCompare(b.name));

      // Download and decrypt all op files.
      const allEvents: EoEvent[] = [];
      const downloadedFileIds: string[] = [];

      for (const entry of opEntries) {
        try {
          const result = await gdriveRetrieve(this.matrixAccessToken, entry.content_hash);
          if (!result.ok || !result.envelope) continue;

          let raw: Uint8Array;
          if (result.envelope instanceof Uint8Array) {
            raw = result.envelope;
          } else {
            continue;
          }

          const data = this.keyring ? await decryptSnapshot(raw, this.keyring).catch(() => raw) : raw;
          const eodb = unpackEodb(data);
          allEvents.push(...eodb.events);
          downloadedFileIds.push(entry.data_id);
        } catch (e) {
          console.warn('[EO-DB] GDrive bake: failed to download op file', entry.name, e);
        }
      }

      if (allEvents.length === 0) {
        console.log('[EO-DB] GDrive bake: no events decoded, aborting');
        return;
      }

      // Deduplicate and sort by seq.
      const seen = new Set<number>();
      const events = allEvents
        .filter(e => { if (seen.has(e.seq)) return false; seen.add(e.seq); return true; })
        .sort((a, b) => a.seq - b.seq);

      const fromSeq = events[0].seq;
      const toSeq = events[events.length - 1].seq;

      // Determine the next hydration slot (1..MAX_HYDRATION_SLOTS, rotating).
      const currentSlot: number = (await this.store.get('meta:gdrive_hydration_slot')) || 0;
      const nextSlot = (currentSlot % MAX_HYDRATION_SLOTS) + 1;

      // Pack and encrypt the hydration file.
      const hydrationFile: EodbFile = {
        version: 1,
        type: 'hydration',
        space_id: this.spaceId,
        space_name: this.spaceName,
        from_seq: fromSeq,
        to_seq: toSeq,
        created_by: this.userId,
        created_at: new Date().toISOString(),
        events,
        prev_snapshots: [],
      };

      const binary = packEodb(hydrationFile);
      const encrypted = await this.encryptBinary(binary);
      const hydrationFileName = `hydration-${nextSlot}.eodb`;

      await gdriveStoreNamed(this.matrixAccessToken, encrypted, dataType, hydrationFileName);
      console.log(`[EO-DB] GDrive bake: wrote ${hydrationFileName} (seq ${fromSeq}→${toSeq}, ${events.length} events)`);

      // Persist the new slot index.
      await this.store.put('meta:gdrive_hydration_slot', nextSlot);
      await this.store.put('meta:gdrive_consolidated_seq', toSeq);

      // Delete all op files that were successfully downloaded.
      for (const fileId of downloadedFileIds) {
        try {
          await gdriveDeleteFile(this.matrixAccessToken, fileId);
        } catch { /* non-critical */ }
      }

      // Clean up all bake-intent files (ours and others).
      for (const fileId of intentFileIds) {
        try {
          await gdriveDeleteFile(this.matrixAccessToken, fileId);
        } catch { /* non-critical */ }
      }
      // Also delete our own intent file if not already in intentFileIds.
      try {
        const intentFileName = `bake-intent-${this.userId}.json`;
        const { entries: intentEntries } = await gdriveListByPrefix(
          this.matrixAccessToken, dataType, 'bake-intent-',
        );
        for (const e of intentEntries) {
          if (e.name === intentFileName || intentFileIds.includes(e.data_id)) continue;
          await gdriveDeleteFile(this.matrixAccessToken, e.data_id).catch(() => {});
        }
      } catch { /* non-critical */ }

      // Reset local op counter.
      this.savedOpCount = 0;
      await this.store.put('meta:gdrive_saved_op_count', 0);

      useGDriveStore.getState().recordSync(this.spaceId);
      this.onStatus?.('synced');
      console.log(`[EO-DB] GDrive bake complete: hydration-${nextSlot}.eodb`);
    } finally {
      this.baking = false;
    }
  }

  /**
   * 15-second poll cycle — pulls any new data from GDrive.
   */
  private async syncCycle(): Promise<void> {
    if (this.syncing || this.destroyed) return;
    this.syncing = true;
    this.onStatus?.('syncing');
    try {
      await this.pullFromGDrive();
      this.onStatus?.('synced');
    } catch (e: any) {
      console.warn('[EO-DB] GDrive sync cycle failed:', e);
      this.onStatus?.('error', e.message);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Pull any newer data from GDrive into the local store.
   * Called on startup and every 15 seconds.
   */
  private async pullFromGDrive(): Promise<void> {
    const dataType = `eodb-${this.spaceId}`;
    const localSeq = await this.store.getCurrentSeq();

    // Find the best hydration file (highest to_seq).
    const { entries: hydrationEntries } = await gdriveListByPrefix(
      this.matrixAccessToken, dataType, 'hydration-',
    );

    let afterSeq = localSeq;

    if (hydrationEntries.length > 0) {
      // We need to peek inside each to find the one with the highest to_seq.
      // As an optimisation, download the smallest-named one first (slot 1 might
      // be the oldest) — but we have no metadata without downloading. So we
      // just try each and track the best.
      let bestSeq = localSeq;
      let bestEntry: typeof hydrationEntries[0] | null = null;

      for (const entry of hydrationEntries) {
        try {
          const result = await gdriveRetrieve(this.matrixAccessToken, entry.content_hash);
          if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
          const data = await decryptSnapshot(result.envelope, this.keyring).catch(() => result.envelope as Uint8Array);
          const eodb = unpackEodb(data);
          if (eodb.to_seq > bestSeq) {
            bestSeq = eodb.to_seq;
            bestEntry = entry;
          }
        } catch { /* skip unreadable */ }
      }

      if (bestEntry && bestSeq > localSeq) {
        console.log(`[EO-DB] GDrive pull: applying hydration file ${bestEntry.name} (to_seq=${bestSeq})`);
        const result = await gdriveRetrieve(this.matrixAccessToken, bestEntry.content_hash);
        if (result.ok && result.envelope instanceof Uint8Array) {
          const data = await decryptSnapshot(result.envelope, this.keyring).catch(() => result.envelope as Uint8Array);
          const eodb = unpackEodb(data);
          for (const event of eodb.events) {
            if (event.seq <= localSeq) continue;
            await processEvent(this.store, event, this.onEvent);
          }
          afterSeq = bestSeq;
          this.onHydrated?.();
        }
      }
    }

    // Apply any op files newer than afterSeq.
    const { entries: opEntries } = await gdriveListByPrefix(
      this.matrixAccessToken, dataType, 'op-',
    );

    const newOps = opEntries
      .filter(e => seqFromOpName(e.name) > afterSeq)
      .sort((a, b) => seqFromOpName(a.name) - seqFromOpName(b.name));

    for (const entry of newOps) {
      try {
        const result = await gdriveRetrieve(this.matrixAccessToken, entry.content_hash);
        if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
        const data = await decryptSnapshot(result.envelope, this.keyring).catch(() => result.envelope as Uint8Array);
        const eodb = unpackEodb(data);
        for (const event of eodb.events) {
          if (event.seq <= afterSeq) continue;
          await processEvent(this.store, event, this.onEvent);
          afterSeq = Math.max(afterSeq, event.seq);
        }
      } catch (e) {
        console.warn('[EO-DB] GDrive pull: failed to apply op', entry.name, e);
      }
    }

    if (afterSeq > localSeq) {
      console.log(`[EO-DB] GDrive pull: advanced local seq from ${localSeq} to ${afterSeq}`);
      useGDriveStore.getState().recordSync(this.spaceId);
    }
  }

  /**
   * Trigger an immediate GDrive poll outside the 15-second timer.
   * Call this from UI actions or when an external signal arrives.
   */
  triggerImmediateCheck(): void {
    if (!this.syncing && !this.destroyed) {
      this.syncCycle().catch(console.warn);
    }
  }

  /** Force an immediate save of pending state (used by UI "Save now" buttons). */
  async forceSave(): Promise<void> {
    if (this.destroyed) return;
    this.triggerImmediateCheck();
  }

  // ──────────────────────────────────────────────────────────
  // Static hydration (new device / second client startup)
  // ──────────────────────────────────────────────────────────

  /**
   * Hydrate a store from Google Drive.
   *
   * Priority order:
   * 1. hydration-*.eodb files (new format) — highest to_seq wins
   * 2. Legacy {hash}.eodb consolidated backup (backward compat)
   * 3. op-*.eodb files newer than the hydration point
   *
   * Returns the final seq after hydration.
   */
  static async hydrateFromGDrive(
    store: EoStore,
    matrixAccessToken: string,
    dataType: string,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
  ): Promise<number> {
    console.log('[EO-DB] hydrateFromGDrive: starting, dataType =', dataType);

    const localSeq = await store.getCurrentSeq();
    let lastAppliedSeq = localSeq;

    const decrypt = async (raw: Uint8Array): Promise<Uint8Array> => {
      if (!keyring) return raw;
      return decryptSnapshot(raw, keyring).catch(() => raw);
    };

    // ── 1. Try new hydration-*.eodb files ──
    const { entries: hydrationEntries } = await gdriveListByPrefix(
      matrixAccessToken, dataType, 'hydration-',
    ).catch(() => ({ entries: [] as import('./gdrive-api').GDriveListEntry[] }));

    let bestHydrationSeq = localSeq;

    for (const entry of hydrationEntries) {
      try {
        console.log(`[EO-DB] hydrateFromGDrive: downloading ${entry.name}…`);
        const result = await gdriveRetrieve(matrixAccessToken, entry.content_hash);
        if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
        const data = await decrypt(result.envelope);
        const eodb = unpackEodb(data);
        if (eodb.to_seq <= bestHydrationSeq) continue;

        console.log(`[EO-DB] hydrateFromGDrive: applying ${entry.name} (${eodb.events.length} events, to_seq=${eodb.to_seq})`);
        for (const event of eodb.events) {
          if (event.seq <= localSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }
        bestHydrationSeq = eodb.to_seq;
      } catch (e) {
        console.warn('[EO-DB] hydrateFromGDrive: failed to apply hydration file', entry.name, e);
      }
    }

    // ── 2. Fallback: legacy {hash}.eodb consolidated backup ──
    if (bestHydrationSeq === localSeq) {
      const listing = await gdriveList(matrixAccessToken, dataType).catch(() => ({ entries: [] }));
      const legacyEntries = listing.entries
        .filter(e => !e.name.startsWith('op-') && !e.name.startsWith('hydration-') && !e.name.startsWith('bake-intent-'))
        .sort((a, b) => new Date(b.stored_at).getTime() - new Date(a.stored_at).getTime());

      for (const entry of legacyEntries) {
        try {
          console.log(`[EO-DB] hydrateFromGDrive: trying legacy file ${entry.name}…`);
          const result = await gdriveRetrieve(matrixAccessToken, entry.content_hash);
          if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
          const data = await decrypt(result.envelope);
          const eodb = unpackEodb(data);
          for (const event of eodb.events) {
            if (event.seq <= localSeq) continue;
            const seq = await processEvent(store, event, onEvent);
            lastAppliedSeq = Math.max(lastAppliedSeq, seq);
          }
          if (lastAppliedSeq > localSeq) {
            bestHydrationSeq = lastAppliedSeq;
            break;
          }
        } catch (e) {
          console.warn('[EO-DB] hydrateFromGDrive: failed to apply legacy file', entry.name, e);
        }
      }
    }

    // ── 3. Apply op files newer than the hydration point ──
    const { entries: opEntries } = await gdriveListByPrefix(
      matrixAccessToken, dataType, 'op-',
    ).catch(() => ({ entries: [] as import('./gdrive-api').GDriveListEntry[] }));

    const newOps = opEntries
      .filter(e => seqFromOpName(e.name) > bestHydrationSeq)
      .sort((a, b) => seqFromOpName(a.name) - seqFromOpName(b.name));

    for (const entry of newOps) {
      try {
        console.log(`[EO-DB] hydrateFromGDrive: applying op ${entry.name}…`);
        const result = await gdriveRetrieve(matrixAccessToken, entry.content_hash);
        if (!result.ok || !(result.envelope instanceof Uint8Array)) continue;
        const data = await decrypt(result.envelope);
        const eodb = unpackEodb(data);
        for (const event of eodb.events) {
          if (event.seq <= lastAppliedSeq) continue;
          const seq = await processEvent(store, event, onEvent);
          lastAppliedSeq = Math.max(lastAppliedSeq, seq);
        }
      } catch (e) {
        console.warn('[EO-DB] hydrateFromGDrive: failed to apply op file', entry.name, e);
      }
    }

    console.log(`[EO-DB] hydrateFromGDrive: complete. Applied up to seq ${lastAppliedSeq} (was ${localSeq})`);
    return lastAppliedSeq;
  }
}
