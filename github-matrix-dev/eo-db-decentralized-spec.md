# EO///DB — Decentralized Architecture Spec

## Supersedes: VM Server Architecture (§16 of design report, deployment section of technical spec)

This document specifies a decentralized version of EO///DB that runs entirely in the browser, syncs through Matrix, encrypts everything end-to-end, stores nothing on any server in plaintext, and serves from GitHub Pages as a static app. The fold, the nine operators, the Horizon, the three-layer read — all unchanged. The infrastructure around them changes completely.

---

## 1. Architecture Overview

```
GitHub Pages (static hosting)
  └── app code only — HTML, JS, CSS
  └── zero data, zero state, zero secrets

Matrix homeserver (app.aminoimmigration.com)
  ├── room: #amino-data (E2EE enabled)
  │     ├── encrypted EO events (custom event type)
  │     └── eo.snapshot references (pointers to binary snapshots)
  ├── media store
  │     └── encrypted binary snapshots (msgpack + Megolm)
  ├── presence + routing (device discovery, to-device relay)
  └── key management (Megolm sessions, device verification, cross-signing)

Each user's browser
  ├── IndexedDB (encrypted at rest with session-derived key)
  │     ├── log: encrypted EO events
  │     ├── state: projected state (from fold)
  │     ├── graph: CON adjacency index
  │     └── eva: EVA-active registrations
  ├── fold + Horizon (runs locally, in memory)
  ├── Matrix SDK (sync, encrypt/decrypt, to-device messaging)
  └── CRM interface
```

The homeserver stores only encrypted blobs. It cannot read any data. The fold runs in every browser. Every device that has the events and the keys has the complete database. There is no center.

---

## 2. Project Structure

```
eo-db-app/
  index.html
  package.json
  vite.config.ts
  tsconfig.json
  src/
    main.ts                    — app entry point
    db/
      types.ts                 — EO types (same as server spec)
      log.ts                   — IndexedDB log operations
      state.ts                 — IndexedDB projected state
      graph.ts                 — IndexedDB CON adjacency index
      fold.ts                  — nine-case fold (unchanged from server spec)
      horizon.ts               — three-layer Horizon (unchanged)
    sync/
      matrix-client.ts         — Matrix SDK wrapper: login, room sync, send events
      matrix-crypto.ts         — encryption/decryption helpers
      event-bridge.ts          — EO event ↔ Matrix event conversion
      peer-sync.ts             — device-to-device sync via to-device messaging
      snapshot.ts              — create, upload, download, apply snapshots
      sync-manager.ts          — orchestrates all sync paths
    store/
      idb.ts                   — IndexedDB schema and migrations
      encrypted-idb.ts         — encryption layer over IndexedDB
    ui/
      App.tsx                  — root component
      Login.tsx                — Matrix login screen
      ClientList.tsx           — sidebar
      RecordView.tsx           — six-layer Horizon view
      components/              — field cells, ground chips, signal cards, etc.
  public/
    _headers                   — security headers for GitHub Pages
```

---

## 3. Dependencies

```json
{
  "dependencies": {
    "matrix-js-sdk": "^34.x",
    "matrix-sdk-crypto-wasm": "^7.x",
    "idb": "^8.x",
    "msgpackr": "^1.x",
    "react": "^18.x",
    "react-dom": "^18.x",
    "zustand": "^4.x"
  },
  "devDependencies": {
    "vite": "^5.x",
    "typescript": "^5.x",
    "@types/react": "^18.x",
    "vitest": "^1.x"
  }
}
```

The Matrix JS SDK plus crypto WASM module handles all encryption, sync, key management, and device-to-device messaging. `idb` is a thin Promise wrapper over IndexedDB. Zustand holds the in-memory projected state for React rendering — same role it plays in amino-eo today.

---

## 4. IndexedDB Schema

