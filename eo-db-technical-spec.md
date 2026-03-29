# EO///DB — Technical Specification (Server Edition — Historical Reference)

> **ARCHITECTURAL NOTE (March 2026):** This spec describes the server-based implementation (Fastify + LevelDB on a Linux VM). That implementation is complete. EO///DB is transitioning to a **serverless, browser-native architecture**: IndexedDB replaces LevelDB, Matrix room sync replaces WebSocket server, direct browser-to-homeserver auth replaces server proxy, and there is no backend. See `DEVELOPMENT-STAGES.md` for the staged transition plan.
>
> **Authoritative sections:** Types (§3), fold logic and operator handlers (§6), Horizon (§7), graph operations (§5.5) — these port directly to IndexedDB with unchanged semantics. **Superseded sections:** Deployment (§12), nginx (§12.1), n8n webhooks (§13), HTTP API (§9), WebSocket server (§10), Fastify auth middleware (§4).

**Build target:** A Node.js server that implements an EO-native embedded database with Matrix authentication, webhook ingestion, WebSocket sync, and a visual admin interface.

**Runtime:** Node.js 20+ on a Linux VM.
**Storage:** LevelDB via `classic-level`.
**Auth:** Matrix token verification against `https://app.aminoimmigration.com`.
**Primary consumer:** amino-eo (React/Vite PWA).
**Primary producer:** n8n (Airtable webhook relay).

---

## 1. Project Structure

```
eo-db/
  package.json
  tsconfig.json
  src/
    server.ts              — entry point, Express/Fastify + WebSocket
    auth/
      matrix.ts            — Matrix token verification middleware
    db/
      log.ts               — append-only event log (LevelDB keyspace: log:)
      state.ts             — projected state (LevelDB keyspace: state:)
      graph.ts             — CON adjacency index (LevelDB keyspace: graph:)
      fold.ts              — nine-case fold engine + EVA computation
      horizon.ts           — read-time evaluation for Horizon-computed targets
      feed.ts              — operator-aware changefeed / subscription routing
      types.ts             — TypeScript types for events, state, operators
    api/
      webhook.ts           — POST /webhook — inbound EO events from n8n
      sync.ts              — WebSocket handler — event sync for amino-eo
      query.ts             — GET endpoints — get, getByPrefix, traverse, log
      ops.ts               — POST /ops/* — direct operator endpoints
  tests/
    fold.test.ts
    log.test.ts
    graph.test.ts
    auth.test.ts
    sync.test.ts
```

---

## 2. Dependencies

```json
{
  "dependencies": {
    "fastify": "^4.x",
    "@fastify/websocket": "^8.x",
    "@fastify/cors": "^9.x",
    "classic-level": "^1.x",
    "msgpackr": "^1.x",
    "uuid": "^9.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "vitest": "^1.x",
    "@types/node": "^20.x",
    "tsx": "^4.x"
  }
}
```

Use `msgpackr` for serialization to/from LevelDB (compact binary, faster than JSON). Use JSON for wire format (HTTP/WebSocket).

---

## 3. Core Types

```typescript
// src/db/types.ts

// The nine operators
type Operator = 'NUL' | 'SIG' | 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// Operators that produce log entries (post-INS threshold)
type LoggableOperator = 'INS' | 'SEG' | 'CON' | 'SYN' | 'DEF' | 'EVA' | 'REC';

// An event in the log
interface EoEvent {
  seq: number;                    // auto-incrementing sequence number
  op: LoggableOperator;           // operator type
  target: string;                 // dot-path target (e.g. "app.tblClients.rec123.fldEmail")
  operand: any;                   // typed by operator — value, edges, policy, boundary, etc.
  agent: string;                  // Matrix user ID (e.g. "@caseworker:app.aminoimmigration.com")
  ts: string;                     // submission timestamp — when the agent/user submitted this event (ISO 8601)
  acquired_ts: string;            // acquisition timestamp — when the system received this event (ISO 8601)
  client_event_id?: string;       // idempotency key from producer
  meta?: Record<string, any>;     // optional metadata (source system, provenance)
}

// Projected state at a target
interface EoState {
  target: string;
  value: any;                     // current projected value
  last_seq: number;               // sequence of last event that touched this target
  last_op: Operator;              // operator type of last event
  last_agent: string;             // agent of last event
  last_ts: string;                // submission timestamp of last event
  last_acquired_ts: string;       // acquisition timestamp of last event
}

// CON graph edge
interface GraphEdge {
  source: string;                 // source target
  dest: string;                   // destination target
  edge_type?: string;             // optional typed edge label
  seq: number;                    // sequence of CON event that created this
}

// EVA-active registration
interface EvaRegistration {
  target: string;                 // the formula field target
  formula: any;                   // the function definition from DEF operand
  mode: 'fold' | 'horizon';      // classified at DEF time
  dependencies: string[];         // targets this formula depends on (from CON graph)
}

// Subscription for changefeed
interface Subscription {
  id: string;
  target_pattern: string;         // glob pattern (e.g. "app.tblClients.*")
  ops?: Operator[];               // filter by operator type, null = all
  callback: (event: EoEvent) => void;
}
```

---

## 4. Authentication — Matrix Token Verification

Every HTTP request and WebSocket connection must present a valid Matrix access token. The server verifies it against the Matrix homeserver at `https://app.aminoimmigration.com`.

