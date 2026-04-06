# EO///DB — Development Stages: Serverless Browser-Native Architecture

> Transition from server-based (Fastify + LevelDB) to fully serverless, browser-native application.
> No backend. The fold runs in every browser. Every device with the events and keys has the complete database.

## Data Persistence Tiers

| Tier | Storage | Role |
|------|---------|------|
| 1 | **Local IndexedDB** (per device, AES-GCM encrypted) | Primary working store |
| 2 | **Matrix media repository** (binary snapshots) | Hydration accelerator for new devices |
| 3 | **3rd-party backups** (S3, IPFS — future) | Disaster recovery, archival |

Devices network through an E2EE Matrix room for real-time event sync. There is no central server.

---

## Stage 1: Local Storage + Browser Fold

**Goal:** The app works entirely offline with locally persisted, encrypted data. No server dependency for read/write of events.

### Deliverables

- **IndexedDB schema** — Six object stores matching the decentralized spec §4:
  - `log` — append-only event log (keyed by `client_event_id`, indexed by seq, target, synced)
  - `state` — projected state (keyed by target path)
  - `graph_fwd` / `graph_rev` — CON adjacency index (forward and reverse)
  - `eva` — EVA-active registrations
  - `meta` — cursors, settings, counters
- **AES-GCM encryption layer** — Transparent encrypt/decrypt on all IndexedDB writes/reads via Web Crypto API. Key derived from session credentials via PBKDF2. Key held in memory only, never persisted. On logout, key is discarded and data becomes unreadable.
- **Full nine-case fold in browser** — Port from `src/db/fold.ts`. All operator handlers in helix order (NUL < SIG < INS < SEG < CON < SYN < DEF < EVA < REC). Includes:
  - Idempotency via `client_event_id`
  - Dependent recomputation cascade via CON graph walk
  - EVA classification (fold-computed vs horizon-computed)
  - SEG boundary enforcement
  - SYN alias resolution and merge
  - REC fixed-point recursion (iterate until convergence or oscillation detection)
- **Local event submission** — `submitEvent()` writes to IndexedDB and runs fold locally, assigning monotonically increasing sequence numbers. No `POST /webhook`.
- **Delete clears IndexedDB** — `executeDeleteAll()` clears all six object stores and resets in-memory state. No `DELETE /admin/reset`.
- **Remove connection bar** — Strip the server URL input, connection status, and all `fetch` calls to `localhost:3000`.

### Port From
- `src/db/fold.ts` — nine-case fold engine
- `src/db/types.ts` — EoEvent, EoState, GraphEdge, EvaRegistration, HorizonResponse
- `src/db/helpers.ts` — resolveAlias, checkExists, checkBoundary, gatherDependencies
- `src/db/state.ts`, `src/db/graph.ts`, `src/db/log.ts` — adapt LevelDB operations to IndexedDB

### Verification
- [ ] Open the HTML file directly in browser (no server). Compose an INS event. Close and reopen. Event persists.
- [ ] Compose events of every operator type. Horizon, Log, and Graph tabs render correctly.
- [ ] Type "delete" in search, confirm deletion. IndexedDB clears. Refresh shows empty state.
- [ ] DevTools > Application > IndexedDB shows encrypted blobs (not readable JSON).
- [ ] Replay slider works against IndexedDB-backed data.
- [ ] Zero network requests in DevTools.

---

## Stage 2: Direct Matrix Authentication

**Goal:** The browser authenticates directly against the Matrix homeserver. No server proxy for login, profile, or token verification.

### Deliverables

- **Direct login** — `doLogin()` calls `POST https://{homeserver}/_matrix/client/v3/login` with `m.login.password` flow. Returns `access_token`, `user_id`, `device_id`.
- **Direct profile** — Fetch display name and avatar from `GET https://{homeserver}/_matrix/client/v3/profile/{userId}`.
- **Session storage** — Store `access_token`, `user_id`, `device_id`, `homeserver` in localStorage.
- **Encryption key derivation** — Use `access_token + device_id` as input to PBKDF2 to derive the AES-GCM key for IndexedDB encryption (connecting Stage 1).
- **Homeserver field** — Login modal includes homeserver URL input with default `https://app.aminoimmigration.com`.
- **Logout** — Discard encryption key from memory, clear auth from localStorage. IndexedDB data becomes unreadable.

### Verification
- [ ] Open HTML file. Sign in with Matrix credentials. Display name appears in top bar.
- [ ] After login, IndexedDB operations work (encryption key derived).
- [ ] After logout, IndexedDB data is unreadable.
- [ ] Wrong credentials show error in login modal.
- [ ] Zero requests to `localhost:3000` in DevTools Network tab.