```typescript
// src/store/idb.ts

// Database name scoped to Matrix user ID to support multiple accounts
// e.g., "eo-db-@sara:app.aminoimmigration.com"

interface EoDatabase {
  // Object stores:

  log: {
    key: string;              // client_event_id (UUID)
    value: {
      client_event_id: string;
      canonical_seq?: number; // assigned when synced to room, null for local-only events
      op: LoggableOperator;
      target: string;
      operand: any;
      agent: string;
      ts: string;
      meta?: Record<string, any>;
      synced: boolean;        // true once confirmed in room history
    };
    indexes: {
      'by-seq': number;       // canonical_seq, for ordering
      'by-target': string;    // target, for log-per-target queries
      'by-synced': boolean;   // false = needs to sync
    };
  };

  state: {
    key: string;              // target path
    value: EoState;           // same as server spec
  };

  graph_fwd: {
    key: string;              // "source:dest"
    value: GraphEdge;
  };

  graph_rev: {
    key: string;              // "dest:source"
    value: GraphEdge;
  };

  eva: {
    key: string;              // target path
    value: EvaRegistration;
  };

  meta: {
    key: string;              // "last_synced_seq", "snapshot_seq", etc.
    value: any;
  };
}
```

---

## 5. Encrypted IndexedDB Layer

```typescript
// src/store/encrypted-idb.ts

/**
 * Wraps IndexedDB with encryption using a key derived from the Matrix session.
 *
 * On login:
 *   1. User authenticates with Matrix
 *   2. Derive an encryption key from the Matrix access token + device ID
 *      using PBKDF2 (or use the Matrix SDK's crypto store key)
 *   3. Store the derived key in memory only (never persisted)
 *   4. All IndexedDB writes encrypt the value with this key (AES-GCM)
 *   5. All IndexedDB reads decrypt with this key
 *
 * On logout:
 *   1. Discard the key from memory
 *   2. IndexedDB contents are unreadable without the key
 *
 * The encryption is defense-in-depth. The primary encryption is Megolm
 * on the Matrix events. This layer protects the local cache if someone
 * extracts IndexedDB files from the filesystem.
 */

interface EncryptedStore {
  // Same interface as plain IDB, but values are encrypted/decrypted transparently
  get(store: string, key: string): Promise<any>;
  put(store: string, key: string, value: any): Promise<void>;
  delete(store: string, key: string): Promise<void>;
  getAll(store: string, query?: IDBKeyRange): Promise<any[]>;
  getAllByIndex(store: string, index: string, value: any): Promise<any[]>;
}

// Key derivation
async function deriveLocalKey(accessToken: string, deviceId: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(accessToken + deviceId),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('eo-db-local'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
```

---

## 6. Matrix Integration

### 6.1 Login

```typescript
// src/sync/matrix-client.ts

const HOMESERVER = 'https://app.aminoimmigration.com';
const DATA_ROOM_ALIAS = '#amino-data:app.aminoimmigration.com';

/**
 * Login flow:
 * 1. User enters Matrix username + password (or SSO)
 * 2. Matrix SDK authenticates against homeserver
 * 3. SDK initializes crypto (Megolm key store)
 * 4. SDK resolves room alias to room ID
 * 5. SDK starts sync — pulls room history
 * 6. App derives local encryption key from session
 * 7. App initializes IndexedDB with encryption layer
 * 8. App begins processing events
 */

async function initMatrix(username: string, password: string): Promise<MatrixClient> {
  const client = sdk.createClient({ baseUrl: HOMESERVER });

  await client.login('m.login.password', {
    user: username,
    password: password
  });

  await client.initCrypto();
  await client.startClient({ initialSyncLimit: 0 }); // we handle history ourselves

  return client;
}
```

### 6.2 Sending EO Events to Room

