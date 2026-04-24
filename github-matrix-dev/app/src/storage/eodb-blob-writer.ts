/**
 * Proactive writer that pushes the room's integral log to the n8n
 * encrypted-blob webhook. Coordinates across devices via the existing
 * snapshot-claim lease (Matrix room state), so the single-file
 * overwrite-on-write contract at the server is safe under concurrent writers.
 *
 * Trigger: debounce on local log growth (10s idle) + 5-minute heartbeat
 * whenever there are events newer than the last successful save.
 */

import type { MatrixClient } from 'matrix-js-sdk';
import { pack } from 'msgpackr';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { readLogSince } from '../db/log';
import { bufferToBase64, getKeyById, resolveSnapshotKeyId } from '../crypto/segment-keys';
import {
  recordSnapshotClaimResult,
  setSnapshotStateEvent,
  tryClaimSnapshotLease,
} from '../matrix/snapshot';
import { EODB_BLOB_ENDPOINT, eodbBlobDataIdForRoom } from './eodb-blob-endpoint';

const DEBOUNCE_MS = 10_000;
const HEARTBEAT_MS = 5 * 60_000;
const POST_TIMEOUT_MS = 20_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface BlobWriterStatus {
  enabled: boolean;
  lastSeqSeen: number;
  lastSavedSeq: number | null;
  lastSaveAt: number | null;
  lastError: string | null;
  lastDiagnostic: string | null;
  inFlight: boolean;
  pendingCount: number;
  backoffUntil: number | null;
  consecutiveFailures: number;
}

export type BlobWriterStatusListener = (status: BlobWriterStatus) => void;

export interface BlobWriterDeps {
  client: MatrixClient;
  roomId: string;
  matrixToken: string;
  keyring: LocalKeyring;
  store: EoStore;
  userId: string;
  deviceId: string;
}

interface BlobEnvelope {
  v: 1;
  iv: string;
  ct: string;
  content_hash: string;
  key_id: string;
  plaintext_size: number;
}

interface EodbBlobPayload {
  version: 1;
  room_id: string;
  to_seq: number;
  ts: string;
  created_by: string;
  events: EoEvent[];
}

export class EodbBlobWriter {
  private deps: BlobWriterDeps;
  private started = false;
  private stopped = false;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private lastSeqSeen = 0;
  private lastSavedSeq: number | null = null;
  private lastSaveAt: number | null = null;
  private lastError: string | null = null;
  private lastDiagnostic: string | null = null;
  private inFlight = false;
  private backoffUntil: number | null = null;
  private consecutiveFailures = 0;

  private listeners = new Set<BlobWriterStatusListener>();

  constructor(deps: BlobWriterDeps) {
    this.deps = deps;
  }

  updateDeps(partial: Partial<BlobWriterDeps>): void {
    this.deps = { ...this.deps, ...partial };
  }

  subscribe(listener: BlobWriterStatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => { this.listeners.delete(listener); };
  }

