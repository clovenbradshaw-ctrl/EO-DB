/**
 * Matrix sync — public API.
 *
 * Re-exports all Matrix integration modules for clean imports:
 *
 *   import { SyncManager, PeerSync, discoverSpacesFromMatrix } from './matrix/index.js';
 */

// Types
export type {
  IMatrixClient,
  IMatrixEvent,
  IRoom,
  IRoomState,
  ITimeline,
  IRoomMember,
  IUploadResult,
  AccessRole,
  FieldAssignment,
  SpaceConfig,
  SpaceSettings,
  SpaceEntry,
  SpaceRooms,
  DeltaSnapshot,
  ImportMeta,
  RoomDataSnapshot,
} from './types.js';

export {
  ROLE_POWER_LEVELS,
  EO_POWER_LEVEL_CONTENT,
  powerLevelToRole,
} from './types.js';

// Event Bridge
export {
  EO_EVENT_TYPE,
  EO_SNAPSHOT_TYPE,
  EO_SNAPSHOT_STATE_TYPE,
  EO_IMPORT_TYPE,
  EO_SPACE_CONFIG_TYPE,
  EO_SCHEMA_MANIFEST_TYPE,
  EO_KEY_ANNOUNCE_TYPE,
  getDataRoom,
  sendEoEvent,
  matrixEventToEo,
  resolveDataRoom,
} from './event-bridge.js';

// Snapshot
export {
  SNAPSHOT_FREQUENCY,
  IMPORT_CHUNK_SIZE,
  setSnapshotStateEvent,
  findLatestSnapshot,
  maybeCreateSnapshot,
  createDeltaSnapshot,
  uploadDeltaSnapshot,
  downloadDeltaSnapshot,
  restoreFromDeltaChain,
  createImportSnapshot,
  uploadImportSnapshot,
} from './snapshot.js';

// Sync Manager
export { SyncManager } from './sync-manager.js';

// Peer Sync
export { PeerSync } from './peer-sync.js';

// Space Discovery
export { discoverSpacesFromMatrix } from './space-discovery.js';

// Room Topology
export {
  createRestrictedRoom,
  createGovernanceRoom,
  setSpaceConfig,
  getSpaceConfig,
  setSchemaManifest,
  getSchemaManifest,
  setUserRole,
  applyEoPowerLevels,
  inviteToRoom,
  removeFromRoom,
  ensureSpaceRooms,
  assignFieldToRoom,
  removeFieldAssignment,
  migrateShareToMatrix,
} from './room-topology.js';