```typescript
// src/sync/event-bridge.ts

const EO_EVENT_TYPE = 'com.aminoimmigration.eo.event';
const EO_SNAPSHOT_TYPE = 'com.aminoimmigration.eo.snapshot';

/**
 * Send an EO event to the Matrix room.
 * The Matrix SDK encrypts it automatically (room has E2EE enabled).
 *
 * The event content is the EO event without the canonical_seq
 * (that gets assigned based on room event ordering).
 */
async function sendEoEvent(
  client: MatrixClient,
  roomId: string,
  event: Omit<EoEvent, 'seq'>
): Promise<string> {
  const result = await client.sendEvent(roomId, EO_EVENT_TYPE, {
    op: event.op,
    target: event.target,
    operand: event.operand,
    client_event_id: event.client_event_id,
    ts: event.ts,
    meta: event.meta
    // agent is derived from the sender's Matrix user ID, not sent in content
  });

  return result.event_id; // Matrix event ID
}

/**
 * Convert a Matrix room event back to an EO event.
 * The agent comes from the Matrix event's sender field.
 * The canonical_seq comes from the room event ordering.
 */
function matrixEventToEo(matrixEvent: MatrixEvent, seq: number): EoEvent {
  const content = matrixEvent.getContent();
  return {
    seq,
    op: content.op,
    target: content.target,
    operand: content.operand,
    agent: matrixEvent.getSender(), // e.g., "@sara:app.aminoimmigration.com"
    ts: content.ts || new Date(matrixEvent.getTs()).toISOString(),
    client_event_id: content.client_event_id,
    meta: content.meta
  };
}
```

### 6.3 Receiving and Processing Room Events

```typescript
// src/sync/sync-manager.ts

/**
 * The sync manager orchestrates three sync paths in priority order:
 *
 * 1. Snapshot hydration (new device or stale cache)
 *    - Check room state for latest eo.snapshot event
 *    - Download binary from media store
 *    - Decrypt and deserialize
 *    - Load into IndexedDB
 *    - Set sync cursor to snapshot's seq
 *
 * 2. Room history (primary sync)
 *    - Paginate room timeline from last known seq
 *    - Decrypt each event (Matrix SDK handles this)
 *    - Convert to EO events
 *    - Run fold on each
 *    - Update IndexedDB
 *
 * 3. Peer sync (gap filling)
 *    - On connect, broadcast own seq to peers via to-device
 *    - If a peer has events we're missing, request them
 *    - If we have events a peer is missing, send them
 *    - Fold incoming events
 */

class SyncManager {
  private client: MatrixClient;
  private roomId: string;
  private db: EncryptedStore;
  private fold: Fold;
  private feed: Feed;
  private lastSeq: number = 0;

  async initialize(): Promise<void> {
    // 1. Check if we have local state
    const localSeq = await this.db.get('meta', 'last_seq');

    if (!localSeq) {
      // New device — try snapshot hydration first
      await this.hydrateFromSnapshot();
    }

    // 2. Sync room history from our last known position
    await this.syncRoomHistory();

    // 3. Announce presence to peers for gap filling
    await this.announceToPeers();

    // 4. Listen for new events in real-time
    this.client.on('Room.timeline', (event) => {
      if (event.getRoomId() !== this.roomId) return;
      if (event.getType() !== EO_EVENT_TYPE) return;
      this.processIncomingEvent(event);
    });

    // 5. Listen for peer sync requests
    this.client.on('toDeviceEvent', (event) => {
      if (event.getType().startsWith('com.aminoimmigration.eo.sync.')) {
        this.handlePeerSync(event);
      }
    });
  }

  /**
   * Process a locally created event.
   * 1. Assign a UUID client_event_id
   * 2. Run the fold locally (immediate UI update)
   * 3. Store in IndexedDB as unsynced
   * 4. Send to Matrix room (async, may fail if offline)
   * 5. When confirmed in room, mark as synced and assign canonical seq
   */
  async processLocalEvent(event: Omit<EoEvent, 'seq' | 'client_event_id'>): Promise<void> {
    const clientEventId = crypto.randomUUID();
    const localEvent = {
      ...event,
      client_event_id: clientEventId,
      agent: this.client.getUserId(),
      ts: new Date().toISOString()
    };

    // Run fold immediately with a temporary local seq
    const tempSeq = this.lastSeq + 0.001; // fractional to distinguish from canonical
    await this.fold.processEvent(this.db, { ...localEvent, seq: tempSeq });
    this.feed.notify({ ...localEvent, seq: tempSeq } as EoEvent);

    // Store as unsynced
    await this.db.put('log', clientEventId, { ...localEvent, synced: false });

    // Send to room (best-effort, retries on reconnect)
    try {
      await sendEoEvent(this.client, this.roomId, localEvent);
    } catch (e) {
      // Offline — will sync when reconnected
      console.log('Event queued for sync:', clientEventId);
    }
  }

  /**
   * On reconnect, send all unsynced local events to the room.
   */
  async flushUnsyncedEvents(): Promise<void> {
    const unsynced = await this.db.getAllByIndex('log', 'by-synced', false);
    for (const event of unsynced) {
      try {
        await sendEoEvent(this.client, this.roomId, event);
        event.synced = true;
        await this.db.put('log', event.client_event_id, event);
      } catch (e) {
        break; // still offline, stop trying
      }
    }
  }
}
```

