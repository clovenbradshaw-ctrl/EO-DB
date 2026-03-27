# Build EO///DB — Decentralized Version

You are building EO///DB as a static web application that runs entirely in the browser, syncs through Matrix, and serves from GitHub Pages. There is no backend server. The fold runs in every browser. The data syncs through an encrypted Matrix room. Nothing is stored in plaintext on any server.

Read the attached files in this order:
1. `eo-native-database-report.md` — design context. Why this exists. Read for understanding.
2. `eo-db-technical-spec.md` — the original server spec. The fold logic, operator handlers, types, graph operations, and Horizon are the same. Adapt the storage layer from LevelDB to IndexedDB.
3. `patch-three-layer-horizon.md` — the three-layer Horizon (figure, ground, signal). Implement this.
4. `eo-db-decentralized-spec.md` — the decentralized architecture. THIS IS YOUR PRIMARY BUILD SPEC. It supersedes the deployment, auth, and sync sections of the server spec.
5. `eo-db-crm-horizon.html` — the CRM interface mockup. Wire it to live data.

---

## What you are building

A Vite + React + TypeScript static app that:

1. Serves from GitHub Pages — zero backend, code only
2. Authenticates via Matrix login against `https://app.aminoimmigration.com`
3. Stores EO events in IndexedDB, encrypted with a session-derived key
4. Runs the nine-case fold locally in the browser
5. Syncs events through an E2EE Matrix room (`#amino-data:app.aminoimmigration.com`)
6. Syncs directly between devices via Matrix to-device messaging for gap filling
7. Creates and hydrates from encrypted binary snapshots in the Matrix media store
8. Renders a CRM interface with the six-layer Horizon (figure, ground, nearby, governance, trajectory, signals)
9. Works fully offline — creates records, runs fold, syncs when reconnected

---

## Build order

Follow `eo-db-decentralized-spec.md` §15 exactly. Nine phases in strict order. Each phase must work before proceeding.

### Phase 1: Static app shell
- Vite + React + TypeScript project
- GitHub Actions deploy workflow (spec §12.2)
- Vite config with Matrix SDK chunking (spec §12.3)
- Security headers (spec §12.4)
- Matrix login screen (spec §13.1)
- Login flow: user enters username + password, Matrix SDK authenticates, session stored in localStorage
- Verify: user can log in from the deployed GitHub Pages URL

### Phase 2: IndexedDB + encrypted store
- IDB schema from spec §4
- Encrypted IndexedDB layer from spec §5
- Key derivation from Matrix session using PBKDF2
- On login: derive key, open encrypted store
- On logout: discard key, data unreadable
- Verify: can write and read encrypted data, clearing session makes data unreadable

### Phase 3: Fold in the browser
- Port types.ts from server spec §3
- Port fold.ts from server spec §6 — all nine operator handlers
- Adapt all storage operations (state, graph, EVA) to use IndexedDB instead of LevelDB
- Port horizon.ts from server spec §7
- Port three-layer Horizon from patch spec §3 (getGrounds, detectSignals)
- Port pattern registration from patch spec §5
- Verify: process test fixtures through fold, state is correct, grounds inherit, signals detect

### Phase 4: Matrix event bridge
- Implement event-bridge.ts (spec §6.2): EO event ↔ Matrix event conversion
- Custom event type: `com.aminoimmigration.eo.event`
- Agent derived from Matrix sender, not from event content
- Send EO events to room via Matrix SDK (auto-encrypted)
- Receive room events, convert to EO events, fold them
- Verify: create a record locally, it appears in the Matrix room encrypted, another device receives and decrypts it

### Phase 5: Sync manager
- Implement sync-manager.ts (spec §6.3)
- Room history pagination: sync timeline from last known position
- Offline queue: store unsynced events, flush on reconnect
- Deduplication by client_event_id
- Local events get UUID client_event_ids, fold immediately, sync async
- Canonical seq assigned from room event ordering
- Verify: create records offline, reconnect, events sync to room, another device receives them

### Phase 6: Peer sync
- Implement peer-sync.ts (spec §7)
- To-device messaging: hello, offer, request, events
- On startup: announce own seq to all peers in room
- Gap detection: compare seqs, request missing ranges
- Batch events in chunks of 50 for to-device size limits
- Dedup incoming peer events by client_event_id before folding
- Verify: device A has events B is missing, they exchange via to-device, state converges

### Phase 7: Snapshot hydration
- Implement snapshot.ts (spec §8)
- Create snapshot: serialize state + graph + EVA to msgpack
- Upload: encrypted binary to Matrix media store, reference event to room
- Find latest: scan room for eo.snapshot events
- Apply: download, decrypt, deserialize, load into IndexedDB
- Auto-snapshot every 1000 events
- New device flow: find snapshot → apply → sync tail → ready
- Verify: create snapshot on device A, new device B hydrates from it, syncs tail, state matches

### Phase 8: CRM interface
- Build the six-layer record view based on `eo-db-crm-horizon.html`
- Client list sidebar grouped by collection
- Record header with name, status, case info
- Figure fields: two-column grid with history dots, EVA badges, CON links
- Trajectory: horizontal operator chain
- Grounds: chips inherited from ancestor prefixes
- Nearby: similar records by shared field values and CON links
- Governance: EVA policies that apply to this target
- Signals: population analytics, ephemeral, on-demand
- Connect to Zustand store: fold updates Zustand, React re-renders
- Verify: full CRM experience with live data syncing between devices

