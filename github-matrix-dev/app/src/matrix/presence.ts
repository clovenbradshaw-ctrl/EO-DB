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
import { EO_SPACE_CONFIG_TYPE } from './event-bridge';

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

/**
 * Where a user is currently focused in the app. All fields are optional so
 * clients can broadcast only the parts they know. `null` as a whole user
 * location means the user has opted out of sharing location ("discrete" mode).
 */
export interface PresenceLocation {
  /** View id from the hash router ('records', 'graph', 'log', …) */
  view?: string | null;
  /** Selected space target (e.g. 'space_amino'). */
  space?: string | null;
  /** Scope dot-path (e.g. 'tblClients'). */
  scope?: string | null;
  /** Record dot-path (e.g. 'tblClients.rec123'). */
  record?: string | null;
}

export interface PresenceUser {
  userId: string;
  displayName: string | null;
  devices: PresenceDevice[];
  /** Most-recent lastSeen across all devices. */
  lastSeen: number;
  /** Most-recent known location for this user, or null if they're discrete. */
  location: PresenceLocation | null;
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

  /** All room IDs belonging to the same space (handles duplicate rooms). */
  private spaceRoomIds: Set<string>;

  /** userId -> deviceId -> lastSeen (ms) */
  private seen = new Map<string, Map<string, number>>();
  /** userId -> most-recent location reported by any device (null = discrete). */
  private locations = new Map<string, PresenceLocation | null>();
  private subscribers = new Set<(users: PresenceUser[]) => void>();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private toDeviceHandler: ((event: MatrixEvent) => void) | null = null;
  private membershipHandler: ((event: any, member: any, oldMembership: string | null) => void) | null = null;
  private stopped = false;

  /** Local location broadcast on the next ping. */
  private myLocation: PresenceLocation | null = null;
  /** When false, pings carry `location: null` so peers treat us as discrete. */
  private shareLocation = true;
  /** Timestamp of the last ping, used to throttle immediate broadcasts. */
  private lastPingAt = 0;
  /** Pending debounce timer for location-change broadcasts. */
  private locationBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Cached snapshot to avoid rebuilding when nothing changed. */
  private cachedSnapshot: PresenceUser[] | null = null;
  /** Dirty flag set when the seen map is modified. */
  private dirty = false;

  constructor(client: MatrixClient, roomId: string) {
    this.client = client;
    this.roomId = roomId;
    this.spaceRoomIds = Presence.findSpaceRoomIds(client, roomId);
  }

  /** Collect all room IDs belonging to the same space as roomId. */
  private static findSpaceRoomIds(client: MatrixClient, roomId: string): Set<string> {
    const set = new Set<string>([roomId]);
    const myRoom = client.getRoom(roomId);
    if (!myRoom) return set;
    const myConfig = myRoom.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
    if (!myConfig) return set;
    const myName = (myConfig.getContent() as any)?.name;
    if (!myName) return set;

    for (const room of client.getRooms()) {
      const config = room.currentState?.getStateEvents?.(EO_SPACE_CONFIG_TYPE, '');
      if (!config) continue;
      const name = (config.getContent() as any)?.name;
      if (name === myName) {
        set.add(room.roomId);
        const rooms = (config.getContent() as any)?.rooms;
        if (rooms?.main) set.add(rooms.main);
      }
    }
    return set;
  }

  /** Begin broadcasting heartbeats and listening for peers. */
  async start(): Promise<void> {
    this.stopped = false;
    this.toDeviceHandler = (event: MatrixEvent) => this.handleToDeviceEvent(event);
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);

