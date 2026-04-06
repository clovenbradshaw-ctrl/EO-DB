/**
 * Filen socket listener — watches a single folder for real-time changes.
 *
 * On start():
 *   1. Authenticates with Filen (email/password or apiKey/masterKeys)
 *   2. Runs a catch-up scan to detect files added while offline
 *   3. Subscribes to socket events for live change detection
 *   4. Starts periodic health checks
 *
 * Events are folder-filtered (only events matching the configured folder UUID
 * pass through) then dispatched to registered handlers.
 */

import FilenSDK from '@filen/sdk';
import type { ConnectionState, ConnectionListener, ConnectionStatus } from '../matrix/connection-resilience.js';
import type { FilenListenerConfig, FilenChangeEvent, FilenChangeHandler, FilenSocketEventType } from './types.js';
import { WATCHED_EVENTS } from './types.js';

// ─── Health check constants ────────────────────────────────────────────────

const DEFAULT_HEALTH_INTERVAL = 30_000;
const DEGRADED_THRESHOLD = 2;
const OFFLINE_THRESHOLD = 4;

// ─── Listener ──────────────────────────────────────────────────────────────

export class FilenSocketListener {
  private sdk: FilenSDK;
  private config: FilenListenerConfig;
  private handlers: Set<FilenChangeHandler> = new Set();
  private boundListeners: Map<string, (...args: any[]) => void> = new Map();

  // Health monitoring
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private healthInterval: number;
  private connectionListeners: Set<ConnectionListener> = new Set();
  private connectionState: ConnectionState = {
    status: 'online',
    lastSeen: Date.now(),
    consecutiveFailures: 0,
    reason: 'initial',
  };

  // Catch-up scan state (in-memory; persisted externally if needed)
  private lastScanFileUuids: Set<string> = new Set();

  constructor(config: FilenListenerConfig) {
    this.config = config;
    this.healthInterval = config.healthCheckIntervalMs ?? DEFAULT_HEALTH_INTERVAL;

    this.sdk = new FilenSDK({
      metadataCache: true,
      connectToSocket: true,
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.authenticate();
    await this.catchUpScan();
    this.subscribeToEvents();
    this.startHealthCheck();
  }

  async stop(): Promise<void> {
    this.stopHealthCheck();
    this.unsubscribeFromEvents();
    this.handlers.clear();

    try {
      this.sdk.socket.disconnect();
    } catch {
      // Best-effort cleanup
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /** Register a handler for filtered change events. Returns an unsubscribe fn. */
  onFileChange(handler: FilenChangeHandler): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /** Register a listener for connection state changes. Returns unsubscribe fn. */
  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  getConnectionState(): Readonly<ConnectionState> {
    return { ...this.connectionState };
  }

  // ─── Authentication ────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    const { email, password, twoFactorCode } = this.config;

    if (!email || !password) {
      throw new Error('Filen listener requires FILEN_EMAIL and FILEN_PASSWORD');
    }

    await this.sdk.login({ email, password, twoFactorCode });
  }

  // ─── Catch-up scan ─────────────────────────────────────────────────────

  /**
   * List the watched folder and emit events for any files not seen in the
   * previous scan. On first run everything is treated as "already known"
   * (no flood of events).
   */
  private async catchUpScan(): Promise<void> {
    const folderPath = this.config.folderPath || '/';

    try {
      const entries = await this.sdk.fs().readdir({ path: folderPath });
      const currentUuids = new Set<string>();

      for (const entry of entries) {
        try {
          const stat = await this.sdk.fs().stat({ path: `${folderPath === '/' ? '' : folderPath}/${entry}` });
          currentUuids.add(stat.uuid);

          // On subsequent scans, emit events for new files
          if (this.lastScanFileUuids.size > 0 && !this.lastScanFileUuids.has(stat.uuid)) {
            const event: FilenChangeEvent = {
              type: stat.isFile() ? 'fileNew' : 'folderSubCreated',
              uuid: stat.uuid,
              name: entry,
              folderUuid: this.config.folderUuid,
              timestamp: stat.mtimeMs,
              raw: { source: 'catch-up-scan', stat },
            };
            this.dispatch(event);
          }
        } catch {
          // Skip entries we can't stat (deleted between readdir and stat)
        }
      }

      this.lastScanFileUuids = currentUuids;
      this.recordSuccess();
    } catch (err: any) {
      this.recordFailure(`catch-up scan failed: ${err.message}`);
    }
  }

  // ─── Socket event subscription ─────────────────────────────────────────

  private subscribeToEvents(): void {
    for (const eventType of WATCHED_EVENTS) {
      const listener = (data: any) => this.handleSocketEvent(eventType, data);
      this.boundListeners.set(eventType, listener);
      this.sdk.socket.on(eventType, listener);
    }
  }

  private unsubscribeFromEvents(): void {
    for (const [eventType, listener] of this.boundListeners) {
      this.sdk.socket.off(eventType, listener);
    }
    this.boundListeners.clear();
  }

  private handleSocketEvent(type: FilenSocketEventType, data: any): void {
    this.recordSuccess();

    // Extract parent folder UUID from the event payload.
    // Not all events carry a parent — those that don't (e.g. fileTrash,
    // fileArchived, fileRename without parent) can't be folder-filtered,
    // so we pass them through if they match by uuid against known items.
    const parent = this.extractParent(type, data);
    const uuid = data?.uuid || data?.currentUUID || '';

    if (parent) {
      // Direct folder match
      if (parent !== this.config.folderUuid) return;
    } else {
      // No parent in payload — check if uuid is in our known set
      if (!this.lastScanFileUuids.has(uuid)) return;
    }

    // Update scan state
    if (type === 'fileNew' || type === 'folderSubCreated' || type === 'fileRestore' || type === 'fileArchiveRestored') {
      this.lastScanFileUuids.add(uuid);
    } else if (type === 'fileTrash' || type === 'fileDeletedPermanent' || type === 'fileArchived') {
      this.lastScanFileUuids.delete(uuid);
    }

    const event: FilenChangeEvent = {
      type,
      uuid,
      name: data?.name || data?.metadata || '',
      folderUuid: parent || this.config.folderUuid,
      timestamp: data?.timestamp || Date.now(),
      raw: data,
    };

    this.dispatch(event);
  }

  /**
   * Extract the parent folder UUID from a socket event payload.
   * Returns undefined for events that don't include a parent field.
   */
  private extractParent(type: FilenSocketEventType, data: any): string | undefined {
    switch (type) {
      // Events with a `parent` field
      case 'fileNew':
      case 'fileMove':
      case 'fileRestore':
      case 'fileArchiveRestored':
      case 'folderSubCreated':
      case 'folderMove':
      case 'folderRestore':
      case 'folderTrash':
        return (data as { parent?: string })?.parent;

      // Events without parent — can only match by uuid
      case 'fileRename':
      case 'fileTrash':
      case 'fileArchived':
      case 'fileDeletedPermanent':
      case 'folderRename':
      case 'folderColorChanged':
        return undefined;

      default:
        return undefined;
    }
  }

  private dispatch(event: FilenChangeEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Handler errors are non-fatal
      }
    }
  }

  // ─── Health monitoring ─────────────────────────────────────────────────

  private startHealthCheck(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => this.checkHealth(), this.healthInterval);
  }

