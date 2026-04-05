# EO///DB Syncing Guide

> What each sync layer is **supposed to do** vs **what currently exists**.

EO-DB uses a three-layer sync strategy. Every write folds locally first (instant UI), then replicates outward through progressively durable tiers. There is no central server — the fold runs in every browser.

```
┌─────────────────────────────────────────────────────────┐
│                    Local IndexedDB                       │
│              (Tier 1 — primary working store)            │
└──────────────┬──────────────────────┬────────────────────┘
               │                      │
       ┌───────▼───────┐      ┌───────▼───────┐
       │  Matrix Room   │      │  P2P Direct   │
       │  (Tier 2)      │      │  (optimization)│
       └───────┬───────┘      └───────────────┘
               │
       ┌───────▼───────┐
       │  Filen Cloud   │
       │  (Tier 3)      │
       └───────────────┘
```

---

## 1. Matrix Room Sync

### What it's SUPPOSED to be

The **primary real-time replication layer**. All devices in a space share an E2EE Matrix room. Events flow through the room timeline, establishing canonical ordering. Matrix is the source of truth for event order — if snapshots and the room timeline disagree, the timeline wins.

**Design goals:**
- Local-first: fold instantly in browser, sync to Matrix async
- Content-addressable deduplication via `client_event_id` hashing
- Offline queue: events composed offline are flushed on reconnect
- Delta snapshots uploaded to Matrix media for fast new-device bootstrap
- 3-room topology for access control (main / restricted / governance)
- Peer sync via to-device messages for gap filling between devices

### What it CURRENTLY is

**Fully implemented in `src/matrix/`.** This is the active, production sync layer.

#### Core Files

| File | Lines | Role |
|------|-------|------|
| `src/matrix/sync-manager.ts` | ~815 | Orchestrates initialization, offline queue, snapshot creation, live event handling |
| `src/matrix/snapshot.ts` | ~402 | Delta snapshot creation, upload to Matrix media, chain restoration via `prev_mxcs` |
| `src/matrix/send-buffer.ts` | ~168 | Batches events (10s timer OR 500-event threshold) to avoid rate limits |
| `src/matrix/event-bridge.ts` | ~110 | Converts between Matrix events (`com.eo-db.event`) and EO events; agent always derived from Matrix sender |
| `src/matrix/peer-sync.ts` | ~262 | Device-to-device gap filling via to-device messages (see P2P section below) |
| `src/matrix/room-topology.ts` | ~370 | 3-room structure creation and management (main/restricted/governance) |
| `src/matrix/space-discovery.ts` | ~97 | Discovers spaces by scanning joined rooms for `com.eo-db.space.config` state events |
| `src/matrix/types.ts` | ~217 | Role enums, SpaceConfig, field assignments, power levels |

#### Write Path (Local -> Matrix)

```
User creates event
  → Hash-derive deterministic client_event_id (op + target + operand + agent + ts)
  → Fold immediately into local IndexedDB (UI updates instantly)
  → Enqueue in SendBuffer
  → SendBuffer flushes every 10s or at 500 events
    → Creates delta snapshot (msgpack binary)
    → Uploads to Matrix media
    → Posts lightweight timeline event with mxc:// reference
    → Updates room state for O(1) lookup
  → On failure: event goes to offline queue (IndexedDB, meta:offline_queue)
  → Retry up to 5 times with backoff
```

#### Read Path (Matrix -> Local, new device)

```
Fresh device (seq === 0)
  → Check room state for com.eo-db.snapshot_state (O(1) lookup)
  → Download latest snapshot from Matrix media
  → Walk prev_mxcs chain (up to 25 snapshots per link, batch-fetched)
  → Apply all events through fold
  → Replay room timeline events after snapshot seq
  → Attach live listener for new events
  → Flush any offline queue
```

#### Snapshots

- **Format:** msgpack binary with version, type, from_seq, to_seq, prev_mxcs (up to 25), events array
- **Frequency:** Every 500 events (configurable via `SNAPSHOT_FREQUENCY`)
- **Storage:** Matrix media repository (encrypted via Megolm)
- **Lookup:** Room state event `com.eo-db.snapshot_state` provides O(1) access to latest snapshot URI + seq

#### Multi-Room Access Control

| Room | Power Level | Contains |
|------|------------|----------|
| Main | 0 (viewers) | General records, public fields |
| Restricted | 25+ (editors) | Sensitive fields (SSN, salary, etc.) |
| Governance | 50+ (admins) | Policies, schema, EVA definitions |