---

## 7. Peer-to-Peer Sync

```typescript
// src/sync/peer-sync.ts

const SYNC_HELLO = 'com.aminoimmigration.eo.sync.hello';
const SYNC_OFFER = 'com.aminoimmigration.eo.sync.offer';
const SYNC_REQUEST = 'com.aminoimmigration.eo.sync.request';
const SYNC_EVENTS = 'com.aminoimmigration.eo.sync.events';

/**
 * Peer sync protocol via Matrix to-device messaging.
 * All messages are encrypted end-to-end by the Matrix SDK.
 * The homeserver routes but cannot read.
 */

/**
 * Step 1: Announce presence and current state to all devices in the room.
 * Called on app startup after initial sync.
 */
async function announceToPeers(client: MatrixClient, roomId: string, mySeq: number): Promise<void> {
  const room = client.getRoom(roomId);
  const members = room.getJoinedMembers();

  for (const member of members) {
    if (member.userId === client.getUserId()) continue;

    // Get all devices for this member
    const devices = await client.getStoredDevicesForUser(member.userId);

    for (const device of devices) {
      await client.sendToDevice(SYNC_HELLO, {
        [member.userId]: {
          [device.deviceId]: {
            my_seq: mySeq,
            my_device: client.getDeviceId(),
            room_id: roomId
          }
        }
      });
    }
  }
}

/**
 * Step 2: Handle incoming sync hello — respond with our state.
 */
async function handleSyncHello(
  client: MatrixClient,
  senderUserId: string,
  senderDeviceId: string,
  theirSeq: number,
  mySeq: number
): Promise<void> {
  await client.sendToDevice(SYNC_OFFER, {
    [senderUserId]: {
      [senderDeviceId]: {
        my_seq: mySeq,
        has_events_you_need: mySeq > theirSeq,
        needs_events_from_you: theirSeq > mySeq
      }
    }
  });
}

/**
 * Step 3: Request missing events from a peer.
 */
async function requestEvents(
  client: MatrixClient,
  peerUserId: string,
  peerDeviceId: string,
  needFrom: number
): Promise<void> {
  await client.sendToDevice(SYNC_REQUEST, {
    [peerUserId]: {
      [peerDeviceId]: {
        need_from: needFrom
      }
    }
  });
}

/**
 * Step 4: Send requested events to peer.
 * Batch into chunks of 50 events to avoid message size limits.
 */
async function sendEventsToPeer(
  client: MatrixClient,
  db: EncryptedStore,
  peerUserId: string,
  peerDeviceId: string,
  fromSeq: number
): Promise<void> {
  const events = await db.getAllByIndex('log', 'by-seq', IDBKeyRange.lowerBound(fromSeq));

  // Chunk into batches of 50
  for (let i = 0; i < events.length; i += 50) {
    const batch = events.slice(i, i + 50);
    await client.sendToDevice(SYNC_EVENTS, {
      [peerUserId]: {
        [peerDeviceId]: {
          events: batch,
          batch_index: Math.floor(i / 50),
          total_batches: Math.ceil(events.length / 50)
        }
      }
    });
  }
}

/**
 * Step 5: Receive events from peer, fold them, update state.
 */
async function processIncomingPeerEvents(
  db: EncryptedStore,
  fold: Fold,
  events: EoEvent[]
): Promise<void> {
  for (const event of events) {
    // Dedup by client_event_id
    const existing = await db.get('log', event.client_event_id);
    if (existing) continue;

    // Store and fold
    await db.put('log', event.client_event_id, { ...event, synced: true });
    await fold.processEvent(db, event);
  }
}
```

---

## 8. Snapshot Hydration