---

## Stage 3: Matrix Room Sync

**Goal:** Devices network through an encrypted Matrix room for bidirectional real-time event sync. Local-first: the fold runs immediately, sync happens asynchronously.

### Deliverables

- **Matrix SDK integration** — Include `matrix-js-sdk` + `matrix-sdk-crypto-wasm` for E2EE. This stage introduces a Vite build step (the Matrix SDK is ~2MB with crypto WASM and cannot be reasonably inlined in a single HTML file).
- **Event bridge** — Custom Matrix event type `com.aminoimmigration.eo.event`. `sendEoEvent()` sends local events to the room. `matrixEventToEo()` converts incoming room events back to EO events. Agent derived from Matrix sender, not event content.
- **Sync manager** — On startup, paginate room history from last known position (`last_synced_seq` in `meta` store). Incoming events are deduplicated by `client_event_id`, then folded.
- **Offline queue** — Events composed while offline stored in IndexedDB with `synced: false`. On reconnect, flush to room in order.
- **Canonical sequencing** — Room event ordering establishes canonical sequence. Local events get provisional seq, updated to canonical seq when confirmed in room timeline.
- **Status indicator** — Top bar shows sync state: `online` / `offline` / `syncing`, replacing the server connection dot.
- **Local-first flow** — User creates event → fold runs immediately → UI updates → event sent to room async. User never waits for sync.

### Verification
- [ ] Two browsers logged in. Event in browser A appears in browser B within seconds.
- [ ] Disconnect browser B. Compose event. Reconnect. Event syncs to room and appears in browser A.
- [ ] Status shows "syncing" during room history load, "online" when caught up, "offline" when disconnected.
- [ ] Fresh browser session loads full event history from room.
- [ ] Duplicate events (same `client_event_id` arriving via multiple paths) are folded only once.

---

## Stage 4: Snapshot Hydration + Media Backups

**Goal:** Binary state snapshots stored in Matrix media enable fast bootstrap for new devices instead of replaying the entire room history. Snapshots are backup tier 2.

### Deliverables

- **Create snapshot** — Serialize `state`, `graph_fwd`, `graph_rev`, `eva` stores into msgpack binary. Header includes `version`, `seq`, `ts`, `created_by`, content hash.
- **Upload to Matrix media** — Encrypted binary uploaded via Matrix SDK's encrypted media upload (`POST /_matrix/media/v3/upload`).
- **Room reference event** — Post `com.aminoimmigration.eo.snapshot` to room with `mxc://` URI, seq, and content hash.
- **Hydrate from snapshot** — Scan room for latest `eo.snapshot` event. Download binary. Decrypt. Deserialize. Load into IndexedDB. Set sync cursor to snapshot's seq, sync only the tail.
- **Session boundary triggers** — Auto-snapshot on logout (if unsnapshotted events exist). Auto-snapshot every N events (configurable, default 1000).
- **Manual trigger** — "Create Snapshot" button in Settings panel.
- **Snapshot is not source of truth** — The room event history is authoritative. Snapshots are hydration accelerators. If snapshot and log disagree, log wins.

### Verification
- [ ] After 50+ events, create snapshot. `eo.snapshot` event appears in room.
- [ ] Fresh browser session: downloads snapshot, applies it, syncs tail. Final state matches other devices.
- [ ] Snapshot binary in media store is encrypted (not readable without room keys).
- [ ] On logout with unsnapshotted events, snapshot is auto-created.
- [ ] New device hydration is significantly faster than full room replay.

---

## Stage 5: Admin-Configurable Settings

**Goal:** Per-device configuration for snapshot intervals, sync behavior, and storage management. All settings stored locally.

### Deliverables

- **Redesigned Settings panel** — Remove server-dependent auth gating controls. Replace with browser-local configuration sections:
  - **Snapshot** — Auto-snapshot interval (event count, default 1000), auto-snapshot on logout toggle, manual snapshot button
  - **Sync** — Sync poll interval, offline queue retry interval
  - **Encryption** — Show encryption status, device ID, option to re-derive key
  - **Storage** — IndexedDB usage (event count, approximate size), export/import local database
  - **Backup targets** (future) — Placeholder for 3rd-party backup configuration (S3, IPFS)
- **Persistent settings** — Stored in IndexedDB `meta` store with keys like `settings:snapshot_interval`, `settings:sync_poll_ms`.
- **Per-device** — Settings are local. Not synced via Matrix. Each device can have its own preferences.
- **Session info** — Display current Matrix user ID, display name, homeserver, device ID, and Sign Out button.