All three rooms fold into the same state via `additionalRoomIds`. Megolm key sharing ensures users without room membership never receive restricted data.

#### Custom Matrix Event Types

| Event Type | Kind | Purpose |
|---|---|---|
| `com.eo-db.event` | Timeline | EO fold event (INS, DEF, CON, etc.) |
| `com.eo-db.snapshot` | Timeline | Snapshot media reference |
| `com.eo-db.snapshot_state` | Room State | Latest snapshot URI for O(1) hydration |
| `com.eo-db.import` | Timeline | Grounded imports (batched events with provenance) |
| `com.eo-db.space.config` | Room State | Space identity, room pointers, field assignments |
| `com.eo-db.schema.manifest` | Room State | Schema for redaction bars |
| `com.eo-db.key.announce` | Room State | Encryption key material |

#### Status: PRODUCTION-READY

Everything described above is implemented and active. Remaining polish items from DEVELOPMENT-STAGES.md (Stages 6-7):
- Admin settings panel needs polish
- Loading spinners during sync/hydration
- Progress indicator for snapshot downloads
- Error toasts for sync failures
- Dead code cleanup from server era

---

## 2. Filen Cloud Backup

### What it's SUPPOSED to be

The **backup and disaster-recovery tier** (Tier 3). Filen acts as durable cloud storage for encrypted `.eodb` binary files. Unlike Matrix (which is real-time event sync), Filen stores periodic backup deltas and full snapshots as immutable files. Matrix room state events coordinate which backup is current, so devices can hydrate from Filen if Matrix media is unavailable.

**Design goals:**
- 30-second timer-based sync cycle uploads backup deltas to Filen
- Full snapshots every 5,000 events (vs 500 for Matrix snapshots)
- Encrypted before upload (AES-256-GCM with Filen v002 standard)
- Matrix state events (`eo.backup.head`, `eo.backup.horizon`) coordinate head pointers
- Dead-drop sharing: cross-account data exchange via public links + one-time encryption keys sent through Matrix
- Org mode: shared Filen account across team, config stored in Matrix room state
- Backup health monitoring for dashboard UI

**Intended folder structure on Filen:**
```
/EO-DB/
  └── {anonymized-space-uuid}/
      ├── backup-{seq}-{timestamp}.eodb       (delta, every 30 sec)
      ├── snapshot-00005000.eodb              (full state, every 5000 events)
      ├── snapshot-00010000.eodb
      ├── shared/
      │   └── share-{seq}-{timestamp}.eodb.enc  (dead-drop shares)
      └── private/
          └── {userId}/
              └── private.eodb                (per-user encrypted data)
```

**Intended write path:**
```
Every 30 seconds: FilenSyncService.syncCycle()
  → Read Matrix eo.backup.head state event
  → If another client already covers our seq, skip
  → If throttled (max 1 signal per 10s), skip
  → Read all events since last snapshot
  → Pack as .eodb binary (msgpack with "EODB" magic header)
  → Upload to Filen with unique filename: backup-{seq}-{timestamp}.eodb
  → Signal via Matrix timeline event eo.backup.signal
  → Update Matrix state event eo.backup.head
  → Clean up old backup files (keep last 3)
  → If seq >= last_snapshot_seq + 5000: create full snapshot
```

**Intended read path (new device hydration from Filen):**
```
FilenSyncService.hydrateFromFilen()
  → List all .eodb files in space folder on Filen
  → Find latest snapshot (highest seq number)
  → Download and unpack snapshot, fold all events
  → Download and apply all backup files with seq > snapshot seq
  → Return final seq
```

**Intended multi-client coordination:**
```
Client A (seq 150)               Client B (seq 120)
  → Read eo.backup.head (100)      → Read eo.backup.head (100)
  → 150 > 100, not covered         → 120 > 100, not covered
  → Upload backup, update head=150  → (next cycle) Read head=150
                                    → 120 < 150, COVERED → skip
```

**Intended dead-drop sharing:**
```
Sender:
  → Pack events as .eodb
  → Encrypt with random one-time AES-256-GCM key
  → Upload to Filen /shared/ subfolder
  → Create public link (7-day expiry)
  → Send link URL + encryption key via Matrix (Megolm E2EE)

Receiver:
  → Download from Filen public link
  → Verify SHA-256 checksum
  → Decrypt with one-time key from Matrix event
  → Unpack .eodb and fold events
```