```typescript
// src/sync/snapshot.ts

/**
 * Snapshot: a complete serialized state of the EO database at a point in time.
 * Stored as an encrypted binary file in the Matrix media repository.
 * Referenced by an eo.snapshot event in the room.
 *
 * Used for:
 *   - New device hydration (skip replaying entire log)
 *   - Backup (encrypted, on the homeserver)
 *   - Point-in-time archives
 */

interface Snapshot {
  version: 1;
  seq: number;                           // log position this snapshot represents
  ts: string;                            // ISO timestamp of snapshot creation
  created_by: string;                    // Matrix user ID
  state: Record<string, EoState>;        // all projected state entries
  graph_fwd: Record<string, GraphEdge>;  // all forward edges
  graph_rev: Record<string, GraphEdge>;  // all reverse edges
  eva: Record<string, EvaRegistration>;  // all EVA registrations
}

/**
 * Create a snapshot from current IndexedDB state.
 */
async function createSnapshot(db: EncryptedStore, myUserId: string): Promise<Snapshot> {
  const state: Record<string, EoState> = {};
  const allState = await db.getAll('state');
  for (const s of allState) state[s.target] = s;

  const graph_fwd: Record<string, GraphEdge> = {};
  const allFwd = await db.getAll('graph_fwd');
  for (const e of allFwd) graph_fwd[`${e.source}:${e.dest}`] = e;

  const graph_rev: Record<string, GraphEdge> = {};
  const allRev = await db.getAll('graph_rev');
  for (const e of allRev) graph_rev[`${e.dest}:${e.source}`] = e;

  const eva: Record<string, EvaRegistration> = {};
  const allEva = await db.getAll('eva');
  for (const e of allEva) eva[e.target] = e;

  const lastSeq = await db.get('meta', 'last_seq') || 0;

  return {
    version: 1,
    seq: lastSeq,
    ts: new Date().toISOString(),
    created_by: myUserId,
    state,
    graph_fwd,
    graph_rev,
    eva
  };
}

/**
 * Serialize, encrypt, and upload a snapshot to the Matrix media store.
 * Then post a reference event to the room.
 */
async function uploadSnapshot(
  client: MatrixClient,
  roomId: string,
  snapshot: Snapshot
): Promise<string> {
  // Serialize to msgpack
  const { pack } = await import('msgpackr');
  const binary = pack(snapshot);

  // Upload to media repository (Matrix SDK encrypts automatically for E2EE rooms)
  const uploadResult = await client.uploadContent(new Blob([binary]), {
    name: `eo-snapshot-${snapshot.seq}.bin`,
    type: 'application/octet-stream'
  });

  const mxcUrl = uploadResult.content_uri;

  // Post reference event to room
  await client.sendEvent(roomId, EO_SNAPSHOT_TYPE, {
    mxc: mxcUrl,
    seq: snapshot.seq,
    ts: snapshot.ts,
    size_bytes: binary.byteLength,
    version: snapshot.version
  });

  return mxcUrl;
}

/**
 * Find the latest snapshot reference in the room.
 */
async function findLatestSnapshot(
  client: MatrixClient,
  roomId: string
): Promise<{ mxc: string; seq: number } | null> {
  // Scan room state/timeline for eo.snapshot events
  const room = client.getRoom(roomId);
  const timeline = room.getLiveTimeline().getEvents();

  let latest: { mxc: string; seq: number } | null = null;
  for (const event of timeline) {
    if (event.getType() === EO_SNAPSHOT_TYPE) {
      const content = event.getContent();
      if (!latest || content.seq > latest.seq) {
        latest = { mxc: content.mxc, seq: content.seq };
      }
    }
  }

  return latest;
}

/**
 * Download, decrypt, and apply a snapshot to IndexedDB.
 */
async function applySnapshot(
  client: MatrixClient,
  db: EncryptedStore,
  mxcUrl: string
): Promise<number> {
  // Download from media store (Matrix SDK handles decryption)
  const response = await client.http.authedRequest(
    'GET',
    client.mxcUrlToHttp(mxcUrl)
  );

  // Deserialize
  const { unpack } = await import('msgpackr');
  const snapshot: Snapshot = unpack(new Uint8Array(response));

  // Clear existing state (fresh hydration)
  // Note: in a real implementation, use IDB transactions for atomicity

  // Load state
  for (const [target, state] of Object.entries(snapshot.state)) {
    await db.put('state', target, state);
  }

  // Load graph
  for (const [key, edge] of Object.entries(snapshot.graph_fwd)) {
    await db.put('graph_fwd', key, edge);
  }
  for (const [key, edge] of Object.entries(snapshot.graph_rev)) {
    await db.put('graph_rev', key, edge);
  }

  // Load EVA registrations
  for (const [target, reg] of Object.entries(snapshot.eva)) {
    await db.put('eva', target, reg);
  }

  // Set sync cursor
  await db.put('meta', 'last_seq', snapshot.seq);
  await db.put('meta', 'snapshot_seq', snapshot.seq);

  return snapshot.seq;
}

/**
 * Snapshot schedule: create automatically every 1000 events
 * or when user manually triggers.
 */
async function maybeCreateSnapshot(
  client: MatrixClient,
  roomId: string,
  db: EncryptedStore,
  myUserId: string
): Promise<void> {
  const lastSeq = await db.get('meta', 'last_seq') || 0;
  const lastSnapshotSeq = await db.get('meta', 'snapshot_seq') || 0;

  if (lastSeq - lastSnapshotSeq >= 1000) {
    const snapshot = await createSnapshot(db, myUserId);
    await uploadSnapshot(client, roomId, snapshot);
    await db.put('meta', 'snapshot_seq', lastSeq);
  }
}
```

