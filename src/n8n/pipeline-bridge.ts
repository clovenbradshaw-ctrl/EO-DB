/**
 * Pipeline bridge — wires n8n webhook storage into the EO-DB lifecycle.
 *
 * Works alongside Filen: Filen handles real-time file watching,
 * n8n handles encrypted blob storage via a single POST endpoint
 * with action-based routing (store / retrieve / list).
 *
 * Usage:
 *   const bridge = new N8nPipelineBridge(matrixClient, roomId, keyring);
 *
 *   // Store a snapshot
 *   await bridge.storeSnapshot(packedBinary, seq, agent, token);
 *
 *   // Retrieve latest snapshot
 *   const data = await bridge.getLatestSnapshot(token);
 *
 *   // Store an event batch
 *   await bridge.storeEventBatch(events, seqRange, agent, token);
 *
 *   // List everything stored
 *   const all = bridge.listStored();
 */

import type { IMatrixClient, IRoom } from '../matrix/types.js';
import type { LocalKeyring } from '../db/crypto-types.js';
import type { EoEvent } from '../db/types.js';
import type { ManifestEntry, ManifestDataType, DriveChangeNotification } from './types.js';
import {
  storeViaN8n,
  storeBinaryViaN8n,
  retrieveViaN8n,
  retrieveBinaryViaN8n,
  listViaN8n,
} from './webhook-client.js';
import {
  publishManifest,
  getLatestManifest,
  listManifestEntries,
  tombstoneManifest,
} from './matrix-manifest.js';

export class N8nPipelineBridge {
  constructor(
    private client: IMatrixClient,
    private roomId: string,
    private keyring: LocalKeyring,
    /** EO target path root for key resolution (e.g. "app.space1"). */
    private targetRoot: string,
  ) {}

  // ─── Snapshots ─────────────────────────────────────────────────────────

  /**
   * Encrypt and store a binary snapshot via n8n, then publish the
   * manifest to the Matrix room.
   */
  async storeSnapshot(
    binary: Uint8Array,
    seqRange: { from: number; to: number },
    agent: string,
    matrixToken: string,
    label?: string,
  ): Promise<ManifestEntry> {
    const { manifest } = await storeBinaryViaN8n(binary, this.keyring, {
      target: this.targetRoot,
      dataType: 'snapshot',
      label: label ?? `snapshot seq ${seqRange.from}–${seqRange.to}`,
      agent,
      seqRange,
      matrixToken,
    });

    await publishManifest(this.client, this.roomId, manifest);
    return manifest;
  }

  /**
   * Retrieve the latest snapshot from n8n (the Matrix room tells us which one).
   */
  async getLatestSnapshot(
    matrixToken: string,
  ): Promise<{ binary: Uint8Array; manifest: ManifestEntry } | null> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return null;

    const manifest = getLatestManifest(room, 'snapshot');
    if (!manifest) return null;

    const binary = await retrieveBinaryViaN8n(manifest, this.keyring, matrixToken);
    return { binary, manifest };
  }

  // ─── Event Batches ─────────────────────────────────────────────────────

  /**
   * Store a batch of EO events via n8n (encrypted).
   */
  async storeEventBatch(
    events: EoEvent[],
    seqRange: { from: number; to: number },
    agent: string,
    matrixToken: string,
  ): Promise<ManifestEntry> {
    const { manifest } = await storeViaN8n(events, this.keyring, {
      target: this.targetRoot,
      dataType: 'event-batch',
      label: `events seq ${seqRange.from}–${seqRange.to}`,
      agent,
      seqRange,
      matrixToken,
    });

    await publishManifest(this.client, this.roomId, manifest);
    return manifest;
  }

  /**
   * Retrieve an event batch by manifest entry.
   */
  async getEventBatch(
    manifest: ManifestEntry,
    matrixToken: string,
  ): Promise<EoEvent[]> {
    return (await retrieveViaN8n(manifest, this.keyring, matrixToken)) as EoEvent[];
  }

  // ─── Import Archives ───────────────────────────────────────────────────

  /**
   * Store an import archive (e.g. Airtable full sync payload).
   */
  async storeImportArchive(
    data: unknown,
    agent: string,
    matrixToken: string,
    label?: string,
  ): Promise<ManifestEntry> {
    const { manifest } = await storeViaN8n(data, this.keyring, {
      target: this.targetRoot,
      dataType: 'import-archive',
      label: label ?? 'import archive',
      agent,
      matrixToken,
    });

    await publishManifest(this.client, this.roomId, manifest);
    return manifest;
  }

  // ─── Attachments ───────────────────────────────────────────────────────

  /**
   * Store an arbitrary binary attachment (document, image, etc.).
   */
  async storeAttachment(
    binary: Uint8Array,
    agent: string,
    matrixToken: string,
    label?: string,
  ): Promise<ManifestEntry> {
    const { manifest } = await storeBinaryViaN8n(binary, this.keyring, {
      target: this.targetRoot,
      dataType: 'attachment',
      agent,
      label,
      matrixToken,
    });

    await publishManifest(this.client, this.roomId, manifest);
    return manifest;
  }

  /**
   * Retrieve an attachment by manifest.
   */
  async getAttachment(
    manifest: ManifestEntry,
    matrixToken: string,
  ): Promise<Uint8Array> {
    return retrieveBinaryViaN8n(manifest, this.keyring, matrixToken);
  }

  // ─── Queries (read from Matrix room state — no network) ────────────────

  /**
   * List all manifest entries, optionally filtered by type.
   * This reads from the Matrix room state — the room IS the index.
   */
  listStored(filterType?: ManifestDataType): ManifestEntry[] {
    const room = this.client.getRoom(this.roomId);
    if (!room) return [];
    return listManifestEntries(room, filterType);
  }

  /**
   * Get the latest entry for a given data type.
   */
  getLatest(dataType: ManifestDataType): ManifestEntry | null {
    const room = this.client.getRoom(this.roomId);
    if (!room) return null;
    return getLatestManifest(room, dataType);
  }

  /**
   * Tombstone (soft-delete) a manifest entry.
   */
  async tombstone(dataId: string, reason?: string): Promise<void> {
    await tombstoneManifest(this.client, this.roomId, dataId, reason);
  }

  // ─── Remote listing (queries n8n / Google Drive directly) ──────────────

  /**
   * List blobs stored in n8n's Google Drive backend.
   * Useful for reconciliation against the Matrix manifest.
   */
  async listRemote(matrixToken: string, filterType?: ManifestDataType) {
    return listViaN8n(matrixToken, filterType);
  }

  // ─── Drive Change Handling ─────────────────────────────────────────────

  /** Matrix event type emitted by the n8n Drive Watcher workflow. */
  static readonly DRIVE_CHANGE_EVENT = 'eo.n8n.drive.change';

  /**
   * Parse a Drive change notification from a Matrix event.
   * Call this from your Matrix sync handler when you see an
   * event of type `eo.n8n.drive.change`.
   */
  static parseDriveChange(eventContent: Record<string, any>): DriveChangeNotification {
    return eventContent as unknown as DriveChangeNotification;
  }
}