  status(): BlobWriterStatus {
    return {
      enabled: this.started && !this.stopped,
      lastSeqSeen: this.lastSeqSeen,
      lastSavedSeq: this.lastSavedSeq,
      lastSaveAt: this.lastSaveAt,
      lastError: this.lastError,
      lastDiagnostic: this.lastDiagnostic,
      inFlight: this.inFlight,
      pendingCount: Math.max(0, this.lastSeqSeen - (this.lastSavedSeq ?? 0)),
      backoffUntil: this.backoffUntil,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private emit(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (e) { console.warn('[EO-DB blob-writer] listener threw:', e); }
    }
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.heartbeatTimer = setInterval(() => {
      void this.tick();
    }, HEARTBEAT_MS);
    // Kick off an initial tick so a device that came online with pending
    // events saves promptly instead of waiting for the first heartbeat.
    void this.tick();
    this.emit();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.emit();
  }

  /** Called after every local append (observer on eo-store lastSeq). */
  notifyDirty(seq: number): void {
    if (!this.started || this.stopped) return;
    if (seq <= this.lastSeqSeen) return;
    this.lastSeqSeen = seq;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.tick();
    }, DEBOUNCE_MS);
    this.emit();
  }

  /** Force an immediate save attempt — used on beforeunload / manual save. */
  async flushNow(): Promise<void> {
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (!this.started || this.stopped) return;
    if (this.inFlight) return;
    if (this.backoffUntil && Date.now() < this.backoffUntil) return;

    const { client, roomId, matrixToken, keyring, store, userId, deviceId } = this.deps;

    const currentSeq = await store.getCurrentSeq();
    this.lastSeqSeen = Math.max(this.lastSeqSeen, currentSeq);
    if (currentSeq === 0) return;
    if (this.lastSavedSeq !== null && currentSeq === this.lastSavedSeq) return;

    this.inFlight = true;
    this.lastError = null;
    this.lastDiagnostic = null;
    this.emit();

    let leaseHeld = false;
    try {
      const keyId = resolveSnapshotKeyId(keyring);
      if (!keyId) throw new Error('No encryption key in keyring (awaiting key delivery)');
      const entry = getKeyById(keyring, keyId);
      if (!entry) throw new Error('Keyring missing resolved key');

      const gotLease = await tryClaimSnapshotLease(client, roomId, currentSeq, deviceId, userId);
      if (!gotLease) {
        this.lastDiagnostic = 'Another device holds the write lease — skipping';
        this.inFlight = false;
        this.emit();
        return;
      }
      leaseHeld = true;

      const events = await readLogSince(store, 0);
      const payload: EodbBlobPayload = {
        version: 1,
        room_id: roomId,
        to_seq: currentSeq,
        ts: new Date().toISOString(),
        created_by: userId,
        events,
      };
      const plainBytes = pack(payload);
      const contentHash = await sha256hex(plainBytes);

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ctBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        entry.key,
        plainBytes as unknown as ArrayBuffer,
      );

      const envelope: BlobEnvelope = {
        v: 1,
        iv: bufferToBase64(iv),
        ct: bufferToBase64(new Uint8Array(ctBuf)),
        content_hash: contentHash,
        key_id: keyId,
        plaintext_size: plainBytes.byteLength,
      };

      const dataId = await eodbBlobDataIdForRoom(roomId);
      const res = await fetch(EODB_BLOB_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        body: JSON.stringify({
          matrix_token: matrixToken,
          op: 'store',
          room_id: roomId,
          data_id: dataId,
          envelope,
        }),
      });

      if (!res.ok) {
        const text = await safeText(res);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
      }

      const body: unknown = await res.json().catch(() => ({}));
      const uri = extractUri(body) ?? `eo-blob://${dataId}`;

      await setSnapshotStateEvent(client, roomId, uri, currentSeq, keyId);

      await recordSnapshotClaimResult(client, roomId, deviceId, userId, {
        status: 'success',
        target_seq: currentSeq,
        completed_seq: currentSeq,
        completed_mxc: uri,
      });
      leaseHeld = false;

      this.lastSavedSeq = currentSeq;
      this.lastSaveAt = Date.now();
      this.lastError = null;
      this.lastDiagnostic = `Saved ${events.length} events (${plainBytes.byteLength} B plaintext) as ${dataId}`;
      this.consecutiveFailures = 0;
      this.backoffUntil = null;
    } catch (err: unknown) {
      const reason = classifyError(err);
      if (leaseHeld) {
        try {
          await recordSnapshotClaimResult(client, roomId, deviceId, userId, {
            status: 'failed',
            target_seq: currentSeq,
            error: reason,
          });
        } catch (releaseErr) {
          console.warn('[EO-DB blob-writer] failed to release lease:', releaseErr);
        }
      }
      this.consecutiveFailures += 1;
      const backoff = Math.min(
        MAX_BACKOFF_MS,
        1_000 * Math.pow(2, Math.min(this.consecutiveFailures, 8)),
      );
      this.backoffUntil = Date.now() + backoff;
      this.lastError = reason;
      this.lastDiagnostic = `Backing off ${Math.round(backoff / 1000)}s`;
      console.warn('[EO-DB blob-writer] save failed:', reason);
    } finally {
      this.inFlight = false;
      this.emit();
    }
  }
}

async function sha256hex(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', data as unknown as BufferSource),
  );
  let hex = '';
  for (let i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
  return hex;
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

function extractUri(body: unknown): string | null {
  if (body && typeof body === 'object' && 'uri' in body) {
    const uri = (body as { uri?: unknown }).uri;
    if (typeof uri === 'string') return uri;
  }
  return null;
}

function classifyError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; message?: string };
    if (e.name === 'TimeoutError') return `Timed out after ${POST_TIMEOUT_MS / 1000}s`;
    if (e.name === 'AbortError') return 'Aborted';
    if (e.name === 'TypeError') return `Network/CORS error: ${e.message ?? 'Failed to fetch'}`;
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
  }
  return String(err);
}