---

## 9. The Fold — Unchanged

The fold from the server technical spec (§6) runs identically in the browser. The only differences:

- Storage calls go to IndexedDB (via `EncryptedStore`) instead of LevelDB
- Sequence numbers are initially local (fractional or UUID-ordered), then canonical once confirmed in the room
- The `processEvent` function is the same nine-case dispatch
- Dependent recomputation is the same CON-graph walk
- EVA classification (fold vs Horizon) is the same static analysis at DEF time
- The Horizon (three-layer read) is the same prefix walk + signal detection

No code changes to fold.ts or horizon.ts. Only the storage interface changes from LevelDB to IndexedDB.

---

## 10. Offline Support

The app works fully offline. No special mode. No degraded experience.

**Creating records offline:**

```
1. User creates a record (no internet)
2. App generates EO event with UUID client_event_id
3. Fold runs locally — state updates in IndexedDB
4. UI renders immediately from local state
5. Event stored in IndexedDB with synced: false
6. User continues working — all reads from local state

Later, internet returns:
7. SyncManager detects connectivity
8. Calls flushUnsyncedEvents()
9. Each unsynced event sent to Matrix room
10. Room confirms receipt
11. Event marked synced: true in IndexedDB
12. Canonical seq assigned from room ordering
```

**Reading offline:**

All reads come from local IndexedDB. The Horizon runs locally. Grounds, nearby, governance, trajectory, signals — all computed from local state. No server dependency for any read operation.

**Conflicts from offline edits:**

Two users edit the same field offline. Both sync when they reconnect. The room now has two DEF events on the same target from different agents. This is DEF doing what DEF does — both values coexist in the log with provenance. The EVA policy determines what the Horizon shows. No special conflict resolution needed. The fold handles it.

---

## 11. Matrix Room Setup

### 11.1 Room Creation (one-time)

```
Create room:
  name: "Amino EO Data"
  alias: #amino-data:app.aminoimmigration.com
  visibility: private (invite-only)
  encryption: enabled (Megolm)
  history_visibility: shared (members can see history from before they joined)
  power_levels:
    events_default: 0        — all members can send EO events
    state_default: 50        — only admins can change room settings
    invite: 50               — only admins can invite new members
```

### 11.2 Adding Users

```
1. Admin invites user to Matrix homeserver (create account)
2. Admin invites user to #amino-data room
3. User joins room on their device
4. User verifies their device (cross-signing with admin or another verified device)
5. User receives Megolm session keys (Matrix handles key sharing)
6. User's app syncs room history (or hydrates from snapshot)
7. User has the complete database
```

### 11.3 Removing Users