```typescript
// src/auth/matrix.ts

const MATRIX_HOMESERVER = 'https://app.aminoimmigration.com';

interface MatrixUser {
  user_id: string;    // e.g. "@caseworker:app.aminoimmigration.com"
  device_id?: string;
}

/**
 * Verify a Matrix access token by calling the homeserver's /account/whoami endpoint.
 * Returns the Matrix user ID if valid, throws if invalid.
 *
 * Cache successful verifications for 5 minutes to avoid hitting the homeserver
 * on every request. Use a Map<token, {user: MatrixUser, expires: number}>.
 */
async function verifyMatrixToken(accessToken: string): Promise<MatrixUser> {
  // Check cache first
  const cached = tokenCache.get(accessToken);
  if (cached && cached.expires > Date.now()) {
    return cached.user;
  }

  const response = await fetch(`${MATRIX_HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error('Invalid Matrix token');
  }

  const data = await response.json();
  const user: MatrixUser = {
    user_id: data.user_id,
    device_id: data.device_id
  };

  // Cache for 5 minutes
  tokenCache.set(accessToken, { user, expires: Date.now() + 300_000 });
  return user;
}
```

**Auth middleware for Fastify:**

```typescript
// Extract token from Authorization header: "Bearer <token>"
// Or from query param: ?access_token=<token> (for WebSocket connections)
// Attach verified user to request: request.matrixUser = { user_id, device_id }
// Return 401 if token missing or invalid.
```

**Webhook-specific auth:** n8n may use a shared secret instead of a Matrix token. Support both:
- `Authorization: Bearer <matrix_token>` — verified against homeserver
- `Authorization: EoWebhook <shared_secret>` — verified against `EO_WEBHOOK_SECRET` env var. Agent is set to `@n8n:app.aminoimmigration.com` (a system agent).

---

## 5. Storage Layer — LevelDB

Single LevelDB database with keyspace prefixes. All keys are strings. All values are msgpack-encoded.

### 5.1 Keyspaces

```
log:<seq_padded>          → EoEvent        (zero-padded 12-digit seq for sort order)
state:<target>            → EoState        (projected state per target)
graph:fwd:<source>:<dest> → GraphEdge      (forward edges: source → dest)
graph:rev:<dest>:<source> → GraphEdge      (reverse edges: dest → source)
eva:<target>              → EvaRegistration (EVA-active formula registrations)
meta:seq                  → number         (current sequence counter)
meta:snapshot             → number         (seq of last snapshot)
idem:<client_event_id>    → number         (seq, for idempotency dedup, TTL 24h)
```

### 5.2 Sequence Counter

```typescript
// Atomic increment. Read meta:seq, increment, write, return new value.
// On first boot (key doesn't exist), start at 1.
async function nextSeq(db: Level): Promise<number> {
  let current = 0;
  try {
    current = await db.get('meta:seq');
  } catch (e) {
    // Key doesn't exist, start at 0
  }
  const next = current + 1;
  await db.put('meta:seq', next);
  return next;
}
```

### 5.3 Log Operations

```typescript
// Append an event to the log. Called by the fold after validation.
async function appendToLog(db: Level, event: EoEvent): Promise<void> {
  const key = `log:${String(event.seq).padStart(12, '0')}`;
  await db.put(key, event);
}

// Read log entries from a sequence number (inclusive) forward.
// Used by WebSocket sync: "give me everything since seq N."
async function readLogSince(db: Level, since: number, limit: number = 1000): Promise<EoEvent[]> {
  const start = `log:${String(since).padStart(12, '0')}`;
  const events: EoEvent[] = [];
  for await (const [key, value] of db.iterator({ gte: start, limit })) {
    if (!key.startsWith('log:')) break;
    events.push(value);
  }
  return events;
}

// Read log entries for a specific target (full scan with filter — use sparingly).
async function readLogForTarget(db: Level, target: string): Promise<EoEvent[]> {
  const events: EoEvent[] = [];
  for await (const [key, value] of db.iterator({ gte: 'log:', lte: 'log:\uffff' })) {
    if (value.target === target || value.target.startsWith(target + '.')) {
      events.push(value);
    }
  }
  return events;
}
```

### 5.4 State Operations

```typescript
// Get projected state at a target.
async function getState(db: Level, target: string): Promise<EoState | null> {
  try {
    return await db.get(`state:${target}`);
  } catch (e) {
    return null;
  }
}

// Get all projected state under a prefix.
async function getStateByPrefix(db: Level, prefix: string): Promise<EoState[]> {
  const results: EoState[] = [];
  for await (const [key, value] of db.iterator({
    gte: `state:${prefix}`,
    lte: `state:${prefix}\uffff`
  })) {
    if (!key.startsWith('state:')) break;
    results.push(value);
  }
  return results;
}

// Set projected state at a target. Called by the fold.
async function setState(db: Level, state: EoState): Promise<void> {
  await db.put(`state:${state.target}`, state);
}

// Remove projected state at a target. Called by fold on NUL.
async function removeState(db: Level, target: string): Promise<void> {
  await db.del(`state:${target}`);
}
```

### 5.5 Graph Operations

```typescript
// Add a directed edge. Called by fold on CON.
async function addEdge(db: Level, edge: GraphEdge): Promise<void> {
  await db.batch([
    { type: 'put', key: `graph:fwd:${edge.source}:${edge.dest}`, value: edge },
    { type: 'put', key: `graph:rev:${edge.dest}:${edge.source}`, value: edge }
  ]);
}

// Remove a directed edge. Called by fold on CON with removal operand.
async function removeEdge(db: Level, source: string, dest: string): Promise<void> {
  await db.batch([
    { type: 'del', key: `graph:fwd:${source}:${dest}` },
    { type: 'del', key: `graph:rev:${dest}:${source}` }
  ]);
}

// Get all outgoing edges from a target.
async function getEdgesFrom(db: Level, source: string): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  for await (const [key, value] of db.iterator({
    gte: `graph:fwd:${source}:`,
    lte: `graph:fwd:${source}:\uffff`
  })) {
    edges.push(value);
  }
  return edges;
}

// Get all incoming edges to a target.
async function getEdgesTo(db: Level, dest: string): Promise<GraphEdge[]> {
  const edges: GraphEdge[] = [];
  for await (const [key, value] of db.iterator({
    gte: `graph:rev:${dest}:`,
    lte: `graph:rev:${dest}:\uffff`
  })) {
    edges.push(value);
  }
  return edges;
}