### Verification
- [ ] Change snapshot interval to 100. After 100 events, snapshot auto-creates.
- [ ] Toggle auto-snapshot on logout off. Logout. No snapshot created.
- [ ] Sync poll interval change takes effect immediately.
- [ ] All settings persist across page reloads.
- [ ] Storage display shows accurate event count.

---

## Stage 6: Polish + Offline Hardening

**Goal:** Production-quality offline experience. Zero server dependency confirmed. Graceful error handling throughout.

### Deliverables

- **Dead code removal** — Remove `connectToServer()`, `fetchLiveLog()`, `serverUrl`, `isConnected`, all `fetch(\`\${serverUrl}/*\`)` call sites, connection bar CSS, `authHeaders()`.
- **Loading states** — Spinner during initial Matrix sync and snapshot hydration. Progress indicator for snapshot download (percentage from content-length).
- **Status bar redesign** — Top bar shows: sync status, local event count, last sync time, peer count (devices in Matrix room).
- **Error handling**:
  - Matrix auth failures → error in login modal
  - Sync failures → non-blocking toast
  - Fold errors → inline in Compose result area
  - IndexedDB quota exceeded → warning with option to clear old data or create snapshot
- **Delete confirmation** — Clears all six IndexedDB stores, resets in-memory state. Optionally posts a notification to Matrix room.
- **Full offline mode** — All tabs work against local data when network unavailable. Compose tab works (events queued). Only sync indicator changes.
- **Final audit** — Grep entire codebase for `localhost`, `serverUrl`, `/health`, `/webhook`, `/admin/reset`, `/auth/login`, `/auth/profile`. Zero hits.

### Verification
- [ ] DevTools Network: zero requests to `localhost:3000` or any non-Matrix URL.
- [ ] Disconnect network entirely. All tabs render. Compose event. Reconnect. It syncs.
- [ ] Delete all data. IndexedDB empty. Refresh shows empty state with login prompt.
- [ ] No JavaScript errors in console during normal operation.
- [ ] App serves from static file server with full functionality.

---

## Stage Dependency Graph

```
Stage 1  Local Storage + Browser Fold
  |
  v
Stage 2  Direct Matrix Auth
  |
  v
Stage 3  Matrix Room Sync          (requires Stages 1 + 2)
  |
  v
Stage 4  Snapshots
  |
  v
Stage 5  Admin Settings             (configures features from 3 + 4)
  |
  v
Stage 6  Polish + Offline Hardening (requires all previous stages)
```

## Architecture Decision: Build Tooling

Stages 1-2 can remain as modifications to the existing single HTML file (they use only browser-native APIs: IndexedDB, Web Crypto, fetch).

**Stage 3 introduces Vite** — the Matrix SDK (~2MB with crypto WASM) cannot be reasonably inlined. A minimal `vite.config.ts` bundles the app into static assets for deployment. The existing UI code stays vanilla JS (no React rewrite required) while gaining proper dependency management.

## Performance & Lag Estimates by Scale

### IndexedDB Operations (Local Fold)

| Scale | Event Count | IndexedDB Size | Fold Latency (single event) | Full Replay | Notes |
|-------|------------|----------------|----------------------------|-------------|-------|
| Small | < 1,000 | < 5 MB | < 1 ms | < 500 ms | No perceptible lag |
| Medium | 1,000–10,000 | 5–50 MB | 1–3 ms | 2–10 sec | AES-GCM adds ~0.1 ms/op. Replay at startup may cause brief spinner |
| Large | 10,000–100,000 | 50–500 MB | 3–10 ms | 30–120 sec | Snapshot hydration critical — avoid full replay. Graph traversals (CON, nearby) slow without snapshot |
| Very Large | 100,000+ | 500 MB–2 GB | 10–50 ms | Minutes | Browser memory pressure. IndexedDB quota warnings likely. Must hydrate from snapshot |

### Operator-Specific Costs

