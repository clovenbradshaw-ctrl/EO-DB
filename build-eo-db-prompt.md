# Build EO///DB (Server Edition — Historical Reference)

> **ARCHITECTURAL NOTE (March 2026):** This document describes the original server-based build (Fastify + LevelDB). That implementation is complete and serves as reference code. EO///DB is transitioning to a **serverless, browser-native architecture** where the fold runs in every browser, data persists in IndexedDB (encrypted at rest), and devices sync through an E2EE Matrix room. See `DEVELOPMENT-STAGES.md` for the current build plan and `github-matrix-dev/eo-db-decentralized-spec.md` for the browser-native architecture spec.
>
> **What remains authoritative from this document:** fold logic (§2), operator helix (§2), Horizon layers (§3, §3b), type definitions, test fixtures. **What is superseded:** deployment (§9), server entry point (§9), HTTP API (§6), WebSocket sync (§7), auth middleware (§5), nginx/systemd configuration.

You are building EO///DB — an embedded database server that stores, projects, and serves data using a nine-operator transformation calculus. It is not a wrapper around a relational database. It is its own storage engine over LevelDB with a nine-case fold, a native graph index, operator-aware subscriptions, and Matrix authentication.

Read the attached technical specification (`eo-db-technical-spec.md`) in full before writing any code. It contains the complete type definitions, LevelDB keyspace design, fold logic for all nine operators, API endpoints, WebSocket sync protocol, authentication middleware, deployment instructions, and test cases. Follow it precisely.

Read the attached design report (`eo-native-database-report.md`) for architectural context. You don't need to implement everything in the report — the technical spec is what you're building. The report explains why.

---

## What you are building

A Node.js server (TypeScript, Fastify) that:

1. Stores an append-only log of EO events in LevelDB
2. Runs a nine-case fold that projects events into current state, maintains a CON graph adjacency index, and recomputes EVA-active formulas
3. Authenticates every request by verifying a Matrix access token against `https://app.aminoimmigration.com/_matrix/client/v3/account/whoami` (with 5-minute cache), or via a shared webhook secret for n8n
4. Accepts EO events via POST /webhook (from n8n) and POST /ops/* endpoints (from clients)
5. Serves projected state via GET /horizon/* endpoints
6. Syncs events to connected clients via WebSocket at /sync
7. Serves a static HTML admin interface at GET /admin

---

## Build order

Build and test in this exact order. Do not skip ahead. Each phase must pass its tests before proceeding.

### Phase 1: Storage layer
- Set up the project structure from the spec (§1)
- Install dependencies (§2)
- Create all types (§3)
- Implement LevelDB keyspaces: log, state, graph, eva, meta, idem (§5)
- Implement log operations: appendToLog, readLogSince, readLogForTarget (§5.3)
- Implement state operations: getState, getStateByPrefix, setState, removeState (§5.4)
- Implement graph operations: addEdge, removeEdge, getEdgesFrom, getEdgesTo, traverse (§5.5)
- Implement sequence counter: nextSeq (§5.2)
- Write tests: log.test.ts, graph.test.ts

### Phase 2: The fold
- **Operator handlers are NOT independent.** Build them bottom-up in helix order. Each handler may call handlers below it. The helix is: NUL < SIG < INS < SEG < CON < SYN < DEF < EVA < REC.
- Implement shared helix utilities first (`src/db/helpers.ts`): `resolveAlias()` (SYN capacity), `checkExists()` (INS capacity), `checkBoundary()` (SEG capacity), `gatherDependencies()` (CON capacity)
- Implement the nine-case fold (§6): processEvent, executeOperator, and all operator handlers in helix order
- INS: check existence (NUL capacity), create state, reject duplicates (§6.2)
- SEG: check target exists (INS capacity), write boundary state (§6.5)
- CON: check both endpoints exist (INS capacity), respect partitions (SEG capacity), add/remove edges, update state with current link set (§6.4)
- SYN: use CON graph to find edges, dissolve SEG boundaries, mint merged identity (INS capacity), merge targets, create aliases, merge edges (§6.6)
- DEF: resolve aliases (SYN capacity), respect boundaries (SEG capacity), auto-instantiate if target doesn't exist (INS capacity), merge operands, detect formula operands, register EVA-active targets, trigger recomputation via CON graph (§6.3)
- EVA: full 8-step inherited pipeline — reads formula (DEF), walks graph (CON), resolves aliases (SYN), respects boundaries (SEG), checks existence (INS), observes state (NUL), computes, writes result (DEF). Write evaluation policy (§6.7)
- REC: dispatches sub-operations through the same handler hierarchy atomically. Can invoke any combination of all other operators. Provides frame separation. (§6.8)
- Implement idempotency via client_event_id (§6 top)
- Implement dependent recomputation: after any state change, walk CON graph in reverse to find EVA-active targets, recompute fold-computed formulas (§6.9)
- Implement EVA classification: when DEF stores a formula operand, inspect it for external references (time functions). If all inputs internal → fold-computed. If any input external → horizon-computed (§6.3)
- Write tests: fold.test.ts covering all operators, helix inheritance, idempotency, dependent recomputation

### Phase 3: Horizon
- Implement horizonGet: alias resolution, Horizon-computed evaluation at read time (§7)
- Horizon-computed targets inject current time as `_now` and `_today` inputs
- The formula executor is a placeholder — return the formula definition and gathered inputs. Do not build a full formula parser yet.
- Write tests for alias resolution and Horizon-computed evaluation

### Phase 3b: File-Cabinet Horizon (Six Layers + Ancestry)
- **Layer 1 — Figure:** Already implemented in Phase 3. Projected state with alias resolution and Horizon-computed EVA.
- **Layer 2 — Grounds:** Implement `getGrounds` — prefix-walk collecting ancestor-level state. Respect override rule (child value wins over ancestor).
- **Layer 3 — Nearby:** Implement `getNearby` — one prefix scan of sibling records + in-memory field-value comparison against the current target. Also check CON linkage (records linked to the same targets are nearby). Cap at 10 results.
- **Layer 4 — Governance:** Implement `getGovernance` — scan `eva:` keyspace for registrations on this target (direct), same collection (collection scope), or ancestor prefixes (ancestor scope). These are already indexed.
- **Layer 5 — Trajectory:** Implement `getTrajectory` — filter log for this target, extract operator sequence, collapse consecutive same-ops. `INS → DEF → DEF → CON` becomes `INS, DEF, CON`.
- **Layer 6 — Signals:** Implement `detectSignals` — population analytics over numeric fields. Only runs when `opts.signals === true`. Expensive, on-demand.
- **Ancestry:** Implement `getAncestry` — climb the dot-path from this target to root. Each ancestor is a mini-Horizon: its own figure, its own grounds from above, children count, sibling count. `fldStatus → rec101 → tblCases → app`.
- Modify `horizonGet` to return `HorizonResponse` with all layers. Layers 1-5 + ancestry default ON. Signals default OFF.
- Write tests:
  - DEF at collection level is returned as ground for record-level reads
  - DEF at app level is returned as ground for deeper reads
  - Figure value overrides ancestor ground with same key
  - Nearby finds records sharing field values in same collection
  - Nearby finds records sharing CON linkage
  - Governance returns EVA policies on this target and collection
  - Trajectory returns compact collapsed operator sequence
  - Ancestry climbs from field to record to collection to app
  - Each ancestor carries its own grounds
  - Ancestry reports children_count and nearby_count
  - Signals only computed when requested
  - Each layer can be individually disabled via opts

### Phase 4: Changefeed
- Implement the Feed class with subscribe, unsubscribe, notify (§8)
- Implement glob matching for target patterns (§8)
- Write tests for subscription routing and glob matching

### Phase 5: Authentication
- Implement Matrix token verification against `https://app.aminoimmigration.com/_matrix/client/v3/account/whoami` (§4)
- Implement 5-minute token cache
- Implement Fastify auth middleware: extract token from `Authorization: Bearer <token>` header
- Implement webhook secret auth: `Authorization: EoWebhook <secret>` verified against `EO_WEBHOOK_SECRET` env var, sets agent to `@n8n:app.aminoimmigration.com`
- Write tests: auth.test.ts (mock the Matrix homeserver endpoint for tests)

### Phase 6: HTTP API
- Implement POST /webhook — accept single event or array, validate, run fold, return seq (§9.1)
- Implement POST /ops/ins, /ops/def, /ops/con, /ops/seg, /ops/syn, /ops/eva, /ops/rec (§9.2)
- Implement GET /horizon/:target, GET /horizon/:target?prefix=true (§9.3)
- Implement GET /traverse/:target?depth=N (§9.3)
- Implement GET /log?since=N&limit=N, GET /log/:target (§9.3)
- Implement GET /edges/:target?direction=outgoing|incoming|both (§9.3)
- Implement GET /health (no auth), GET /meta (auth required) (§9.4)
- All endpoints except /health require auth middleware
- Agent on events is set from the verified Matrix user ID
- Enable CORS for amino-eo origins

### Phase 7: WebSocket sync
- Implement WebSocket handler at /sync (§10)
- Auth via ?access_token= query param, verified same as HTTP
- On connect: send `{ type: "connected", user_id, current_seq }`
- On `{ type: "sync", since: N }`: stream all events from seq N, then send `{ type: "sync_complete", through_seq }`
- After sync: push new events in real-time via Feed subscription
- On `{ type: "subscribe", pattern, ops }`: filter subsequent pushes to matching events only
- On disconnect: clean up Feed subscription
- Write tests: sync.test.ts

### Phase 8: Admin explorer interface
- **Two admin interfaces exist:**
  - `eo-db-admin-dev.html` — the dark-themed DBA tool (state tables, raw log, graph viz, replay slider). Keep as-is for developer use.
  - `src/admin/index.html` — the Horizon-aware explorer. This is the primary admin interface.
- Serve the explorer at GET /admin (no auth — the interface handles its own Matrix login).
- **The explorer presents Horizon layers as one record with depth of field, not six sections:**
  - Figure fields in a grid at full contrast.
  - Trajectory as a one-line heartbeat strip under the target path: `INS → DEF → CON → DEF → EVA → SEG` with timestamps.
  - Grounds as a single context line: `regulatoryHold: active · Nashville · biweekly`.
  - Nearby as a sentence: `Similar: Carlos Mendez (H1B, Nashville, @sara)`.
  - Governance as inline badges on governed fields: `⊨ latest` on email, `ƒ filed+180` on deadline.
  - Signals as a quiet footnote: `daysOpen 45 — above average (28, n=4)`. Expands on click.
  - Ancestry navigable via breadcrumb: `app > tblClients > rec001 > fldEmail`. Click any level to see that ancestor's Horizon.
- **The sidebar is an ontology tree**, not a flat list:
  - Collections collapse/expand. Record count shown.
  - Ground properties visible directly in the tree under each collection.
  - Click a record to open its Horizon in the center panel.
  - Application-level grounds shown at the tree root.
- **Click any log event** to open its target's Horizon. The log is the timeline, the Horizon is the depth.
- **CON edges show inline** as clickable field values, not in a separate graph section.
- On load: prompt for Matrix access token (or read from localStorage).
- Fetch /horizon with ancestry + all layers to populate the explorer.
- Open WebSocket to /sync for real-time updates.
- The DBA view (`eo-db-admin-dev.html`) remains available at GET /admin/dev for raw database inspection.

### Phase 9: Server entry point
- Wire everything together in src/server.ts
- Read config from environment variables (§11)
- Create LevelDB instance at EO_DATA_DIR
- Create Feed instance
- Register auth middleware
- Register all API routes
- Start Fastify on EO_PORT
- Graceful shutdown: close LevelDB, close WebSocket connections

---

## Critical implementation details

**The fold is the core.** Every event goes through processEvent in fold.ts. The fold assigns the sequence number, appends to the log, executes the operator-specific logic, recomputes dependents, and notifies the feed. Nothing bypasses the fold.

**The operator helix is the fold's call hierarchy.** Operator handlers are cumulative — each inherits all capacities below it. DEF doesn't just write a value: it resolves aliases (SYN), respects boundaries (SEG), can auto-instantiate (INS), and triggers recomputation across the dependency graph (CON). EVA exercises eight inherited capacities in a single fold step. The fold processes operators sequentially because events must arrive in helix-consistent order. Low operators (INS) are cheap (microseconds, 1-2 keys). Middle operators (SEG, CON, SYN) are moderately expensive (milliseconds, index updates). High operators (DEF, EVA, REC) are the most expensive but do the most work per event (tens of ms, recomputation cascades). This cost gradient matches real workload patterns — cheap operators fire most, expensive operators fire least.

**Formula recomputations do not write to the log.** They write results to projected state only. The log records what came from outside (agents, sources). Projected state records consequences (formula results). One upstream DEF that affects 50 formulas produces one log entry and 50 state updates.

**The formula executor is a placeholder.** For Phase 1, `executeFormulaFunction` returns `{ formula, inputs, evaluated_at }`. A real formula parser is Phase 2 work. The structure is in place — the registration, classification, dependency tracking, and recomputation pipeline all work. The actual computation is stubbed.

**NUL and SIG are not stored.** They are pre-INS operators. NUL is the GET itself — observation produces no log entry. SIG is ephemeral session state held in memory. Neither passes through the fold. Neither writes to the log. Do not create handlers for them in the fold.

**Idempotency is mandatory.** n8n may retry. The same client_event_id must return the same sequence number without re-processing. Store client_event_id → seq in the idem: keyspace.

**Sequence numbers are zero-padded 12-digit strings in LevelDB keys.** This ensures lexicographic order matches numeric order for the log: keyspace iteration.

**REC sub-operations do not get their own sequence numbers.** The REC event is one log entry. Its contained operations apply to projected state as part of the REC's fold execution but are not individually logged.

**Graph edges are stored in both directions.** Forward (graph:fwd:source:dest) for "what does this target link to?" and reverse (graph:rev:dest:source) for "what links to this target?" The reverse index is how dependent recomputation finds EVA-active targets upstream.

---

## Environment

```
Node.js 20+
TypeScript 5+
Linux (Ubuntu 24 target deployment)
LevelDB via classic-level
Fastify for HTTP
vitest for tests
```

---

## Test fixtures

Use these events for testing. They simulate an immigration law firm's data:

```typescript
const FIXTURES = [
  { op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' }, client_event_id: 'fix-001', agent: '@intake:app.aminoimmigration.com' },
  { op: 'INS', target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' }, client_event_id: 'fix-002', agent: '@intake:app.aminoimmigration.com' },
  { op: 'CON', target: 'app.tblClients.rec001.fldCases', operand: { added: ['app.tblCases.rec101'] }, client_event_id: 'fix-003', agent: '@intake:app.aminoimmigration.com' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending', client_event_id: 'fix-004', agent: '@caseworker:app.aminoimmigration.com' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'approved', client_event_id: 'fix-005', agent: '@caseworker:app.aminoimmigration.com' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com', client_event_id: 'fix-006', agent: '@intake:app.aminoimmigration.com' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com', client_event_id: 'fix-007', agent: '@caseworker:app.aminoimmigration.com' },
  { op: 'EVA', target: 'app.tblClients.rec001.fldEmail', operand: { strategy: 'latest' }, client_event_id: 'fix-008', agent: '@admin:app.aminoimmigration.com' },
  { op: 'SEG', target: 'app.tblClients.rec001', operand: { boundary: 'exclude', reason: 'archived' }, client_event_id: 'fix-009', agent: '@admin:app.aminoimmigration.com' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldDeadline', operand: { formula: 'DAYS_UNTIL(filed + 180)' }, client_event_id: 'fix-010', agent: '@admin:app.aminoimmigration.com' },
  { op: 'REC', target: 'schema.tblCases', operand: { contains: [{ op: 'DEF', target: 'schema.tblCases.fldUrgency', operand: { type: 'select' } }], reason: 'Added urgency field' }, client_event_id: 'fix-011', agent: '@admin:app.aminoimmigration.com' },
];
```

---

## What NOT to build

- Do not build a full formula parser/evaluator. Stub it. Return the formula definition and inputs.
- Do not build the admin interface from scratch. Use the attached HTML file and wire it to the live API.
- Do not build a type registry for multi-modal operands (vectors, spatial, tensors). That's Phase 4.
- Do not build field-level encryption. That's Phase 3.
- Do not build backup/snapshot tooling. That's operational work after the core is stable.
- Do not add any ORM or database abstraction layer. LevelDB operations are direct. The fold IS the abstraction.

---

## Deployment

After the build passes all tests, deploy to the VM:

1. Build: `npm run build`
2. Copy dist/ and package.json to `/opt/eo-db/` on the VM
3. `npm install --production` on the VM
4. Create `.env` with:
   - `EO_PORT=3000`
   - `EO_DATA_DIR=/var/lib/eo-db/data`
   - `EO_MATRIX_HOMESERVER=https://app.aminoimmigration.com`
   - `EO_WEBHOOK_SECRET=<generate a 64-char hex string>`
5. Create systemd service (spec §12)
6. Set up nginx reverse proxy with WebSocket upgrade support (spec §12.1)
7. Verify: `curl https://eo-db.aminoimmigration.com/health`
8. Test webhook: `curl -X POST https://eo-db.aminoimmigration.com/webhook -H "Authorization: EoWebhook <secret>" -H "Content-Type: application/json" -d '{"op":"INS","target":"test.hello","operand":{"greeting":"world"},"client_event_id":"test-001"}'`
9. Verify state: `curl https://eo-db.aminoimmigration.com/horizon/test.hello -H "Authorization: Bearer <matrix_token>"`

---

## Attached files

- `eo-db-technical-spec.md` — the complete technical specification. This is your primary reference.
- `eo-native-database-report.md` — the design report. Read for context, not as a build spec.
- `eo-db-admin.html` — the admin interface mockup. Wire it to the live API in Phase 8.