// Traverse the graph from a starting target to a given depth.
// Returns all reachable targets and edges.
async function traverse(db: Level, start: string, depth: number): Promise<{
  targets: string[];
  edges: GraphEdge[];
}> {
  const visited = new Set<string>();
  const allEdges: GraphEdge[] = [];
  let frontier = [start];

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    for (const target of frontier) {
      if (visited.has(target)) continue;
      visited.add(target);
      const edges = await getEdgesFrom(db, target);
      for (const edge of edges) {
        allEdges.push(edge);
        if (!visited.has(edge.dest)) {
          nextFrontier.push(edge.dest);
        }
      }
    }
    frontier = nextFrontier;
  }

  return { targets: Array.from(visited), edges: allEdges };
}
```

---

## 6. The Fold — Nine-Case Projection Engine

The fold is the core of the database. It processes incoming events and updates projected state, the CON graph, and EVA-active formula results.

### 6.0 Operator Helix — Cumulative Capacity Model

The nine operators are **not independent handlers**. They form a cumulative helix where each operator inherits every capacity below it. The fold's operator dispatch is a call hierarchy, not a flat switch statement.

**Inheritance chain:** `NUL < SIG < INS < SEG < CON < SYN < DEF < EVA < REC`

Each handler may invoke the handlers below it:

| Operator | Inherited Capacities | Cost Profile |
|----------|---------------------|-------------|
| **INS** | NUL (observe/existence check), SIG (coordinate targeting) | Microseconds — 1-2 key operations |
| **SEG** | + INS (confirm target exists before partitioning) | Milliseconds — boundary metadata |
| **CON** | + SEG (partition awareness), INS (existence check on both endpoints) | Milliseconds — bidirectional index updates, may trigger recomputation |
| **SYN** | + CON (merge edges), SEG (dissolve boundaries), INS (mint merged identity) | Milliseconds — graph restructuring |
| **DEF** | + SYN (alias resolution), SEG (boundary respect), CON (dependency recomputation), INS (auto-instantiation) | Tens of ms — recomputation cascades possible |
| **EVA** | All above — reads formula (DEF), walks graph (CON), resolves aliases (SYN), respects boundaries (SEG), checks existence (INS), observes state (NUL), then computes | Tens of ms — exercises full dependency graph |
| **REC** | All nine capacities — runs contained operators in a loop until fixed point (convergence or oscillation detection) | Variable (10–500+ ms) — iteration count × cost of contained ops |

**Cost gradient:** Low operators (INS) are cheap and frequent. High operators (DEF, EVA, REC) are expensive but rare. The database's average cost per event is dominated by cheap operators, with occasional expensive bursts.

**Implementation pattern:** Shared helix utilities are defined in `src/db/helpers.ts`:
- `resolveAlias(db, target)` — SYN capacity: follow `_alias` chain to canonical target
- `checkExists(db, target)` — INS capacity: verify target is instantiated
- `checkBoundary(db, target)` — SEG capacity: read partition metadata
- `gatherDependencies(db, target)` — CON capacity: walk reverse graph for dependents

Higher operators call these utilities before executing their own logic. The fold processes operators sequentially — events must arrive in helix-consistent order. You cannot DEF a target that hasn't been INS'd (unless DEF auto-instantiates via its inherited INS capacity).

---

```typescript
// src/db/fold.ts

/**
 * Process a single EO event.
 * Called for every incoming event after validation and auth.
 *
 * Steps:
 * 1. Check idempotency (client_event_id)
 * 2. Assign sequence number
 * 3. Append to log
 * 4. Execute operator-specific logic
 * 5. Notify changefeed subscribers
 *
 * Returns the assigned sequence number.
 */
async function processEvent(db: Level, event: Omit<EoEvent, 'seq'>, feed: Feed): Promise<number> {
  // 1. Idempotency check
  if (event.client_event_id) {
    try {
      const existingSeq = await db.get(`idem:${event.client_event_id}`);
      return existingSeq; // already processed, return existing seq
    } catch (e) {
      // not found, proceed
    }
  }

  // 2. Assign sequence
  const seq = await nextSeq(db);
  const fullEvent: EoEvent = { ...event, seq };

  // 3. Append to log
  await appendToLog(db, fullEvent);

  // 4. Store idempotency key
  if (event.client_event_id) {
    await db.put(`idem:${event.client_event_id}`, seq);
  }

  // 5. Execute operator-specific logic
  await executeOperator(db, fullEvent);

  // 6. Recompute any fold-computed EVA-active targets that depend on this target
  await recomputeDependents(db, fullEvent.target);

  // 7. Notify changefeed
  feed.notify(fullEvent);

  return seq;
}
```

### 6.1 Operator Dispatch

```typescript
async function executeOperator(db: Level, event: EoEvent): Promise<void> {
  switch (event.op) {
    case 'INS':
      return executeINS(db, event);
    case 'DEF':
      return executeDEF(db, event);
    case 'CON':
      return executeCON(db, event);
    case 'SEG':
      return executeSEG(db, event);
    case 'SYN':
      return executeSYN(db, event);
    case 'EVA':
      return executeEVA(db, event);
    case 'REC':
      return executeREC(db, event);
  }
}
```

### 6.2 INS — Instantiate

> **Inherited capacities:** NUL (encounters keyspace to check existence), SIG (directs attention to specific coordinate). Three operations total — the cheapest loggable operator.

```typescript
async function executeINS(db: Level, event: EoEvent): Promise<void> {
  // NUL capacity: observe the keyspace to check for duplicates
  const existing = await getState(db, event.target);
  if (existing) {
    throw new Error(`Target already instantiated: ${event.target}`);
  }

  // Create state entry. INS carries initial field payload directly.
  await setState(db, {
    target: event.target,
    value: event.operand ?? {},
    last_seq: event.seq,
    last_op: 'INS',
    last_agent: event.agent,
    last_ts: event.ts
  });
}
```

### 6.3 DEF — Define Value or Register Computation

> **Inherited capacities:** SYN (alias resolution — if target was merged, write goes to canonical target), SEG (boundary respect — if target was SEG'd out, write still lands in log but Horizon knows to exclude), CON (dependency-triggered recomputation — walks reverse graph to find EVA-active dependents), INS (auto-instantiation — if target doesn't exist, DEF may mint it rather than reject). DEF is the workhorse operator: same write, vastly more work, because it stands on eight layers of infrastructure.

```typescript
async function executeDEF(db: Level, event: EoEvent): Promise<void> {
  // SYN capacity: resolve alias if target was merged
  const target = await resolveAlias(db, event.target);

  // INS capacity: auto-instantiate if target doesn't exist
  const existing = await getState(db, target);
  if (!existing) {
    await setState(db, {
      target,
      value: {},
      last_seq: event.seq,
      last_op: 'INS',
      last_agent: event.agent,
      last_ts: event.ts
    });
  }

  // DEF's own logic: merge operand into existing state (field-level merge for objects)
  const currentState = existing || { value: {} };
  const merged = mergeOperand(currentState.value, event.operand);

  await setState(db, {
    target,
    value: merged,
    last_seq: event.seq,
    last_op: 'DEF',
    last_agent: event.agent,
    last_ts: event.ts
  });

  // Check if operand is a function definition (formula field)
  if (isFormulaOperand(event.operand)) {
    await registerEvaActive(db, target, event.operand);
  }
  // CON capacity: recomputation of dependents happens in processEvent after executeOperator returns
}

/**
 * Merge incoming operand with existing value.
 * If both are objects, shallow merge (incoming fields overwrite).
 * If either is not an object, incoming replaces.
 */
function mergeOperand(existing: any, incoming: any): any {
  if (
    existing && typeof existing === 'object' && !Array.isArray(existing) &&
    incoming && typeof incoming === 'object' && !Array.isArray(incoming)
  ) {
    return { ...existing, ...incoming };
  }
  return incoming;
}