```
1. Admin kicks user from #amino-data room
2. User's device loses access to new events
3. User's device retains local IndexedDB (encrypted with session key)
4. On next login attempt, room membership check fails
5. App clears local data

Note: the user's device may retain decrypted data from before removal.
For sensitive environments, use device management (MDM) to remote-wipe.
Room key rotation after removal prevents access to new events.
```

---

## 12. GitHub Pages Deployment

### 12.1 Repository Setup

```
Repository: aminoimmigration/amino-eo-app (public — code only, no data)

GitHub Pages settings:
  Source: GitHub Actions
  Custom domain: app.aminoimmigration.com (or subdomain)
```

### 12.2 Build and Deploy

```yaml
# .github/workflows/deploy.yml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - uses: actions/deploy-pages@v4
```

### 12.3 Vite Config

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',                        // root of custom domain
  build: {
    target: 'es2022',               // for crypto.subtle, top-level await
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          matrix: ['matrix-js-sdk'], // separate chunk for Matrix SDK (~500KB)
        }
      }
    }
  },
  worker: {
    format: 'es'                     // for crypto WASM in web workers
  }
});
```

### 12.4 Security Headers

```
# public/_headers
/*
  Content-Security-Policy: default-src 'self'; connect-src 'self' https://app.aminoimmigration.com; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
```

The CSP allows connections only to the Matrix homeserver. No other external requests. The app code loads from GitHub Pages. The data flows only to/from `app.aminoimmigration.com`.

---

## 13. App Entry Point and Login Flow

```typescript
// src/main.ts

/**
 * App startup:
 *
 * 1. Check localStorage for existing Matrix session
 * 2. If no session → show Login screen
 * 3. If session exists → initialize Matrix client with stored credentials
 * 4. Initialize encrypted IndexedDB with session-derived key
 * 5. Initialize SyncManager
 *    a. Check for local state in IndexedDB
 *    b. If empty → hydrate from snapshot (or full room replay if no snapshot)
 *    c. If populated → sync room history from last known seq
 *    d. Announce to peers
 *    e. Flush any unsynced local events
 * 6. Initialize Zustand store from IndexedDB projected state
 * 7. Render CRM interface
 * 8. Listen for new events (room timeline + peer sync)
 */
```

### 13.1 Login Screen

```
┌──────────────────────────────────────┐
│                                      │
│      Amino Immigration              │
│      Case Management                │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  Username                      │  │
│  │  @sara                         │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │  Password                      │  │
│  │  ••••••••                      │  │
│  └────────────────────────────────┘  │
│                                      │
│  Server: app.aminoimmigration.com    │
│                                      │
│  ┌────────────────────────────────┐  │
│  │         Sign In                │  │
│  └────────────────────────────────┘  │
│                                      │
│  Data is end-to-end encrypted.       │
│  Your records never leave your       │
│  device unencrypted.                 │
│                                      │
└──────────────────────────────────────┘
```

Matrix login only. No separate user management. No separate auth system. The Matrix account IS the identity. The Matrix room membership IS the authorization. The Matrix device verification IS the key distribution.

---

## 14. n8n Integration (Optional)

The GitHub Pages app doesn't receive webhooks — it's static. For Airtable sync via n8n, two options:

### Option A: n8n has its own Matrix account

```
n8n has a Matrix bot account: @n8n:app.aminoimmigration.com
n8n joins #amino-data room
n8n uses matrix-js-sdk to send encrypted EO events to the room
Every device receives the events through normal room sync
```

n8n runs wherever it runs (a VM, a cloud service). It doesn't need to know about the app. It just sends events to the Matrix room. The room is the integration point. This is the cleanest option — n8n is just another device in the room.

### Option B: n8n posts to a tiny webhook relay

```
A minimal serverless function (Cloudflare Worker, Vercel Edge Function):
  1. Receives webhook from n8n
  2. Authenticates (shared secret)
  3. Logs into Matrix as @n8n bot
  4. Sends encrypted EO event to room
  5. Returns 200

