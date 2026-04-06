/**
 * Presence — live-user tracking for a space room via Matrix to-device heartbeats.
 *
 * Each device broadcasts a lightweight `ping` to all other joined members on
 * an interval. Incoming pings are recorded as (userId, deviceId, lastSeen).
 * A peer is considered "online" if any of their devices has pinged within
 * PRESENCE_TTL_MS. Stale entries are pruned on every tick and on sweep.
 *
 * Heartbeats ride Matrix to-device (Megolm-encrypted like the peer-sync
 * channel) — no homeserver presence API, no timeline noise.
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import { presenceEventTypes } from '../lib/matrix-domain';

const PING_TYPE = presenceEventTypes().ping;

/** How often we broadcast our own heartbeat. */
const PING_INTERVAL_MS = 15_000;

/** How long we consider a peer online after their last ping. */
const PRESENCE_TTL_MS = 45_000;

/** How often we sweep stale entries and notify subscribers. */
const SWEEP_INTERVAL_MS = 5_000;

export interface PresenceDevice {
  deviceId: string;
  lastSeen: number;
}

export interface PresenceUser {
  userId: string;
  displayName: string | null;
  devices: PresenceDevice[];
  /** Most-recent lastSeen across all devices. */
  lastSeen: number;
}

/** Build the Map<userId, Map<deviceId, content>> structure for sendToDevice. */
function toDeviceContent(userId: string, deviceId: string, content: Record<string, any>) {
  const inner = new Map<string, Record<string, any>>();
  inner.set(deviceId, content);
  const outer = new Map<string, Map<string, Record<string, any>>>();
  outer.set(userId, inner);
  return outer;
}

export class Presence {
  private client: MatrixClient;
  private roomId: string;

  /** userId -> deviceId -> lastSeen (ms) */
  private seen = new Map<string, Map<string, number>>();
  private subscribers = new Set<(users: PresenceUser[]) => void>();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private toDeviceHandler: ((event: MatrixEvent) => void) | null = null;
  private stopped = false;

  /** Cached snapshot to avoid rebuilding when nothing changed. */
  private cachedSnapshot: PresenceUser[] | null = null;
  /** Dirty flag set when the seen map is modified. */
  private dirty = false;

  constructor(client: MatrixClient, roomId: string) {
    this.client = client;
    this.roomId = roomId;
  }

  /** Begin broadcasting heartbeats and listening for peers. */
  async start(): Promise<void> {
    this.stopped = false;
    this.toDeviceHandler = (event: MatrixEvent) => this.handleToDeviceEvent(event);
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);

    // Broadcast immediately, then on an interval.
    void this.broadcastPing();
    this.pingTimer = setInterval(() => void this.broadcastPing(), PING_INTERVAL_MS);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = null;
    }
    this.seen.clear();
    this.subscribers.clear();
    this.cachedSnapshot = null;
    this.dirty = false;
  }

  /** Subscribe to online-user list changes. Returns unsubscribe fn. */
  subscribe(cb: (users: PresenceUser[]) => void): () => void {
    this.subscribers.add(cb);
    // Fire once with current state
    cb(this.snapshot());
    return () => { this.subscribers.delete(cb); };
  }

  /** Current online users (most-recent-first). */
  snapshot(): PresenceUser[] {
    if (this.cachedSnapshot && !this.dirty) return this.cachedSnapshot;

    const now = Date.now();
    const users: PresenceUser[] = [];
    const room = this.client.getRoom(this.roomId);
    for (const [userId, devices] of this.seen) {
      const live: PresenceDevice[] = [];
      let latest = 0;
      for (const [deviceId, lastSeen] of devices) {
        if (now - lastSeen <= PRESENCE_TTL_MS) {
          live.push({ deviceId, lastSeen });
          if (lastSeen > latest) latest = lastSeen;
        }
      }
      if (live.length === 0) continue;
      const member = room?.getMember(userId) ?? null;
      users.push({
        userId,
        displayName: member?.name ?? null,
        devices: live,
        lastSeen: latest,
      });
    }
    users.sort((a, b) => b.lastSeen - a.lastSeen);
    this.cachedSnapshot = users;
    this.dirty = false;
    return users;
  }

  /** Send a ping to every joined member's devices (wildcard deviceId). */
  private async broadcastPing(): Promise<void> {
    if (this.stopped) return;
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    const myUserId = this.client.getUserId();
    if (!myUserId) return;

    const content = {
      room_id: this.roomId,
      device: this.client.getDeviceId(),
      ts: Date.now(),
    };

    const members = room.getJoinedMembers();
    for (const member of members) {
      if (member.userId === myUserId) continue;
      try {
        await this.client.sendToDevice(
          PING_TYPE,
          toDeviceContent(member.userId, '*', content),
        );
      } catch (e) {
        // Non-fatal — peer may be offline or unknown; next tick will retry.
      }
    }
  }

  private handleToDeviceEvent(event: MatrixEvent): void {
    if (event.getType() !== PING_TYPE) return;
    const content = event.getContent() as { room_id?: string; device?: string };
    // Scope to this room only.
    if (content.room_id && content.room_id !== this.roomId) return;

    const sender = event.getSender();
    if (!sender) return;
    const deviceId = content.device || '_unknown';

    let devices = this.seen.get(sender);
    if (!devices) {
      devices = new Map();
      this.seen.set(sender, devices);
    }
    devices.set(deviceId, Date.now());
    this.dirty = true;
    this.notify();
  }

  /** Prune stale entries and notify subscribers if anything changed. */
  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [userId, devices] of this.seen) {
      for (const [deviceId, lastSeen] of devices) {
        if (now - lastSeen > PRESENCE_TTL_MS) {
          devices.delete(deviceId);
          changed = true;
        }
      }
      if (devices.size === 0) {
        this.seen.delete(userId);
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.notify();
    }
  }

  private notify(): void {
    const users = this.snapshot();
    for (const cb of this.subscribers) cb(users);
  }
}