/**
 * Check if an operand is a formula definition.
 * Convention: operand has a `formula` key.
 */
function isFormulaOperand(operand: any): boolean {
  return operand && typeof operand === 'object' && 'formula' in operand;
}

/**
 * Register a target as EVA-active.
 * Classify as fold-computed or Horizon-computed based on formula input analysis.
 */
async function registerEvaActive(db: Level, target: string, operand: any): Promise<void> {
  // Determine dependencies from the CON graph
  const edges = await getEdgesFrom(db, target);
  const dependencies = edges.map(e => e.dest);

  // Classify: if formula references external inputs (time, etc.), Horizon-computed.
  // For now, check if formula string contains time-related functions.
  const mode = formulaReferencesExternal(operand.formula) ? 'horizon' : 'fold';

  const registration: EvaRegistration = {
    target,
    formula: operand,
    mode,
    dependencies
  };

  await db.put(`eva:${target}`, registration);

  // If fold-computed, evaluate immediately
  if (mode === 'fold') {
    await evaluateFormula(db, registration);
  }
}

/**
 * Check if a formula references external variables (time, etc.).
 * This is a simple heuristic — extend as needed.
 */
function formulaReferencesExternal(formula: string): boolean {
  const externalPatterns = [
    'NOW()', 'TODAY()', 'DAYS_UNTIL(', 'DAYS_SINCE(',
    'CURRENT_TIME', 'CURRENT_DATE'
  ];
  const upper = typeof formula === 'string' ? formula.toUpperCase() : '';
  return externalPatterns.some(p => upper.includes(p));
}
```

### 6.4 CON — Connect

> **Inherited capacities:** INS (existence check on both endpoints — can't connect targets that don't exist), SEG (partition awareness — knows which keyspace regions the endpoints are in). CON is moderately expensive: it updates bidirectional indexes and may trigger downstream recomputation via the reverse graph.

```typescript
async function executeCON(db: Level, event: EoEvent): Promise<void> {
  const operand = event.operand;

  // INS capacity: verify both endpoints exist
  if (operand.added) {
    for (const dest of operand.added) {
      const destExists = await getState(db, dest);
      if (!destExists) {
        throw new Error(`CON target does not exist: ${dest}`);
      }
    }
  }

  // operand format: { added?: string[], removed?: string[], edge_type?: string }
  if (operand.added) {
    for (const dest of operand.added) {
      await addEdge(db, {
        source: event.target,
        dest,
        edge_type: operand.edge_type,
        seq: event.seq
      });
    }
  }

  if (operand.removed) {
    for (const dest of operand.removed) {
      await removeEdge(db, event.target, dest);
    }
  }

  // Update state to reflect current link set
  const currentEdges = await getEdgesFrom(db, event.target);
  await setState(db, {
    target: event.target,
    value: { linked: currentEdges.map(e => e.dest), edge_type: operand.edge_type },
    last_seq: event.seq,
    last_op: 'CON',
    last_agent: event.agent,
    last_ts: event.ts
  });
}
```

### 6.5 SEG — Segment (Boundary)

> **Inherited capacities:** INS (confirms target exists before partitioning — can't draw a boundary on something that hasn't been instantiated), NUL (encounters the collection), SIG (identifies which targets are inside).

```typescript
async function executeSEG(db: Level, event: EoEvent): Promise<void> {
  // INS capacity: confirm target exists
  const existing = await getState(db, event.target);
  if (!existing) {
    throw new Error(`SEG target does not exist: ${event.target}`);
  }

  // SEG draws or dissolves a boundary.
  // In the append-only model, "deletion" is SEG — partitioning something
  // out of the active set.
  //
  // operand format: { boundary: 'exclude' | 'include', reason?: string }
  // or: { partition: string, members: string[] }

  await setState(db, {
    target: event.target,
    value: event.operand,
    last_seq: event.seq,
    last_op: 'SEG',
    last_agent: event.agent,
    last_ts: event.ts
  });
}
```

### 6.6 SYN — Synthesis (Merge)

> **Inherited capacities:** CON (uses graph to find edges for merging), SEG (dissolves boundary between merged targets), INS (mints merged target identity), NUL (observes both targets). When SYN merges two targets, it observes both (NUL), attends to them (SIG), confirms they exist (INS), recognizes their boundary (SEG), sees their connections (CON), then creates the merged entity.

```typescript
async function executeSYN(db: Level, event: EoEvent): Promise<void> {
  // operand format: { merge: [targetA, targetB], into: mergedTarget }
  // or: { split: mergedTarget, into: [targetA, targetB] }
  const operand = event.operand;

  if (operand.merge) {
    const [a, b] = operand.merge;
    // INS capacity: confirm both targets exist
    const stateAExists = await getState(db, a);
    const stateBExists = await getState(db, b);
    if (!stateAExists || !stateBExists) {
      throw new Error(`SYN merge targets must both exist: ${a}, ${b}`);
    }
    const stateA = await getState(db, a);
    const stateB = await getState(db, b);

    // Merge state values
    const mergedValue = mergeOperand(stateA?.value, stateB?.value);
    const mergedTarget = operand.into || event.target;

    await setState(db, {
      target: mergedTarget,
      value: mergedValue,
      last_seq: event.seq,
      last_op: 'SYN',
      last_agent: event.agent,
      last_ts: event.ts
    });

    // Merge CON edges: all edges from/to A and B now point to merged target
    const edgesFromA = await getEdgesFrom(db, a);
    const edgesFromB = await getEdgesFrom(db, b);
    const edgesToA = await getEdgesTo(db, a);
    const edgesToB = await getEdgesTo(db, b);

    for (const edge of [...edgesFromA, ...edgesFromB]) {
      await addEdge(db, { ...edge, source: mergedTarget });
    }
    for (const edge of [...edgesToA, ...edgesToB]) {
      await addEdge(db, { ...edge, dest: mergedTarget });
    }

    // Store alias records so queries for A or B resolve to merged target
    await db.put(`state:${a}`, {
      target: a, value: { _alias: mergedTarget },
      last_seq: event.seq, last_op: 'SYN', last_agent: event.agent, last_ts: event.ts
    });
    await db.put(`state:${b}`, {
      target: b, value: { _alias: mergedTarget },
      last_seq: event.seq, last_op: 'SYN', last_agent: event.agent, last_ts: event.ts
    });
  }
}
```

### 6.7 EVA — Evaluate

> **Inherited capacities:** All eight below. EVA is where cumulative power peaks before REC. A single EVA fold step:
> 1. Reads the formula definition — inherited from DEF (what holds at this target)
> 2. Walks the dependency graph — inherited from CON (what connects to what)
> 3. Resolves aliases on every dependency — inherited from SYN (merged targets resolve correctly)
> 4. Respects partition boundaries — inherited from SEG (archived dependencies excluded per policy)
> 5. Checks that each dependency exists — inherited from INS (no phantom targets)
> 6. Gathers the current value at each dependency — inherited from NUL (observe state)
> 7. Computes the formula — EVA's own capacity
> 8. Writes the result to projected state — inherited from DEF
>
> A relational database doing the same work would need JOINs, WHERE subqueries, view resolution, existence checks, SELECTs, computed columns, and UPDATEs — seven separate SQL operations. EO does it in one fold step.

```typescript
async function executeEVA(db: Level, event: EoEvent): Promise<void> {
  // EVA sets evaluation policy or conflict resolution strategy.
  // operand format: { strategy: 'latest' | 'priority' | 'manual' | 'formula', ... }

  await setState(db, {
    target: event.target,
    value: event.operand,
    last_seq: event.seq,
    last_op: 'EVA',
    last_agent: event.agent,
    last_ts: event.ts
  });
}
```

### 6.8 REC — Recursion (Fixed-Point Iteration)

> **Inherited capacities:** Everything. REC inherits all eight prior capacities and adds recursion to a fixed point. REC is the only operator whose execution is not a single pass through the combining function. When the fold encounters a REC, it runs the operator sequence in the contains array, checks whether the output changed the inputs to its own computation, and if it did, runs the sequence again. It repeats until the state stabilizes or until it detects a cycle.
>
> **Three outcomes:** Convergence (state stops changing), oscillation (state cycles between configurations), or max-iteration bailout (safety valve). The REC event in the log carries the final result, iteration count, and the full contains array for provenance.
>
> **Operand format:** `{ pivot?: string, contains: SubOp[], max_iterations?: number, reason?: string }`

```typescript
async function executeREC(db: Level, event: EoEvent): Promise<void> {
  // REC runs its contains array as a loop body, iterating until fixed point.
  // Sub-events do NOT get their own sequence numbers or log entries.
  // The REC is one log entry. The sub-operations apply to projected state
  // as part of the REC's fold execution, potentially multiple times.

  const subOps = event.operand?.contains || [];
  const pivot = event.operand?.pivot || null;
  const maxIterations = event.operand?.max_iterations || 100;

  // Collect all targets the loop body touches
  const watchedTargets = new Set<string>();
  for (const subOp of subOps) {
    if (subOp.target) watchedTargets.add(subOp.target);
  }
  if (pivot) watchedTargets.add(pivot);

  // Snapshot: capture current state of all watched targets
  async function snapshot() {
    const snap: Record<string, any> = {};
    for (const t of watchedTargets) {
      const state = await getState(db, t);
      snap[t] = state?.value ?? null;
    }
    return snap;
  }

  // Take initial snapshot, then iterate
  const history = [await snapshot()];
  let iterations = 0;
  let converged = false;
  let cycleLength = 0;

  while (iterations < maxIterations) {
    // Run all sub-operations (one full pass)
    for (const subOp of subOps) {
      await executeOperator(db, { ...subOp, seq: event.seq, agent: event.agent, ts: event.ts });
      await recomputeDependents(db, subOp.target);
    }

    iterations++;
    const currentSnap = await snapshot();

    // Check against all previous snapshots
    for (let i = 0; i < history.length; i++) {
      if (deepEqual(currentSnap, history[i])) {
        if (i === history.length - 1) converged = true;  // same as last pass = stable
        else cycleLength = history.length - i;            // oscillation
        break;
      }
    }
    if (converged || cycleLength > 0) break;
    history.push(currentSnap);
  }

  // Build result: { converged, iterations, cycle_length?, states?, stable_state? }
  const result = { converged, iterations, ...(
    !converged && cycleLength > 0
      ? { cycle_length: cycleLength, states: history.slice(history.length - cycleLength) }
      : converged ? { stable_state: await snapshot() } : {}
  )};

  await setState(db, {
    target: event.target,
    value: { recursion: true, pivot, sub_ops: subOps.length, reason: event.operand?.reason, result },
    last_seq: event.seq,
    last_op: 'REC',
    last_agent: event.agent,
    last_ts: event.ts
  });
}
```

### 6.9 Dependent Recomputation

```typescript
/**
 * After any state change, walk the CON graph in reverse to find
 * EVA-active targets that depend on the changed target.
 * Recompute fold-computed formulas. Skip Horizon-computed.
 */