### What it CURRENTLY is

**NOT integrated into `src/`.** All Filen code exists only in `github-matrix-dev/app/src/filen/` as a developed-but-unmerged feature branch.

#### Code That Exists (in `github-matrix-dev/app/src/filen/`)

| File | Role | Status |
|------|------|--------|
| `filen-api.ts` | Full Filen REST API: login (PBKDF2), AES-256-GCM encrypt/decrypt, folder CRUD, file upload/download, public links, trash | Written, not in `src/` |
| `filen-sync.ts` | 30s sync service: backup uploads, snapshot creation (5K events), cleanup, hydration, Matrix coordination | Written, not in `src/` |
| `filen-store.ts` | Zustand session store: auth persistence, org-mode, space folder management, auto re-login | Written, not in `src/` |
| `filen-share.ts` | Dead-drop sharing: one-time encryption, public links, share lifecycle management | Written, not in `src/` |
| `eodb-format.ts` | Binary container format: `[4-byte "EODB" magic][msgpack body]`, pack/unpack functions | Written, not in `src/` |
| `backup-monitor.ts` | Reads Matrix room state to compute backup health metrics for dashboard | Written, not in `src/` |

#### UI Components That Exist (in `github-matrix-dev/`)

- **FilenAdminConfig** — Admin panel for Filen credentials, saves to Matrix room state `eo.filen.config`
- **FilenStorageWidget** — File browser showing all `.eodb` files in Filen
- **DataSyncDashboard** — Health dashboard showing backup status, connected peers, sync tiers

#### Matrix Events for Filen Coordination (defined but not used in `src/`)

| Event Type | Kind | Purpose |
|---|---|---|
| `eo.backup.head` | Room State | Points to latest backup file |
| `eo.backup.horizon` | Room State | Points to latest snapshot |
| `eo.backup.signal` | Timeline | Announces backup upload |
| `eo.compact.signal` | Timeline | Announces snapshot creation |
| `eo.filen.config` | Room State | Org-mode shared Filen credentials |
| `filen.share.event` | Timeline | Share announcement with download URL + encryption key |
| `filen.share.latest` | Room State | Pointer to latest share |

#### What's Missing to Ship

- Merge `github-matrix-dev/app/src/filen/` into `src/filen/`
- Wire FilenSyncService into the app lifecycle (start/stop with auth)
- Add UI components to the main app layout
- Test the 30s sync cycle against live Filen API
- Validate multi-client coordination via Matrix state events
- Handle edge cases: Filen downtime, quota limits, partial uploads

---

## 3. P2P Device-to-Device Sync

### What it's SUPPOSED to be

**Low-latency optimization** for filling gaps between devices without waiting for Matrix room sync. Two protocols:

1. **To-device messaging** — Uses Matrix's encrypted to-device transport for a lightweight 4-phase handshake. Devices exchange fingerprints (hash of projected state) to detect divergence and exchange missing events directly.

2. **WebRTC DataChannel** — Direct browser-to-browser connection for high-bandwidth scenarios (e.g., bootstrapping a new device from a nearby peer). SDP/ICE signaling goes through Matrix; the actual data transfer bypasses the homeserver entirely.

**Design goals:**
- Detect divergence even when two devices have the same seq but different histories (via state fingerprinting)
- Fill gaps faster than waiting for Matrix room timeline pagination
- WebRTC for bulk transfers without homeserver relay overhead
- DTLS 1.2+ encryption on WebRTC (browser-enforced)
- Optional segment-key encryption for keyring-protected spaces

### What it CURRENTLY is

**Partially implemented.** To-device peer sync is in `src/`. WebRTC is written but not integrated.

#### To-Device Peer Sync — IMPLEMENTED in `src/matrix/peer-sync.ts`

Four-phase handshake protocol:

```
Phase 1: HELLO
  Device A → all room members (to-device)
  Payload: { my_seq, my_fingerprint, my_device, room_id }
  Fingerprint = hash of all (target + last_seq + hash) entries in projected state

Phase 2: OFFER
  Device B → Device A (to-device)
  Payload: { my_seq, my_fingerprint, has_events_you_need, needs_events_from_you, fingerprint_match }
  Decision: "Do we need to sync?"

Phase 3: REQUEST
  Device A → Device B (to-device)
  Payload: { need_from: [mySeq OR 0], from_device }
  If fingerprints match: need_from = mySeq (delta sync — just the gap)
  If fingerprints diverge: need_from = 0 (full exchange — fold deduplicates)

Phase 4: EVENTS
  Device B → Device A (to-device)
  Payload: { events[], batch_index, total_batches }
  Batches of up to 50 events (to-device message size limits)
```