### Phase 9: Polish
- Loading states during initial sync and snapshot hydration
- Progress indicator for snapshot download
- Connection status indicator (online/offline/syncing)
- Device verification flow (Matrix cross-signing)
- Logout: clear session, discard encryption key
- Error handling: Matrix auth failures, sync failures, fold errors

---

## Critical implementation details

**The fold is identical to the server spec.** Nine cases. Same logic. The only difference is the storage interface — IndexedDB instead of LevelDB. Do not change the fold's semantics. Port it directly.

**Events are created locally first, synced second.** When the user creates a record, the fold runs immediately on the local event. The UI updates instantly. The sync to Matrix happens async. If it fails (offline), the event is queued. The user never waits for the server.

**Deduplication is by client_event_id everywhere.** The same event may arrive via room sync AND via peer-to-peer AND via local creation. Before folding any event, check if client_event_id already exists in the log store. If yes, skip.

**Canonical ordering comes from the room.** Local events have UUID identifiers but no canonical sequence number until they appear in the room timeline. The room's event ordering establishes the canonical sequence. On sync, local events get their canonical seq assigned. The fold may need to re-process events in canonical order if the local order differs from the room order.

**The encrypted IndexedDB layer is transparent.** The fold, Horizon, and UI code never deal with encryption directly. They call `db.get()` and `db.put()`. The encrypted store layer handles encrypt/decrypt internally. If the session key is missing (logged out), all operations fail — this is correct behavior.

**Matrix SDK handles all cryptography.** The app code never does Megolm encryption/decryption directly. It calls `client.sendEvent()` (SDK encrypts) and reads events from sync (SDK decrypts). The local IndexedDB encryption (AES-GCM with session-derived key) is the only crypto the app code does directly, via the Web Crypto API.

**Snapshots are not the source of truth.** They are hydration accelerators. The room event history is the source of truth. A snapshot can be verified by replaying the log and comparing. If they disagree, the log wins.

**NUL and SIG do not enter the fold.** Same as the server spec. NUL is the read operation itself. SIG is ephemeral session state (which target the user is viewing). Neither produces log entries or Matrix room events.

---

## Test fixtures

Same as the server spec, adapted for Matrix:

```typescript
const FIXTURES = [
  { op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' }, client_event_id: 'fix-001' },
  { op: 'INS', target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' }, client_event_id: 'fix-002' },
  { op: 'CON', target: 'app.tblClients.rec001.fldCases', operand: { added: ['app.tblCases.rec101'] }, client_event_id: 'fix-003' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending', client_event_id: 'fix-004' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'approved', client_event_id: 'fix-005' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com', client_event_id: 'fix-006' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com', client_event_id: 'fix-007' },
  { op: 'EVA', target: 'app.tblClients.rec001.fldEmail', operand: { strategy: 'latest' }, client_event_id: 'fix-008' },
  { op: 'DEF', target: 'app.tblClients', operand: { regulatoryHold: true, defaultRegion: 'Nashville' }, client_event_id: 'fix-020' },
  { op: 'DEF', target: 'app', operand: { timezone: 'America/Chicago', firm: 'Amino Immigration' }, client_event_id: 'fix-021' },
];
```

Agent is derived from the Matrix sender on each event. In tests, mock the Matrix client and set sender to `@testuser:app.aminoimmigration.com`.

---

## Environment

```
Node.js 20+ (build only — no runtime server)
TypeScript 5+
Vite 5+
React 18+
matrix-js-sdk + matrix-sdk-crypto-wasm
IndexedDB (via idb library)
GitHub Pages (static hosting)
Matrix homeserver at https://app.aminoimmigration.com
```

---

## What NOT to build

- No backend server. The app is static files.
- No LevelDB. Use IndexedDB.
- No WebSocket server. Sync through Matrix.
- No webhook endpoint. n8n posts to the Matrix room directly (or via a bot account).
- No nginx. GitHub Pages handles HTTPS.
- No custom auth system. Matrix login only.
- No formula parser. The fold's formula executor is a placeholder (returns formula + inputs).
- No WebRTC peer-to-peer. Use Matrix to-device messaging. WebRTC is a future optimization.

---

## Deployment

```bash
# Local development
npm install
npm run dev          # Vite dev server at localhost:5173

# Build
npm run build        # outputs to dist/

# Deploy
git push origin main # GitHub Actions builds and deploys to Pages

# Verify
# Open https://your-github-pages-url
# Log in with Matrix credentials
# Create a test record
# Open in another browser/device
# Verify the record syncs
```

---

## Attached files

- `eo-db-decentralized-spec.md` — PRIMARY BUILD SPEC for the decentralized architecture
- `eo-db-technical-spec.md` — fold logic, operator handlers, types (adapt storage to IndexedDB)
- `eo-native-database-report.md` — design context
- `patch-three-layer-horizon.md` — three-layer Horizon implementation
- `eo-db-crm-horizon.html` — CRM interface mockup to wire to live data
- `eo-db-horizon-explorer.html` — admin/explorer interface mockup (Phase 9, optional)