async function recomputeDependents(db: Level, changedTarget: string): Promise<void> {
  // Find all targets that have CON edges pointing TO the changed target
  const reverseEdges = await getEdgesTo(db, changedTarget);

  for (const edge of reverseEdges) {
    // Check if the source of this edge is EVA-active
    let registration: EvaRegistration | null = null;
    try {
      registration = await db.get(`eva:${edge.source}`);
    } catch (e) {
      continue; // not EVA-active
    }

    if (registration && registration.mode === 'fold') {
      await evaluateFormula(db, registration);

      // Recurse: if this formula's result changed, its dependents need recomputation too
      await recomputeDependents(db, registration.target);
    }
  }
}

/**
 * Evaluate a fold-computed formula.
 * Read dependencies from state, apply the formula, write result to state.
 *
 * IMPORTANT: Formula evaluation writes to projected state only, NOT to the log.
 * The log records what came from outside. Projected state records consequences.
 */
async function evaluateFormula(db: Level, registration: EvaRegistration): Promise<void> {
  // Gather dependency values
  const inputs: Record<string, any> = {};
  for (const dep of registration.dependencies) {
    const state = await getState(db, dep);
    inputs[dep] = state?.value;
  }

  // Execute the formula (simple evaluator — extend as needed)
  const result = executeFormulaFunction(registration.formula, inputs);

  // Write result to projected state
  const existing = await getState(db, registration.target);
  await setState(db, {
    target: registration.target,
    value: { ...existing?.value, _computed: result },
    last_seq: existing?.last_seq || 0,
    last_op: existing?.last_op || 'DEF',
    last_agent: 'system:eva',
    last_ts: new Date().toISOString()
  });
}

/**
 * Simple formula executor. Supports basic operations.
 * This is a placeholder — replace with a proper formula engine.
 */