| Operator | Cost | Why | Lag Threshold |
|----------|------|-----|---------------|
| INS | Cheap (< 1 ms) | Single state write | > 50,000 records before noticeable |
| DEF | Cheap–Medium (1–5 ms) | State merge + possible EVA recomputation cascade | Cascade depth > 20 targets: 50+ ms |
| CON | Medium (2–10 ms) | Forward + reverse graph index writes, may trigger recomputation | > 10,000 edges: graph walks slow |
| SEG | Cheap (< 1 ms) | Single boundary write | Rarely a bottleneck |
| SYN | Expensive (10–50 ms) | Alias creation + edge merge + state merge across targets | > 100 edges on merge source: 100+ ms |
| EVA | Medium–Expensive (5–30 ms) | 8-step inherited pipeline, graph walk for dependencies | Deep dependency chains (> 10): 50+ ms |
| REC | Variable (10–500+ ms) | Fixed-point iteration of contained ops, cost = iterations × sum of contained ops | Deep feedback chains or many sub-ops: perceptible delay |

### AES-GCM Encryption Overhead

| Operation | Overhead | Notes |
|-----------|----------|-------|
| Encrypt (write) | ~0.05–0.1 ms per value | Web Crypto API, hardware-accelerated on modern CPUs |
| Decrypt (read) | ~0.05–0.1 ms per value | Negligible for single reads |
| Bulk decrypt (page load) | ~50–100 ms per 1,000 records | Noticeable during initial load at > 5,000 records |
| Key derivation (PBKDF2) | ~100–300 ms (one-time) | On login only. 100,000 iterations. One-time cost |

### Matrix Room Sync

| Scenario | Latency | Notes |
|----------|---------|-------|
| Local event → room | 100–500 ms | Matrix SDK encrypt + HTTP send. User doesn't wait (local-first) |
| Room event → other device | 200–1,000 ms | Matrix sync polling interval + decrypt + fold. Typically < 1 sec |
| Initial room history load | 2–30 sec | Depends on unsnapshotted event count. 1,000 events/sec typical pagination rate |
| Snapshot hydration | 1–5 sec | Download (network-bound) + decrypt + deserialize + IndexedDB bulk write |
| Offline queue flush | 500 ms–5 sec | Batch send on reconnect. Rate-limited to avoid homeserver throttling |
| Gap fill (peer-to-peer) | 1–10 sec | To-device messaging. 50-event batches. Multiple round trips for large gaps |

### Snapshot Size Estimates

| Event Count | Snapshot Size (msgpack) | Upload Time | Download Time | Notes |
|-------------|------------------------|-------------|---------------|-------|
| 1,000 | 100–500 KB | < 1 sec | < 1 sec | |
| 10,000 | 1–5 MB | 1–3 sec | 1–3 sec | |
| 100,000 | 10–50 MB | 5–15 sec | 5–15 sec | Matrix media upload limit may apply |
| 1,000,000 | 100–500 MB | Minutes | Minutes | Chunked upload needed. Consider incremental snapshots |

### Where Lag Becomes Perceptible

| Component | Comfort Zone | Caution Zone | Danger Zone |
|-----------|-------------|--------------|-------------|
| Local fold | < 10K events | 10K–50K events | > 50K events (use snapshots) |
| Horizon read (6 layers) | < 5K state entries | 5K–20K entries | > 20K (Nearby + Signals expensive) |
| Graph traversal | < 5K edges | 5K–20K edges | > 20K (CON walks O(edges)) |
| IndexedDB total size | < 100 MB | 100–500 MB | > 500 MB (quota warnings) |
| Matrix room history | < 5K events | 5K–20K events | > 20K (must snapshot) |
| Encryption bulk load | < 2K records | 2K–10K records | > 10K (200+ ms delay) |

### Mitigation Strategies

- **Snapshots** are the primary defense against scale lag. Auto-snapshot every 1,000 events (configurable in Stage 5). New devices hydrate from snapshot, never replay full history.
- **Nearby layer** is the most expensive Horizon component at scale (prefix scan + field comparison). Cap at 10 results. Consider lazy loading at > 5K records in a collection.
- **Signals layer** is on-demand only (`opts.signals === true`). Never computed by default. Population analytics over numeric fields is O(collection size).
- **EVA recomputation cascade** is the fold's primary scaling concern. A single DEF that affects 50 formulas produces 50 state writes. Monitor cascade depth.
- **IndexedDB quotas** vary by browser (Chrome: ~80% of disk, Firefox: ~2GB default, Safari: ~1GB). Show warnings at 80% capacity.

## Reference Specs

- `github-matrix-dev/eo-db-decentralized-spec.md` — Primary architecture spec for IndexedDB schema, encryption, Matrix integration, snapshots
- `github-matrix-dev/build-eo-db-decentralized-prompt.md` — Build order and phase details
- `eo-db-technical-spec.md` — Fold logic, operator handlers, types (unchanged semantics)
- `build-eo-db-prompt.md` — Original server build phases (completed)
