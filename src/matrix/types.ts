/**
 * Matrix client interfaces — decoupled from any specific SDK.
 *
 * Consumers provide an implementation (e.g. matrix-js-sdk) that satisfies
 * these interfaces. This keeps the sync modules testable and SDK-agnostic.
 */

// ─── Matrix Event ──────────────────────────────────────────────────────────

export interface IMatrixEvent {
  getType(): string;
  getContent(): Record<string, any>;
  getSender(): string | null;
  getRoomId(): string | null;
  getId(): string | null;
  getTs(): number;
  getStateKey?(): string | null;
}

// ─── Room & Timeline ───────────────────────────────────────────────────────

export interface ITimeline {
  getEvents(): IMatrixEvent[];
}

export interface IRoomState {
  getStateEvents(type: string, stateKey: string): IMatrixEvent | null;
  events: Map<string, Map<string, IMatrixEvent>> | Record<string, Record<string, IMatrixEvent>>;
}

export interface IRoomMember {
  userId: string;
  name?: string | null;
  membership?: string;
}

export interface IRoom {
  roomId: string;
  name?: string | null;
  currentState: IRoomState;
  getLiveTimeline(): ITimeline;
  getJoinedMembers(): IRoomMember[];
}

// ─── Matrix Client ─────────────────────────────────────────────────────────

export interface IUploadResult {
  content_uri: string;
}

export interface IMatrixClient {
  getUserId(): string | null;
  getDeviceId(): string | null;

  // Room operations
  getRoom(roomId: string): IRoom | null;
  getRooms(): IRoom[];

  // Event sending
  sendEvent(roomId: string, eventType: string, content: Record<string, any>): Promise<{ event_id: string }>;
  sendStateEvent(roomId: string, eventType: string, content: Record<string, any>, stateKey: string): Promise<{ event_id: string }>;
  sendToDevice(eventType: string, contentMap: Map<string, Map<string, Record<string, any>>>): Promise<void>;

  // Media
  uploadContent(data: Uint8Array, opts: { name: string; type: string }): Promise<IUploadResult>;
  mxcUrlToHttp(mxcUrl: string): string | null;

  // Room management
  createRoom(opts: Record<string, any>): Promise<{ room_id: string }>;
  invite(roomId: string, userId: string): Promise<void>;
  kick(roomId: string, userId: string, reason?: string): Promise<void>;
  setPowerLevel(roomId: string, userId: string, powerLevel: number): Promise<void>;
  getRoomIdForAlias(alias: string): Promise<{ room_id: string }>;

  // Timeline pagination
  paginateEventTimeline(timeline: ITimeline, opts: { backwards: boolean; limit: number }): Promise<boolean>;

  // Event listeners
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  removeListener(event: string, handler: (...args: any[]) => void): void;
}

// ─── Governance & Access Control ───────────────────────────────────────────

export type AccessRole = 'owner' | 'admin' | 'editor' | 'creator' | 'viewer';

export const ROLE_POWER_LEVELS: Record<AccessRole, number> = {
  owner: 100,
  admin: 50,
  editor: 25,
  creator: 10,
  viewer: 0,
};

export interface FieldAssignment {
  field: string;
  room: 'main' | 'restricted';
  locked_to?: AccessRole[];
}

export interface SpaceSettings {
  creators_can_delete_own?: boolean;
  lock_shared_views?: boolean;
}

export interface SpaceConfig {
  name: string;
  rooms: {
    main: string;
    restricted?: string;
    governance?: string;
  };
  field_assignments: FieldAssignment[];
  space_settings: SpaceSettings;
}

/** Default power level configuration for EO-DB rooms. */
export const EO_POWER_LEVEL_CONTENT = {
  users_default: 0,
  events: {
    'com.eo-db.event': 10,
    'com.eo-db.schema': 50,
    'com.eo-db.governance': 50,
    'com.eo-db.key.announce': 100,
    'com.eo-db.snapshot': 50,
    'com.eo-db.import': 10,
    'm.room.name': 100,
    'm.room.power_levels': 100,
  },
  invite: 50,
  kick: 50,
  ban: 100,
  state_default: 50,
  events_default: 10,
} as const;

/** Derive role from a raw Matrix power level. */
export function powerLevelToRole(pl: number): AccessRole {
  if (pl >= 100) return 'owner';
  if (pl >= 50) return 'admin';
  if (pl >= 25) return 'editor';
  if (pl >= 10) return 'creator';
  return 'viewer';
}

// ─── Space Discovery ───────────────────────────────────────────────────────

export interface SpaceEntry {
  spaceTarget: string;
  displayName: string;
  mainRoomId: string;
  createdAt: number;
  lastActivity: number;
  ownerUserId: string;
  ownerDisplayName: string;
  memberCount: number;
}

// ─── Room Topology ─────────────────────────────────────────────────────────

export interface SpaceRooms {
  main: string;
  restricted: string | null;
  governance: string | null;
}

// ─── Snapshot ──────────────────────────────────────────────────────────────

export interface ImportMeta {
  source: string;        // 'airtable' | 'csv' | 'json' | custom
  record_count: number;
  label?: string;
}

/**
 * Snapshot claim — hand-raising lease stored as a Matrix room state event.
 *
 * One claim per room (state_key = ''). A pending claim held longer than
 * SNAPSHOT_CLAIM_TTL_MS is stealable by any peer. Terminal statuses
 * ('success' | 'failed') release the lease.
 */
export interface SnapshotClaim {
  device_id: string;
  user_id: string;
  claimed_at: number;
  target_seq: number;
  status: 'pending' | 'success' | 'failed';
  completed_at?: number;
  completed_seq?: number;
  completed_mxc?: string;
  error?: string;
}

export interface DeltaSnapshot {
  version: 2;
  type: 'delta' | 'import';
  from_seq: number;
  to_seq: number;
  prev_mxcs: string[];
  ts: string;
  created_by: string;
  events: import('../db/types.js').EoEvent[];
  /** Present when type === 'import'. Provenance metadata for grounded imports. */
  import_meta?: ImportMeta;
}

// ─── Sync Manager ──────────────────────────────────────────────────────────

export interface RoomDataSnapshot {
  roomId: string;
  roomAlias: string;
  name: string | null;
  topic: string | null;
  memberCount: number;
  members: Array<{ userId: string; displayName: string | null; membership: string }>;
  encryptionEnabled: boolean;
  encryptionAlgorithm: string | null;
  timelineLength: number;
  timeline: Array<{
    eventId: string;
    type: string;
    sender: string;
    ts: number;
    content: any;
  }>;
  stateEvents: Array<{
    type: string;
    stateKey: string;
    sender: string;
    content: any;
  }>;
  roomVersion: string | null;
  joinRule: string | null;
  historyVisibility: string | null;
}