function executeFormulaFunction(formula: any, inputs: Record<string, any>): any {
  // For now, return the formula definition and inputs for the application to evaluate
  // A full implementation would parse formula.formula string and compute
  return { formula: formula.formula, inputs, evaluated_at: new Date().toISOString() };
}
```

---

## 7. Horizon — The File Cabinet

The relational model freed the query from the file cabinet. But the file cabinet gave you context for free — you opened a drawer and immediately saw the drawer you were in, the nearby folders, and the policy sheet taped inside. SQL returns one row, stripped of everything that surrounded it.

The Horizon restores what the file cabinet gave: you open a record, and the database shows the record, the ambient conditions, the similar records, the rules that apply, and the shape of the record's history. No JOINs. No subqueries. The caseworker doesn't need to know they want context. It's just there because the database already has the structure.

### 7.0 Cost Model

Five cheap layers (microseconds of additional read time each):
1. **Figure** — what this target IS. One state lookup.
2. **Ground** — what this target is IN. Walk up the prefix hierarchy (2-3 ancestor lookups).
3. **Nearby** — what's next to it. One prefix scan + in-memory field comparison.
4. **Governance** — what rules apply. Scan `eva:` keyspace for matching registrations.
5. **Trajectory** — where it's been. Filter log for this target, extract operator sequence.

One expensive layer (on-demand only):
6. **Signals** — statistical patterns across populations. Full population scan + aggregation.

### 7.1 Response Format

```typescript
interface HorizonResponse {
  target: string;
  figure: EoState | null;                   // what this target IS
  grounds: GroundEntry[];                    // ambient conditions pervading this region
  nearby?: NearbyEntry[];                    // similar records in the same collection
  governance?: GovernanceEntry[];            // EVA policies that govern this target
  trajectory?: LoggableOperator[];           // compact operator history shape
  signals?: SignalEntry[];                   // statistical patterns (on-demand, expensive)
}
```

### 7.2 Layer 1: Figure

Projected state with alias resolution and Horizon-computed EVA. Same as before.

### 7.3 Layer 2: Grounds

Walk up the prefix hierarchy collecting ancestor-level state. Override rule: if the figure has an explicit value for a field that also exists as a ground, the figure's value wins (CSS cascade). For `app.tblClients.rec001`, check `app.tblClients` (distance=1) and `app` (distance=2).

### 7.4 Layer 3: Nearby

Records in the same collection sharing structural traits with this one. Same case type, same filing period, same caseworker, same linked client. Not a statistical analysis — a proximity read. One prefix scan plus field-value matching against the current target's values. Also checks CON linkage: records linked to the same targets are nearby.

### 7.5 Layer 4: Governance

EVA policies and formula registrations that apply to this region of the key-space. Not just inherited DEF values (those are grounds) — but evaluation rules: "Email conflicts on client records resolve by latest." "Case deadline formulas use business days." Already in the `eva:` keyspace. The Horizon already reads them for fold computation. Now it shows them in the read response.

### 7.6 Layer 5: Trajectory

The shape of this record's journey. Not the full log — that's the event stream. But the operator sequence compressed to its contour: `INS → DEF → CON → DEF → EVA → SEG`. Consecutive same-ops are collapsed. The operator types tell the story without replaying history.

### 7.7 Layer 6: Signals (on-demand)

On-demand population analytics. Only runs when `?signals=true`. Computes basic statistics over numeric fields in the target's collection. Surfaces outliers (|z| > 1.5). Ephemeral — SIG-level operation, never stored.

### 7.8 API Query Parameters

```
GET /horizon/:target
  ?prefix=true       → array of HorizonResponse for all targets under prefix
  ?signals=true      → include signal detection (expensive, on-demand only)
  ?ancestry=false    → exclude ancestry chain
  ?grounds=false     → exclude grounds
  ?nearby=false      → exclude nearby
  ?governance=false  → exclude governance
  ?trajectory=false  → exclude trajectory
```

Default: ancestry, grounds, nearby, governance, and trajectory are all ON. Signals are OFF. The cheap layers are always present. The expensive layer is opt-in.

### 7.9 Explorer Presentation Model

The admin explorer shows Horizon layers as **one record with depth of field**, not as six sections. Six layers presented as six sections is a UX failure. Six layers presented as one record with smart annotations is what the database actually sees — one observation at varying depths of focus.

**Visual hierarchy does the work:**

- **Figure** — full contrast, full brightness. The record's fields in a grid.
- **Trajectory** — one line under the target path. Operator badges with timestamps. The record's heartbeat.
- **Grounds** — one context line: `regulatoryHold: active · Nashville · biweekly`. Inherited ambient conditions.
- **Nearby** — one sentence: `Similar: Carlos Mendez (H1B, Nashville, @sara), Aisha Patel (H1B)`.
- **Governance** — tiny inline badges on governed fields: `⊨ latest` on email, `ƒ filed+180` on deadline.
- **Signals** — one quiet footnote: `daysOpen 45 — above average (28, n=4)`. Expands on click.

Everything fits one screen. No tabs. No toggles. Expand any layer for detail, but the default is: everything visible, nothing demands attention unless notable.

**The target sidebar is an ontology tree**, not a flat list of dot-paths:

```
▼ app.tblClients                    4 records
  ├ regulatoryHold: active          ← ground, visible in sidebar
  ├ defaultRegion: Nashville
  ├ rec001  Maria Garcia            ← figure, click to view
  ├ rec002  Carlos Mendez
  ├ rec003  Aisha Patel
  └ rec004  Wei Zhang

▼ app.tblCases                      4 records
  ├ reviewCycle: biweekly           ← ground
  ├ rec101  H1B · approved
  ├ rec102  L1A · pending
  └ rec103  H1B · under review

▶ app                               ← application-level
  ├ timezone: America/Chicago       ← ground
  └ firm: Amino Immigration
```

Grounds are already visible in navigation. When you click `rec001`, the grounds section confirms what the tree already showed. The user has context before they click.

**CON edges show inline** as clickable field values, not in a separate graph section. The `fldCases` field shows `rec101 → H1B approved`. Click to navigate.

**Click any log event** to open its target's Horizon. The log is the timeline. The Horizon is what you see when you focus on a point in it.

---

## 8. Changefeed — Subscription Routing

```typescript
// src/db/feed.ts

class Feed {
  private subscriptions: Map<string, Subscription> = new Map();