    // When a new member joins this room, ping them immediately instead
    // of waiting up to PING_INTERVAL_MS for the next heartbeat cycle.
    this.membershipHandler = (_event: any, member: any, oldMembership: string | null) => {
      if (member.roomId !== this.roomId) return;
      if (member.membership === 'join' && oldMembership !== 'join') {
        void this.broadcastPing();
      }
    };
    this.client.on('RoomMember.membership' as any, this.membershipHandler);

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
    if (this.locationBroadcastTimer) {
      clearTimeout(this.locationBroadcastTimer);
      this.locationBroadcastTimer = null;
    }
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = null;
    }
    if (this.membershipHandler) {
      this.client.removeListener('RoomMember.membership' as any, this.membershipHandler);
      this.membershipHandler = null;
    }
    this.seen.clear();
    this.locations.clear();
    this.subscribers.clear();
    this.cachedSnapshot = null;
    this.dirty = false;
  }

  /**
   * Update the local user's in-app location. The next heartbeat (or a
   * debounced immediate ping) will carry this payload so peers can render
   * subtle "user X is here" indicators.
   */
  setLocation(loc: PresenceLocation | null): void {
    // Shallow equality — avoid ping-storms when route effects re-fire with
    // identical values.
    if (samePresenceLocation(this.myLocation, loc)) return;
    this.myLocation = loc;
    this.scheduleLocationBroadcast();
  }

  /**
   * Toggle whether the local user shares their location. When disabled,
   * pings still keep the user marked online but carry `location: null` so
   * peers drop any previously-known location ("move discretely" mode).
   */
  setShareLocation(enabled: boolean): void {
    if (this.shareLocation === enabled) return;
    this.shareLocation = enabled;
    this.scheduleLocationBroadcast();
  }

  /** Current share-location flag — used by tests and inspection. */
  isSharingLocation(): boolean {
    return this.shareLocation;
  }

  /**
   * Debounce rapid location changes into at most one broadcast per 400ms to
   * prevent bursts when the user is clicking through the navigation tree.
   */
  private scheduleLocationBroadcast(): void {
    if (this.stopped) return;
    if (this.locationBroadcastTimer) return;
    const sinceLast = Date.now() - this.lastPingAt;
    const delay = sinceLast < 400 ? 400 - sinceLast : 0;
    this.locationBroadcastTimer = setTimeout(() => {
      this.locationBroadcastTimer = null;
      void this.broadcastPing();
    }, delay);
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
        location: this.locations.get(userId) ?? null,
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
    if (!room) {
      console.warn('[EO-DB] Presence: room not in SDK cache', this.roomId, '— ping skipped');
      return;
    }

    const myUserId = this.client.getUserId();
    if (!myUserId) return;

    this.lastPingAt = Date.now();
    const content: Record<string, unknown> = {
      room_id: this.roomId,
      device: this.client.getDeviceId(),
      ts: this.lastPingAt,
      // Always include `location` so peers can actively clear a previous
      // value when the user switches to discrete mode. `null` means "no
      // location shared", an object means "here".
      location: this.shareLocation ? (this.myLocation ?? null) : null,
    };

    const members = room.getJoinedMembers();
    const peers = members.filter((m: any) => m.userId !== myUserId);
    if (peers.length === 0) {
      console.warn('[EO-DB] Presence: no peers in room', this.roomId, `(${members.length} total members) — broadcast skipped`);
    }
    for (const member of peers) {
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
    const content = event.getContent() as {
      room_id?: string;
      device?: string;
      location?: PresenceLocation | null;
    };
    // Scope to this space (accept from any room belonging to the same space).
    if (content.room_id && !this.spaceRoomIds.has(content.room_id)) return;

    const sender = event.getSender();
    if (!sender) return;
    const deviceId = content.device || '_unknown';

    let devices = this.seen.get(sender);
    if (!devices) {
      devices = new Map();
      this.seen.set(sender, devices);
    }
    devices.set(deviceId, Date.now());

    // Location is explicit: `null` means the peer opted out, an object
    // means "here". Missing `location` key (legacy clients) is treated as
    // a no-op so we keep whatever we had before.
    if ('location' in content) {
      const loc = sanitizeLocation(content.location ?? null);
      const prev = this.locations.get(sender) ?? null;
      if (!samePresenceLocation(prev, loc)) {
        this.locations.set(sender, loc);
      }
    }

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
        this.locations.delete(userId);
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

/**
 * Accept only the known string fields from an incoming location payload so
 * a peer can't inject arbitrary keys (and so snapshot comparisons remain
 * predictable).
 */
function sanitizeLocation(loc: PresenceLocation | null): PresenceLocation | null {
  if (!loc || typeof loc !== 'object') return null;
  const out: PresenceLocation = {};
  if (typeof loc.view === 'string') out.view = loc.view;
  if (typeof loc.space === 'string') out.space = loc.space;
  if (typeof loc.scope === 'string') out.scope = loc.scope;
  if (typeof loc.record === 'string') out.record = loc.record;
  // An object with no recognised keys is equivalent to null.
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Structural equality for PresenceLocation (null included). */
function samePresenceLocation(
  a: PresenceLocation | null,
  b: PresenceLocation | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    (a.view ?? null) === (b.view ?? null) &&
    (a.space ?? null) === (b.space ?? null) &&
    (a.scope ?? null) === (b.scope ?? null) &&
    (a.record ?? null) === (b.record ?? null)
  );
}
