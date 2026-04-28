/**
 * EO/// DB Airtable Gateway — public surface.
 *
 * Layout (matches the five-concern spec):
 *   1. gateway()       — every call goes through one wrapper.
 *   2. bootstrapSchema — load schema once at startup, persist `_eoHints`.
 *   3. syncTable       — absorber loop with per-table cursor + Given-Log fold.
 *   4. searchTable     — ad-hoc query, no cursor, no fold.
 *   5. idb             — where the schema cache and per-table cursors live.
 */
export {
  GATEWAY_URL,
  gateway,
  getMatrixToken,
  refreshMatrixSession,
  AuthError,
  GatewayError,
  type GatewayOp,
  type GatewayBody,
} from './gateway';

export {
  bootstrapSchema,
  clearSchemaCache,
  getLastModifiedField,
  type SchemaResponse,
  type TableDef,
  type FieldDef,
  type FieldRef,
  type EoHints,
} from './bootstrap';

export {
  syncTable,
  syncTables,
  getCursor,
  resetCursor,
  type SyncRecord,
  type SyncResponse,
  type SyncTableOptions,
  type SyncTableResult,
  type RecEvent,
  type SyncSinks,
} from './sync';

export {
  searchTable,
  type SearchRecord,
  type SearchResponse,
  type SearchOptions,
} from './search';

export { idb } from './idb';