  subscribe(sub: Subscription): void {
    this.subscriptions.set(sub.id, sub);
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);
  }

  /**
   * Notify all matching subscribers of a new event.
   * Match by target glob pattern and operator filter.
   */
  notify(event: EoEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (this.matches(sub, event)) {
        try {
          sub.callback(event);
        } catch (e) {
          // subscriber error, don't crash the fold
        }
      }
    }
  }

  private matches(sub: Subscription, event: EoEvent): boolean {
    // Check operator filter
    if (sub.ops && !sub.ops.includes(event.op)) return false;

    // Check target pattern (simple glob: * matches any segment, ** matches any depth)
    return globMatch(sub.target_pattern, event.target);
  }
}

/**
 * Simple glob matcher for dot-separated target paths.
 * "app.tblClients.*" matches "app.tblClients.rec123" but not "app.tblClients.rec123.fldEmail"
 * "app.tblClients.**" matches everything under app.tblClients at any depth
 */
function globMatch(pattern: string, target: string): boolean {
  if (pattern === '**' || pattern === '*') return true;

  const patternParts = pattern.split('.');
  const targetParts = target.split('.');

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '**') return true;
    if (patternParts[i] === '*') {
      if (i === patternParts.length - 1) {
        return targetParts.length === patternParts.length;
      }
      continue;
    }
    if (targetParts[i] !== patternParts[i]) return false;
  }

  return patternParts.length === targetParts.length;
}
```

---

## 9. API — HTTP Endpoints

### 9.1 Webhook Ingestion

```
POST /webhook
Authorization: Bearer <matrix_token> | EoWebhook <shared_secret>
Content-Type: application/json

Body: single event or array of events
{
  "op": "DEF",
  "target": "app.tblClients.rec123.fldEmail",
  "operand": "hello@email.com",
  "client_event_id": "n8n-evt-abc123",
  "meta": { "source": "airtable", "table": "tblClients" }
}

Response 200:
{ "seq": 4207 }

Response 200 (batch):
{ "sequences": [4207, 4208, 4209] }

Response 401:
{ "error": "Invalid authentication" }

Response 409 (idempotency):
{ "seq": 4207, "deduplicated": true }
```

Agent is set from the verified Matrix user ID, or from the system agent for webhook secret auth.

### 9.2 Direct Operator Endpoints

```
POST /ops/ins    — body: { target, operand?, client_event_id? }
POST /ops/def    — body: { target, operand, client_event_id? }
POST /ops/con    — body: { target, operand: { added?, removed?, edge_type? }, client_event_id? }
POST /ops/seg    — body: { target, operand, client_event_id? }
POST /ops/syn    — body: { target, operand: { merge?, split?, into? }, client_event_id? }
POST /ops/eva    — body: { target, operand: { strategy, ... }, client_event_id? }
POST /ops/rec    — body: { target, operand: { contains: [...] }, client_event_id? }

All require Authorization: Bearer <matrix_token>
Agent set from verified Matrix user ID.
Response: { seq: number }
```

### 9.3 Query Endpoints

```
GET /horizon/:target
  → Returns projected state at target, with alias resolution and Horizon-computed evaluation.
  Response: EoState

GET /horizon/:target?prefix=true
  → Returns all state under target prefix.
  Response: EoState[]

GET /traverse/:target?depth=2
  → Returns CON graph traversal from target.
  Response: { targets: string[], edges: GraphEdge[] }

GET /log?since=4200&limit=100
  → Returns log entries from sequence number.
  Response: { events: EoEvent[], next_seq: number }

GET /log/:target
  → Returns all log entries that touched this target.
  Response: { events: EoEvent[] }

GET /edges/:target?direction=outgoing
  → Returns CON edges from/to target.
  direction: "outgoing" | "incoming" | "both"
  Response: { edges: GraphEdge[] }

All require Authorization: Bearer <matrix_token>
```

### 9.4 Health / Meta

```
GET /health
  → { status: "ok", seq: <current_seq>, uptime: <seconds> }
  No auth required.

GET /meta
  → { seq: <current_seq>, event_count: <total>, db_size: <bytes> }
  Requires auth.
```

---

## 10. WebSocket Sync — amino-eo Connection

```
WebSocket: ws://<host>:3000/sync?access_token=<matrix_token>
```

### 10.1 Connection Protocol

```
1. Client connects with Matrix access token as query param.
2. Server verifies token against app.aminoimmigration.com.
3. If invalid, close with code 4401.
4. If valid, connection established. Server sends:

   { "type": "connected", "user_id": "@caseworker:app.aminoimmigration.com", "current_seq": 4500 }

5. Client sends sync request:

   { "type": "sync", "since": 4200 }

6. Server streams all events from seq 4200 to current:

   { "type": "event", "event": { seq: 4201, op: "DEF", target: "...", ... } }
   { "type": "event", "event": { seq: 4202, op: "CON", target: "...", ... } }
   ...
   { "type": "sync_complete", "through_seq": 4500 }

7. After sync_complete, server pushes new events in real-time as they arrive:

   { "type": "event", "event": { seq: 4501, op: "DEF", target: "...", ... } }

8. Client can re-sync at any time by sending another sync message.
9. Client can subscribe to specific patterns:

   { "type": "subscribe", "pattern": "app.tblClients.**", "ops": ["DEF", "CON"] }

   After subscribing, only matching events are pushed.
```

### 10.2 Implementation

```typescript
// src/api/sync.ts

// On WebSocket connection:
// 1. Extract access_token from query params
// 2. Verify via matrix.ts
// 3. Register the connection in the Feed with a callback that sends JSON to the socket
// 4. Handle incoming messages (sync requests, subscribe)
// 5. On disconnect, remove subscription from Feed
```

---

## 11. Environment Configuration

```bash
# .env
EO_PORT=3000                                          # HTTP/WebSocket port
EO_DATA_DIR=/var/lib/eo-db/data                       # LevelDB data directory
EO_MATRIX_HOMESERVER=https://app.aminoimmigration.com # Matrix homeserver for token verification
EO_WEBHOOK_SECRET=<random-64-char-hex>                # shared secret for n8n webhook auth
EO_LOG_LEVEL=info                                     # debug | info | warn | error
```

---

## 12. Deployment — VM Setup

```bash
# 1. Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Create app directory
sudo mkdir -p /opt/eo-db
sudo mkdir -p /var/lib/eo-db/data

# 3. Clone / copy codebase
cd /opt/eo-db
# ... copy files ...
npm install
npm run build   # tsc

# 4. Create .env
cp .env.example .env
# Edit .env with production values

# 5. Create systemd service
sudo cat > /etc/systemd/system/eo-db.service << 'EOF'
[Unit]
Description=EO///DB Server
After=network.target