~50 lines of code. No state. No database. Stateless relay.
```

---

## 15. Build Order

### Phase 1: Static app shell
- Set up Vite + React + TypeScript
- Configure GitHub Pages deployment
- Build login screen with Matrix SDK
- Verify: user can log in to Matrix from the static app

### Phase 2: IndexedDB + encrypted store
- Implement IDB schema
- Implement encrypted IndexedDB layer
- Implement key derivation from Matrix session
- Verify: data persists in IndexedDB, unreadable without session

### Phase 3: Fold in the browser
- Port fold.ts from server spec (nine-case dispatch)
- Port state, graph, EVA operations to use IndexedDB instead of LevelDB
- Port horizon.ts (three-layer read)
- Verify: fold processes test fixtures, state is correct

### Phase 4: Matrix event bridge
- Implement EO event ↔ Matrix event conversion
- Implement sending EO events to room
- Implement receiving and processing room events
- Verify: create a record, it appears in the Matrix room (encrypted)

### Phase 5: Sync manager
- Implement room history sync (paginate timeline, fold events)
- Implement offline queue (unsynced events flush on reconnect)
- Implement deduplication by client_event_id
- Verify: two devices sync through the room, state converges

### Phase 6: Peer sync
- Implement to-device messaging protocol (hello, offer, request, events)
- Implement gap detection and filling
- Verify: device A has events device B is missing, they exchange directly

### Phase 7: Snapshot hydration
- Implement snapshot creation (serialize state to msgpack)
- Implement snapshot upload to Matrix media store
- Implement snapshot download and application
- Implement automatic snapshot every 1000 events
- Verify: new device hydrates from snapshot, syncs tail, state matches

### Phase 8: CRM interface
- Build the six-layer record view (figure, ground, nearby, governance, trajectory, signals)
- Build the simplified CRM view (smart fields, inline annotations)
- Build the client list sidebar
- Connect to Zustand store backed by IndexedDB
- Verify: full CRM experience with live data

### Phase 9: Admin view (optional)
- Build the admin/explorer view from the earlier mockup
- Target tree with grounds visible in navigation
- Operator-coded log view
- Graph visualization
- Replay slider

---

## 16. What This Replaces

- The VM server (eo-db on a VM with LevelDB) — replaced by the browser
- Postgres — already replaced, now the browser storage replaces LevelDB too
- The WebSocket sync server — replaced by Matrix room sync + peer-to-peer
- The webhook endpoint — replaced by n8n posting directly to the Matrix room
- Custom auth middleware — replaced by Matrix login
- Custom backup tooling — replaced by encrypted snapshots in Matrix media store
- nginx reverse proxy — not needed, GitHub Pages serves the app

**What remains:**
- The Matrix homeserver at app.aminoimmigration.com (already running)
- GitHub Pages (free)
- The nine operators, the fold, the Horizon — unchanged, running in the browser
- n8n (if Airtable sync is needed) — posts to Matrix room instead of a webhook endpoint

---

## 17. Security Model

```
Threat                          Mitigation
─────────────────────────────────────────────────────────────────
GitHub compromise               Code only, no data. Verify builds via git hash.
Matrix homeserver compromise    E2EE — server stores only encrypted blobs.
                                Attacker gets ciphertext without keys.
Stolen laptop (locked)          Full-disk encryption (OS-level).
Stolen laptop (unlocked)        IndexedDB encrypted with session key.
                                Logging out discards the key.
Fired employee                  Remove from Matrix room. Rotate room keys.
                                Device management for remote wipe.
Man-in-the-middle               TLS to homeserver. Megolm for event content.
                                Matrix device verification prevents MITM on keys.
Lost device keys                Matrix key backup (encrypted, on homeserver).
                                Or re-verify from another device.
Browser extension snooping      CSP restricts to self + homeserver only.
                                No third-party scripts.
```

---

## 18. What This Does NOT Include

- **Formula engine** — the fold's formula executor is a placeholder. Phase 2 work.
- **Type registry** — multi-modal operand types. Not needed for the law firm's workload.
- **WebRTC peer-to-peer** — direct device-to-device without homeserver relay. Future optimization. Matrix to-device messaging works for now.
- **Progressive web app (PWA)** — service worker for full offline install. Straightforward addition but not in Phase 1.
- **Mobile native** — the app runs in mobile browsers. A native wrapper (Capacitor, Tauri Mobile) is a future option.