  private stopHealthCheck(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async checkHealth(): Promise<void> {
    const folderPath = this.config.folderPath || '/';
    try {
      await this.sdk.fs().stat({ path: folderPath });
      this.recordSuccess();
    } catch (err: any) {
      this.recordFailure(`health check failed: ${err.message}`);

      // Attempt reconnection when offline
      if (this.connectionState.status === 'offline') {
        await this.attemptReconnect();
      }
    }
  }

  private async attemptReconnect(): Promise<void> {
    try {
      await this.authenticate();
      this.unsubscribeFromEvents();
      this.subscribeToEvents();
      this.recordSuccess();
    } catch {
      // Will retry on next health check
    }
  }

  private recordSuccess(): void {
    if (this.connectionState.consecutiveFailures > 0 || this.connectionState.status !== 'online') {
      this.setConnectionState({
        status: 'online',
        lastSeen: Date.now(),
        consecutiveFailures: 0,
        reason: 'request succeeded',
      });
    } else {
      this.connectionState.lastSeen = Date.now();
    }
  }

  private recordFailure(reason: string): void {
    const failures = this.connectionState.consecutiveFailures + 1;
    let status: ConnectionStatus = 'online';
    if (failures >= OFFLINE_THRESHOLD) {
      status = 'offline';
    } else if (failures >= DEGRADED_THRESHOLD) {
      status = 'degraded';
    }
    this.setConnectionState({
      status,
      lastSeen: this.connectionState.lastSeen,
      consecutiveFailures: failures,
      reason,
    });
  }

  private setConnectionState(next: ConnectionState): void {
    const prev = this.connectionState;
    this.connectionState = next;
    if (prev.status !== next.status || prev.consecutiveFailures !== next.consecutiveFailures) {
      for (const listener of this.connectionListeners) {
        try { listener(next); } catch { /* non-fatal */ }
      }
    }
  }
}