[Service]
Type=simple
User=eo-db
WorkingDirectory=/opt/eo-db
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=/opt/eo-db/.env

[Install]
WantedBy=multi-user.target
EOF

# 6. Create service user
sudo useradd -r -s /bin/false eo-db
sudo chown -R eo-db:eo-db /opt/eo-db /var/lib/eo-db

# 7. Start
sudo systemctl daemon-reload
sudo systemctl enable eo-db
sudo systemctl start eo-db

# 8. Verify
curl http://localhost:3000/health
```

### 12.1 Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name eo-db.aminoimmigration.com;

    ssl_certificate /etc/letsencrypt/live/eo-db.aminoimmigration.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eo-db.aminoimmigration.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /sync {
        proxy_pass http://127.0.0.1:3000/sync;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

---

## 13. n8n Webhook Configuration

Configure n8n to POST EO events to the webhook endpoint:

```
URL: https://eo-db.aminoimmigration.com/webhook
Method: POST
Headers:
  Authorization: EoWebhook <EO_WEBHOOK_SECRET>
  Content-Type: application/json

Body (single event):
{
  "op": "DEF",
  "target": "appXkR9w.tblClients.rec123.fldEmail",
  "operand": { "email": "new@example.com" },
  "client_event_id": "n8n-{{ $json.airtable_webhook_id }}",
  "meta": {
    "source": "airtable",
    "base": "appXkR9w",
    "table": "tblClients"
  }
}

Body (batch):
[
  { "op": "INS", "target": "...", "operand": {...}, "client_event_id": "..." },
  { "op": "DEF", "target": "...", "operand": {...}, "client_event_id": "..." },
  { "op": "CON", "target": "...", "operand": {...}, "client_event_id": "..." }
]
```

The EO classifier in n8n (Stage 3) determines the operator type. The webhook endpoint receives pre-classified events.

---

## 14. amino-eo Integration

### 14.1 Changes to amino-eo

Remove:
- All Postgres connection code
- `eo_events` and `eo_state` table references
- The `project_event()` trigger logic
- SSE sync endpoint and client

Add:
- WebSocket connection to `wss://eo-db.aminoimmigration.com/sync`
- On connect: send `{ type: "sync", since: <last_known_seq> }` (read from IndexedDB)
- On event: pass to existing Zustand store `applyEvent()` — the fold logic stays the same client-side
- On sync_complete: update last_known_seq in IndexedDB
- Auth: pass the Matrix access token (already available from Matrix login) as query param

### 14.2 Sync Flow

```
1. User opens amino-eo, logs in via Matrix (existing flow)
2. amino-eo opens WebSocket to eo-db with Matrix access token
3. amino-eo sends sync request with last known seq from IndexedDB
4. eo-db streams missed events
5. amino-eo applies each event to Zustand store (existing applyEvent)
6. amino-eo stores events in IndexedDB (existing offline persistence)
7. After sync_complete, eo-db pushes new events in real-time
8. When user makes a change in amino-eo, amino-eo POSTs to /ops/* endpoint
   (instead of writing to Postgres via n8n)
```

---

## 15. Testing

### 15.1 Required Test Cases

**Fold tests (fold.test.ts):**
- INS creates new state, rejects duplicate INS on same target
- DEF merges field values into existing state
- DEF with formula operand registers EVA-active target
- CON adds edges to graph, updates state
- CON removal deletes edges
- SEG writes boundary state
- SYN merges two targets, creates aliases, merges edges
- EVA writes policy state
- REC applies sub-operations atomically
- Idempotency: same client_event_id returns same seq, no duplicate processing
- Dependent recomputation: DEF on upstream target triggers fold-computed EVA recalc
- Dependent recomputation does not trigger for Horizon-computed targets
- Circular dependency detection: reject formula that creates a cycle

**Log tests (log.test.ts):**
- Events are sequenced correctly
- readLogSince returns events from given seq
- readLogForTarget filters correctly

**Graph tests (graph.test.ts):**
- addEdge creates forward and reverse entries
- removeEdge deletes both entries
- traverse walks to correct depth, avoids cycles
- getEdgesFrom / getEdgesTo return correct edges

**Auth tests (auth.test.ts):**
- Valid Matrix token returns user_id
- Invalid token returns 401
- Webhook shared secret authenticates as system agent
- Token cache works (second call doesn't hit homeserver)
- Expired cache re-verifies

**Sync tests (sync.test.ts):**
- WebSocket connection with valid token succeeds
- WebSocket connection with invalid token closes with 4401
- Sync request returns events since given seq
- Real-time events push to connected clients
- Subscribe filters events by pattern and operator

### 15.2 Fixture Data

Create test fixtures that simulate Airtable webhook payloads classified by the EO classifier:

```typescript
// tests/fixtures.ts
export const FIXTURES = [
  { op: 'INS', target: 'app.tblClients.rec001', operand: { name: 'Maria Garcia', status: 'active' }, client_event_id: 'fix-001' },
  { op: 'INS', target: 'app.tblCases.rec101', operand: { type: 'H1B', filed: '2025-06-01' }, client_event_id: 'fix-002' },
  { op: 'CON', target: 'app.tblClients.rec001.fldCases', operand: { added: ['app.tblCases.rec101'] }, client_event_id: 'fix-003' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'pending', client_event_id: 'fix-004' },
  { op: 'DEF', target: 'app.tblCases.rec101.fldStatus', operand: 'approved', client_event_id: 'fix-005' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@old.com', client_event_id: 'fix-006', agent: '@intake:app.aminoimmigration.com' },
  { op: 'DEF', target: 'app.tblClients.rec001.fldEmail', operand: 'maria@new.com', client_event_id: 'fix-007', agent: '@caseworker:app.aminoimmigration.com' },
];
```

---

## 16. Build & Run Commands

```json
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

---

## 17. What This Does NOT Include (Future Phases)

- **Admin interface** — the visual UI for browsing state, log, graph. Build as a separate React app served by the same server. Phase 2.
- **Full formula engine** — the `executeFormulaFunction` is a placeholder. A real formula evaluator that parses and computes `SUM(linked.amount)` etc. needs to be built. Phase 2.
- **Type registry** — pluggable operand type handlers (vector → HNSW, spatial → R-tree). Not needed for amino-eo's current workload. Phase 4.
- **Snapshots** — periodic serialization of projected state for fast cold-start. Add when log exceeds ~100k events.
- **Backup** — LevelDB file-level backup strategy. Use filesystem snapshots or `ldb` tool.