**Key property:** Fingerprint-based divergence detection catches the case where two devices have the same seq number but different event histories (both created events offline). When fingerprints don't match, a full exchange happens and the fold's content-addressable deduplication ensures no double-application.

#### WebRTC P2P — EXISTS in `github-matrix-dev/app/src/matrix/webrtc-peer.ts`, NOT in `src/`

| Feature | Status |
|---------|--------|
| Matrix-signaled SDP/ICE exchange (Megolm encrypted) | Written |
| WebRTC DataChannel with DTLS 1.2+ | Written |
| Chunked transfer protocol (50 events per chunk, resumable) | Written |
| Transfer headers (total_events, from_seq, to_seq) | Written |
| Ping/pong keepalive (30s) | Written |
| Optional segment-key encryption | Written |
| Integration into `src/` | **Not done** |

#### What P2P Carries vs Doesn't

| Carried via P2P | NOT carried via P2P |
|-----------------|---------------------|
| Individual EO events (op, target, operand, metadata) | Snapshots (always via Matrix media or Filen) |
| Batched in 50-event chunks | Schema/governance changes (room state events) |
| Full or delta based on fingerprint match | Key material (Megolm key sharing, separate protocol) |

#### What's Missing to Ship WebRTC

- Merge `webrtc-peer.ts` into `src/matrix/`
- Wire WebRTC peer discovery into the sync manager
- Add UI for peer connection status
- Handle NAT traversal edge cases (TURN server configuration)
- Test cross-browser compatibility

---

## Summary: Current State at a Glance

| Layer | Intended Role | Code Location | Status |
|-------|--------------|---------------|--------|
| **Matrix Room Sync** | Primary real-time replication, source of truth for event ordering | `src/matrix/` | **Production-ready** |
| **Matrix Snapshots** | Fast hydration for new devices via delta chain in Matrix media | `src/matrix/snapshot.ts` | **Production-ready** |
| **P2P To-Device** | Gap filling between devices via fingerprint-based 4-phase handshake | `src/matrix/peer-sync.ts` | **Implemented** |
| **P2P WebRTC** | High-bandwidth direct transfers bypassing homeserver | `github-matrix-dev/app/src/matrix/webrtc-peer.ts` | **Written, not integrated** |
| **Filen Backup** | Durable cloud backup with 30s sync cycle, 5K-event snapshots | `github-matrix-dev/app/src/filen/` | **Written, not integrated** |
| **Filen Sharing** | Dead-drop cross-account data exchange with double encryption | `github-matrix-dev/app/src/filen/filen-share.ts` | **Written, not integrated** |
| **3rd-Party DR** | S3/IPFS/Backblaze archival backup | — | **Not started** |

### Data Persistence Tiers

| Tier | Storage | Intended Role | Currently Active? |
|------|---------|---------------|-------------------|
| 1 | **Local IndexedDB** (AES-GCM encrypted) | Primary working store, instant writes, offline capable | Yes |
| 2 | **Matrix media** (binary snapshots via Megolm E2EE) | Hydration accelerator, real-time sync | Yes |
| 3 | **Filen Cloud** (.eodb files, AES-256-GCM) | Backup + disaster recovery | Code written, not integrated |
| 4 | **3rd-party** (S3, IPFS — future) | Archival, cold storage | Not started |

### Key Architectural Invariants

1. **Local-first** — All writes fold locally before any network sync. UI never waits for Matrix/Filen/P2P.
2. **Content-addressable dedup** — `client_event_id = hash(op + target + operand + agent + ts)`. Same event from multiple paths produces same hash. Fold applies it only once.
3. **Agent from sender** — Agent field is NEVER included in event content. Always derived from `matrixEvent.getSender()` to prevent spoofing.
4. **Room ordering is canonical** — Matrix room timeline establishes event order. No vector clocks, no CRDTs. Deterministic fold + canonical ordering = eventual consistency.
5. **Snapshots are not source of truth** — If snapshot and room timeline disagree, timeline wins. Snapshots are hydration accelerators only.
6. **Membership = access** — Megolm keys shared only with room members. Users not invited to the restricted room never receive its encryption keys.
