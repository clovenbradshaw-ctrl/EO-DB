# Matrix Sync & Spaces Specification

> How EO-DB persists, discovers, and hydrates data through Matrix.

This document describes the current implementation as of the source code in
`github-matrix-dev/app/src/matrix/`. It covers four areas:

1. [Saving Content to Matrix Rooms](#1-saving-content-to-matrix-rooms)
2. [Discovering Existing Spaces](#2-discovering-existing-spaces)
3. [Hydration: Timeline vs Media Snapshots](#3-hydration-timeline-vs-media-snapshots)
4. [Full Save/Sync Lifecycle End-to-End](#4-full-savesync-lifecycle-end-to-end)

---

## 1. Saving Content to Matrix Rooms

### 1.1 Event Bridge

All EO events are sent as custom Matrix room events with the type derived from
a configurable prefix (default `com.eo-db`):

| Custom event type | Matrix event kind | Purpose |
|---|---|---|
| `{prefix}.event` | Timeline event | EO fold event (INS, DEF, CON, etc.) |
| `{prefix}.snapshot` | Timeline event | Snapshot media reference |
| `{prefix}.snapshot_state` | Room state event | Latest snapshot URI (O(1) lookup) |
| `com.eo-db.space.config` | Room state event | Space identity & room pointers |
| `com.eo-db.schema.manifest` | Room state event | Schema for redaction bars |
| `com.eo-db.key.announce` | Room state event | Encryption key material |

**Invariant:** The `agent` field is **never** included in the Matrix event
content. On receipt, agent is always derived from `matrixEvent.getSender()`.
This prevents spoofing — Matrix guarantees sender authenticity.

Megolm encryption is handled transparently by the SDK (`client.sendEvent()`
encrypts in E2EE rooms). The homeserver never sees plaintext event content.

*Source: `event-bridge.ts:36-52`*

### 1.2 Local-First Write Path

```
processLocalEvent(event)
  │
  ├─ 1. Derive client_event_id = eventHash(op + target + operand + agent + ts)
  │     Content-addressable: same event from two offline devices → same hash
  │
  ├─ 2. Fold locally via processEvent(store, event, onEvent)
  │     Instant UI update — no round-trip
  │
  ├─ 3. Send to Matrix room (best-effort)
  │     sendEoEvent(client, roomId, event)
  │     │
  │     └─ On failure → enqueueOfflineEvent(event)
  │
  └─ 4. maybeCreateSnapshot() — auto-snapshot every 500 log entries
```

This is the core write path in `SyncManager.processLocalEvent()`. Every write
folds into local state before touching the network. The UI sees the change
immediately; Matrix is the replication layer, not the write-ahead log.

*Source: `sync-manager.ts:316-362`*

### 1.3 Offline Queue

When `sendEoEvent()` throws (device is offline, network timeout, etc.), the
event is appended to `meta:offline_queue` in IndexedDB.

**Queue mechanics:**

- **Mutex-protected writes** — `queueMutex` (an `AsyncMutex`) prevents
  concurrent send-failures from racing on the queue array.
- **Individual retry** — `flushUnsyncedEvents()` tries each queued event
  independently. A failure on event #2 does not prevent event #3 from being
  attempted. Successfully sent events are removed; failures stay queued.
- **Dedup-safe** — The receiver deduplicates via content-addressable
  `client_event_id`, so re-sending an event already received (e.g., via peer
  sync) is a no-op.

```
flushUnsyncedEvents()
  └─ mutex.run:
       for each event in queue:
         try sendEoEvent() → remove from queue
         catch → keep in queue
       store.put('meta:offline_queue', remaining)
```

*Source: `sync-manager.ts:392-433`*

### 1.4 Auto-Snapshots

Every 500 log entries, the system creates a delta snapshot and uploads it to
Matrix media:

```
maybeCreateSnapshot()
  if (lastSeq - lastSnapshotSeq >= 500):
    delta = createDeltaSnapshot(store, myUserId)
    mxc   = uploadDeltaSnapshot(client, roomId, delta)
    store.put('meta:snapshot_seq', lastSeq)
    store.put('meta:snapshot_mxc', mxc)
    store.put('meta:snapshot_prev_mxcs', [mxc, ...prevMxcs].slice(0, 25))
```

The snapshot is msgpack-encoded, uploaded as `application/octet-stream`, and
referenced by both a timeline event (for timeline-walking fallback) and a room
state event (for O(1) fast lookup).

**Threshold:** 500 events (constant `SNAPSHOT_FREQUENCY`). Below this, the
room timeline alone is sufficient for hydration.

*Source: `snapshot.ts:128-147`*

### 1.5 Multi-Room Topology

Each EO-DB space can span up to **3 Matrix rooms**:

| Room | Contents | Power level required |
|------|----------|---------------------|
| **Main** | General records, public fields | Viewer (PL 0) |
| **Restricted** | Sensitive fields (SSN, salary, etc.) | Editor (PL 25+) |
| **Governance** | Policies, schema changes, view definitions | Admin (PL 50+) |

All three rooms carry the same `com.eo-db.space.config` state event.
`SyncManager.addRooms()` registers additional room IDs, and the timeline
listener processes events from all rooms into the **same fold**:

```typescript
// sync-manager.ts:139-143
this.handleTimelineEvent = (event: MatrixEvent) => {
  const eventRoomId = event.getRoomId();
  if (eventRoomId !== this.roomId && !this.additionalRoomIds.includes(eventRoomId!)) return;
  if (event.getType() !== EO_EVENT_TYPE) return;
  this.processIncomingEvent(event);
};
```

**Membership = access boundary.** A user who is not invited to the restricted
room never receives its events. The SDK's Megolm session management ensures
decryption keys are only shared with room members.

*Source: `sync-manager.ts:80-103`, `room-topology.ts`*

---

## 2. Discovering Existing Spaces

### 2.1 Space Config State Event

A space's identity is a Matrix room state event:

```
Type:      com.eo-db.space.config
State key: "" (empty)
Content: {
  name: string,           // e.g. "Amino"
  rooms: {
    main: string,         // room ID of the main data room
    restricted?: string,  // room ID (created on-demand)
    governance?: string,  // room ID (created on-demand)
  },
  field_assignments?: Record<string, 'main' | 'restricted'>,
  ...
}
```

This event lives in the governance room (or main room if governance doesn't
exist yet). It is the **sole marker** that identifies a Matrix room as part of
an EO-DB space.

### 2.2 Discovery Algorithm

```
discoverSpacesFromMatrix(client: MatrixClient): SpaceEntry[]
  │
  ├─ for each room in client.getRooms():
  │     configEvent = room.currentState.getStateEvents('com.eo-db.space.config', '')
  │     if (!configEvent) continue
  │     if (!config.name || !config.rooms.main) continue
  │
  ├─ Extract metadata:
  │     spaceTarget    = "space_" + slugify(config.name)
  │     mainRoomId     = config.rooms.main
  │     createdAt      = m.room.create event timestamp
  │     ownerUserId    = first user with PL >= 100 (or room creator)
  │     memberCount    = room.getJoinedMembers().length
  │     lastActivity   = latest timeline event timestamp
  │
  ├─ Deduplicate by spaceTarget (first match wins)
  │
  └─ Return sorted by lastActivity descending
```

*Source: `space-discovery.ts:50-100`*

### 2.3 Cross-Device Behavior

**There is no central space registry.** The rooms themselves are the registry.
Any device that has joined the same rooms will discover the same spaces,
because Matrix replicates room state to all members.

- A new device logs in, the Matrix client syncs, and `client.getRooms()`
  returns all joined rooms — including their current state events.
- `discoverSpacesFromMatrix()` scans those rooms and finds every space the
  user belongs to.
- The root IndexedDB (`eo-db`) supplements this with locally-cached space
  state for faster startup. If it's empty (new device), Matrix discovery
  populates it.

**Lazy room creation:** Restricted and governance rooms are created on-demand.
A space may start as a single main room and gain additional rooms only when an
admin enables restricted fields or governance features.

---

## 3. Hydration: Timeline vs Media Snapshots

### 3.1 Initialization Sequence

`SyncManager.initialize()` runs exactly this sequence:

```
initialize()
  │
  ├─ 1. currentSeq = store.getCurrentSeq()
  │
  ├─ 2. if (currentSeq === 0):           ← fresh device
  │       hydrateFromSnapshot()           ← fast path via Matrix media
  │
  ├─ 3. replayTimelineEvents()           ← always runs (covers gaps)
  │
  ├─ 4. client.on('Room.timeline', ...)  ← live listener for new events
  │
  └─ 5. flushUnsyncedEvents()            ← drain offline queue
```

Steps 2 and 3 together guarantee that a new device recovers all available
state regardless of whether snapshots exist.

*Source: `sync-manager.ts:124-150`*

### 3.2 Snapshot Hydration (Fast Path)

**Finding the latest snapshot:**

```
findLatestSnapshot(client, roomId)
  │
  ├─ Fast path (O(1)):
  │     room.currentState.getStateEvents('com.eo-db.snapshot_state', '')
  │     → { mxc, seq }
  │
  └─ Slow fallback (pagination):
        Walk room timeline backwards, looking for com.eo-db.snapshot events
        Return highest seq found
```

**Restoring from the delta chain:**

```
restoreFromDeltaChain(client, store, latestMxc)
  │
  ├─ Download head delta from latestMxc
  │     if (head.to_seq <= localSeq) → nothing to apply
  │
  ├─ while (oldest delta's from_seq > localSeq):
  │     Batch-fetch up to 25 prev_mxcs in parallel
  │     Filter out already-seen mxc URIs
  │     Skip deltas whose to_seq <= localSeq
  │     Sort all collected deltas by from_seq ascending
  │
  └─ Apply events chronologically through fold engine
        for each delta:
          for each event where event.seq > localSeq:
            processEvent(store, event, onEvent)
```

**Performance:** Each delta carries up to 25 `prev_mxcs`, so a single
round-trip fetches ~26 deltas. For a space with 10,000 events and snapshots
every 500, that's 20 deltas — fetched in a single batch.

*Source: `snapshot.ts:53-104, 233-292`*

### 3.3 Timeline Replay (Always Runs)

After snapshot hydration (or if no snapshot exists), `replayTimelineEvents()`
walks the events already present in the room's live timeline from the initial
Matrix sync:

```
replayTimelineEvents()
  room = client.getRoom(roomId)
  for event in room.getLiveTimeline().getEvents():
    if event.type !== EO_EVENT_TYPE → skip
    processIncomingEvent(event)
```

The fold engine deduplicates via `client_event_id`. Events already applied
from the snapshot are silently skipped. This handles:

- Rooms that predate snapshot-based tracking
- Events that arrived between the latest snapshot and now
- Rooms where no snapshot has ever been created (< 500 events)

*Source: `sync-manager.ts:180-190`*

### 3.4 Delta Snapshot Format

```typescript
interface DeltaSnapshot {
  version: 2;
  type: 'delta';
  from_seq: number;      // exclusive — events AFTER this seq
  to_seq: number;        // inclusive — up to and including
  prev_mxcs: string[];   // most-recent-first, max 25 URIs
  ts: string;            // ISO 8601
  created_by: string;    // Matrix user ID
  events: EoEvent[];     // the actual log events
}
```

**Encoding:** Msgpack via `msgpackr`. Uploaded as `application/octet-stream`
to Matrix media. Filename: `eo-delta-{from_seq}-{to_seq}.bin`.

**Chain structure:** Each delta's `prev_mxcs` points to the preceding
snapshots. Walking the chain backwards reconstructs the full log. If any blob
is missing from the media store, the room timeline is the fallback.

*Source: `snapshot.ts:114-123, 178-203`*

### 3.5 Peer Sync (Device-to-Device Gap Filling)

In addition to room timeline + snapshots, devices can fill gaps directly via
Matrix to-device messaging:

```
Protocol (4 message types, all via sendToDevice):

  hello   → Announce { my_seq, my_fingerprint, my_device, room_id }
              Sent to all joined members except self

  offer   ← Respond { my_seq, my_fingerprint, has_events_you_need,
                       needs_events_from_you, fingerprint_match }
              Evaluates whether gap exists

  request → Ask peer { need_from, from_device }
              If fingerprints diverge: need_from = 0 (full exchange)
              If fingerprints match:   need_from = mySeq

  events  ← Batch of EoEvents (max 50 per message)
              Batched with batch_index / total_batches metadata
```

**Store fingerprint:** A hash of all projected state entries
(`target + last_seq + hash`). Detects divergence even when two devices have
the same seq number but different event histories (e.g., both created events
offline and neither has seen the other's yet).

**When fingerprints diverge:** The requesting device asks for events from seq 0
(full history). The fold engine deduplicates via content-addressable hashing,
so receiving redundant events is harmless.

*Source: `peer-sync.ts:1-244`*

---

## 4. Full Save/Sync Lifecycle End-to-End

### 4.1 Login & Client Setup

```
User logs in
  │
  ├─ createMatrixClient(homeserver, accessToken)
  ├─ client.startClient({ initialSyncLimit: 0 })
  │     Matrix initial sync — fetches room list + state
  │
  ├─ discoverSpacesFromMatrix(client)
  │     Scans joined rooms for space configs
  │
  └─ Load root IDB ('eo-db')
        Query states by prefix 'space.' for cached space definitions
        If root seq === 0 → hydrate root from Matrix snapshot
```

### 4.2 Space Selection

```
User selects a space
  │
  ├─ Check cache (spaceTarget → { store, syncManager })
  │
  ├─ If not cached:
  │     Open space-scoped IDB: 'eo-db::space_{name}'
  │     Derive encryption key from userId + deviceId (stable across sessions)
  │     Create EncryptedStore wrapper (AES-GCM at rest)
  │     Create SyncManager(client, mainRoomId, store, onEvent)
  │     syncManager.addRooms([restrictedRoomId, governanceRoomId])
  │     syncManager.initialize()
  │     Cache for fast re-access
  │
  └─ If cached:
        Create fresh SyncManager (old one was destroyed)
        Reuse existing store
        initialize() — replays timeline, skips snapshot (seq > 0)
```

### 4.3 Steady State

**Local event creation:**
```
User action
  → processLocalEvent()
    → hash-derive client_event_id
    → fold locally (instant UI)
    → sendEoEvent to Matrix (best-effort)
    → on failure: enqueue offline
    → maybeCreateSnapshot (every 500 events)
```

**Incoming Matrix event:**
```
Room.timeline fires
  → filter: correct room? correct event type?
  → matrixEventToEo(): extract agent from sender
  → fast dedup: check idem:{client_event_id} in store
  → if not seen: processEvent() through fold → UI update
```

**Peer sync (background):**
```
PeerSync.start()
  → announce hello to all room members
  → listen for toDeviceEvent
  → on hello: compare seq + fingerprint → offer
  → on offer with has_events_you_need: request missing range
  → on events: fold each through processEvent (dedup handles overlap)
```

### 4.4 Manual & Auto Snapshots

**Auto (every 500 events):**
Called from `processLocalEvent()` after each fold. Transparent to the user.

**Manual (`manualSnapshot()`):**
1. Create delta snapshot from log events since last snapshot
2. Upload to Matrix media (msgpack blob)
3. Record mxc URI in a NUL event (`system.snapshot` target) — discoverable from log
4. Update `meta:snapshot_seq`, `meta:snapshot_mxc`, `meta:snapshot_prev_mxcs`
5. Set room state event for O(1) fast-path lookup on next device

### 4.5 Page Unload & Teardown

```
visibilitychange → 'hidden'
  │
  ├─ For each cached space:
  │     syncManager.saveSnapshot()
  │       → createDeltaSnapshot
  │       → uploadDeltaSnapshot
  │       → setSnapshotStateEvent
  │
  └─ syncManager.destroy()
        Remove Room.timeline listener
        Set destroyed = true (guards against stale event injection)
```

### 4.6 Invariants & Guarantees

| Invariant | Mechanism |
|-----------|-----------|
| **Room timeline is source of truth** | Snapshots are optimization; timeline replay always runs after snapshot hydration |
| **Events are never applied twice** | Content-addressable `client_event_id` + idempotency check in fold (`idem:{id} → seq`) |
| **Offline-first** | All writes fold locally before network send; UI sees changes instantly |
| **No server-side plaintext** | Local: AES-GCM encrypted IndexedDB. Matrix: Megolm E2EE. Homeserver sees ciphertext only |
| **Agent authenticity** | Agent derived from `matrixEvent.getSender()`, never from event content |
| **Membership = access** | Megolm keys shared only with room members; restricted room membership gates field access |
| **Snapshot chain integrity** | Each delta links to up to 25 predecessors; if any blob is lost, timeline fallback works |
| **Offline queue atomicity** | Mutex-protected read-modify-write prevents concurrent corruption |
| **Peer sync convergence** | Store fingerprint detects divergence even at same seq; full exchange + dedup guarantees eventual consistency |

---

## Appendix: Key Storage Layout

### IndexedDB (per-space, AES-GCM encrypted)

| Key prefix | Value | Purpose |
|------------|-------|---------|
| `state:{target}` | `EoState` | Projected state for each target |
| `log:{padded_seq}` | `EoEvent` | Append-only event log |
| `idem:{client_event_id}` | `seq` | Idempotency — prevents duplicate events |
| `graph:fwd:{source}` | `[dest...]` | CON adjacency (forward) |
| `graph:rev:{dest}` | `[source...]` | CON adjacency (reverse) |
| `eva:{target}` | registration | EVA-active formula registrations |
| `meta:seq` | `number` | Current sequence number |
| `meta:snapshot_seq` | `number` | Seq of last snapshot |
| `meta:snapshot_mxc` | `string` | mxc URI of last snapshot |
| `meta:snapshot_prev_mxcs` | `string[]` | Chain of previous snapshot URIs |
| `meta:offline_queue` | `EoEventInput[]` | Events queued for send |

### Matrix Custom Event Types

| Event type | Kind | Content |
|------------|------|---------|
| `com.eo-db.event` | Timeline | `{ op, target, operand, client_event_id, ts, meta }` |
| `com.eo-db.snapshot` | Timeline | `{ mxc, seq, ts, size_bytes, version, type }` |
| `com.eo-db.snapshot_state` | State (key `""`) | `{ mxc, seq, ts }` |
| `com.eo-db.space.config` | State (key `""`) | `{ name, rooms, field_assignments, ... }` |
| `com.eo-db.key.announce` | State (key `{key_id}`) | `{ key_id, material, metadata }` |
| `com.eo-db.sync.hello` | To-device | `{ my_seq, my_fingerprint, my_device, room_id }` |
| `com.eo-db.sync.offer` | To-device | `{ my_seq, my_fingerprint, has_events_you_need, ... }` |
| `com.eo-db.sync.request` | To-device | `{ need_from, from_device }` |
| `com.eo-db.sync.events` | To-device | `{ events[], batch_index, total_batches }` |
