# The Transformation Calculus: A Design Report on the EO-Native Database

**Michael T. Lacy — March 2026**

see also: https://github.com/clovenbradshaw-ctrl/amino-eo

> **Architecture Update (March 2026):** This report's analysis of why the EO-native database must exist is validated by the current implementation. The three redundant implementations described in §3 (Zustand store, IndexedDB layer, PL/pgSQL trigger) have been unified. The next evolution removes the server entirely: the fold runs in every browser, data persists in encrypted IndexedDB, and devices sync through Matrix. The transformation calculus, operator helix, and Horizon are unchanged — only the storage substrate and sync topology change. See `DEVELOPMENT-STAGES.md`.

---

## 1. The Inversion

Every database in production today starts from a storage model and works up. Relational databases start from tables. Document stores start from JSON blobs. Graph databases start from nodes and edges. Vector stores start from embeddings. Each decides how to hold data first, then bolts on a query language, then discovers — often painfully — the transformations it cannot express.

All of them share a deeper structural feature: the write side and the read side speak different languages. The write side is CRUD — three dumb verbs (insert, update, delete) plus read. The read side is a rich retrieval algebra — relational algebra for SQL, aggregation pipelines for Mongo, traversal languages for graph databases. The application bridges the gap, translating domain semantics into write-side verbs and reconstructing them from read-side queries.

EO inverts this. It starts from a transformation model and works down. The nine operators are not an API that wraps a database. They are the specification for one. A single calculus governs both the write and the read. SEG writes a boundary; SEG queries a boundary. CON writes a relationship; CON queries a relationship. The same nine operators that describe how state changes also describe how state is retrieved. There is no gap to bridge.

This report examines what that inversion implies: what the nine operators actually require from a storage substrate, where existing systems fail to provide it, and what a purpose-built EO database would look like.

---

## 2. Calculus, Not Algebra

The distinction is load-bearing.

An algebra is a closed set of operations on objects. Compose them, get new objects of the same kind. Static. Relational algebra: compose select, project, join — get a new relation. Each operation is a standalone transformation. The operations don't accumulate.

A calculus is a system of accumulation toward a limit. The fold is the defining operation. State is the integral of the event log — every event is an infinitesimal contribution, the projection accumulates them, the current state is where the accumulation has reached so far. Not a final answer. A position on a trajectory.

EO already says this: truth has the structure of a calculus limit. Approached asymptotically. The Given-Log accumulates. The projection is the running integral. Defeasibility (Rule 9) is the theorem that no finite accumulation reaches the limit — there is no final state immune to supersession.

The nine operators form a basis (algebraic property — closed, composable, minimal). But what the system does with them is accumulation, not composition. `DEF → DEF → EVA → DEF` is not a composed expression that evaluates to a static result. It is four increments on a trajectory. The Horizon shows where the trajectory currently sits. Replay to a different timestamp shows where it sat then.

Existing databases are storage engines with retrieval algebras. The EO database is a storage engine whose write side and read side are both projections of the same transformation calculus.

---

## 3. What Already Exists in Application Code

The clearest evidence that an EO-native database is missing is that the application has already built one — in JavaScript.

The `amino-eo` codebase contains a Zustand store (`eo-store.ts`) that implements every primitive a storage engine needs:

- A **key-value store**: `state: Map<string, EoState>` — targets mapped to current values.
- **Namespace partitioning**: `tableIndex: Map<string, Map<string, EoState>>` — prefix-organized access to subsets of the key space.
- A **projection function**: `applyEvent()` — operator-aware merge logic that folds incoming events into current state.
- A **query interface**: `getReader()` — exactly two methods: `get(target)` and `getByPrefix(prefix)`.
- A **compaction strategy**: `applyBatch()` with last-writer-wins deduplication.

This store runs in the browser. It also runs, separately, in IndexedDB for offline persistence. And it runs again, in a structurally different form, as a PL/pgSQL trigger in Postgres (`project_event()`) that manually implements event sourcing projection.

Three implementations of the same semantics in three different environments. The database already exists. It just doesn't know it's a database, because it's been written three times as application code on top of general-purpose substrates that don't understand what it's doing.

---

## 4. What SQL Is Costing

The current `amino-eo` Postgres schema has two tables:

```
eo_events  (seq, target, op, operand JSONB, ts, ...)   — append-only log
eo_state   (target, current_value JSONB, last_seq, ...) — materialized projection
```

This works. It also introduces five categories of friction:

**CON traversal is blind.** Links live inside JSONB operands as `{ added: [...], removed: [...] }`. Following a link chain — formula lookups, cross-table rollups, dependency graphs — requires reading a CON target from `eo_state`, parsing the JSONB, issuing N more reads. A graph store makes this a single traversal query.

**Prefix-range queries simulate a key-value store.** The `getStateByPrefix(prefix)` pattern scans `target BETWEEN 'appX.tblY.' AND 'appX.tblY.\uffff'`. This is a B-tree range scan on a text column. It works, but it's using SQL to do something a key-value store with native prefix iteration does for free.

**JSONB operands are opaque to the query planner.** Efficiently querying "find all records where `fields.fldEmail = X`" requires GIN indexes on every possible path. The data model is schema-on-read; the storage engine expects schema-on-write.

**The projection trigger does ORM work.** `project_event()` manually implements a fold in PL/pgSQL — reading the current state, switching on the operator type, merging the operand, writing the result back. Event-native stores handle this as a first-class concept.

**The graph of relationships is invisible.** CON creates an implicit directed graph between targets. Postgres has no way to reason about it. Every cross-table rollup, lookup, or dependency chain is manual application-level traversal.

---

## 5. What the Nine Operators Actually Require

Strip away the assumption that targets are strings and operands are JSON. The operators are ontological primitives — they describe how things come into being, relate, transform, and dissolve. The current implementation pins them to text paths and JSON values because that's what was available. The operators themselves are type-agnostic.

| Operator | What it means | Beyond text |
|----------|--------------|-------------|
| NUL | Something is encountered and not changed | Observation of a mesh, a signal, an embedding |
| SIG | Attention is directed (ephemeral) | Cursor, gaze, relevance signal in any space |
| INS | Something comes into existence | A mesh, a sound, an embedding, a spatial region |
| SEG | A boundary is drawn | Spatial partition, temporal window, frequency band |
| CON | Two things are related | Image-region → concept, embedding → cluster, neuron → neuron |
| SYN | Two things are the same thing | Dedup across modalities — this photo and that scan are one entity |
| DEF | Something is given a value | A tensor, a waveform, a pixel buffer, a weight matrix |
| EVA | A rule governs | Conflict resolution, physics constraints, inference policies |
| REC | A compound transformation | Update the mesh AND its texture AND its physics body atomically |

The nine operators are not a data format. They are a transformation calculus. An EO-native database is the engine that runs that calculus.

---

## 6. Five Components of the Database

### 6.1 The Target Space Is a Coordinate, Not a String

Current implementation: `appXkR9w.tblClients.rec123.fldEmail` — dot-separated text segments.

Generalized: a target is an address in a directed acyclic graph of namespaces. Each segment can carry type information:

```
Target = Segment[]
Segment = { id: bytes, type?: TypeTag }
```

A text path like `app.table.record.field` is one encoding. But so is:

- `scene.mesh[42].vertex[1803]` — a point in 3D space
- `corpus.document.paragraph[3].embedding` — a vector
- `audio.track.region[00:03.2-00:04.1]` — a temporal span
- `model.layer[12].weight[row,col]` — a tensor coordinate

This is what INS establishes: not a row in a table, but a coordinate in a navigable space. INS mints the address. Everything after INS operates on that address.

**The target path is an address, not the query model.** This distinction is critical. The dot-path hierarchy is a containment structure — `HOSPITAL.WARD.PATIENT.DIAGNOSIS` in IBM's IMS was also a containment path. Codd's entire contribution was freeing queries from the containment structure so you could access data by properties, by relationships, by constraints — not just by walking the tree. A database that only supports hierarchical navigation has fewer degrees of freedom than the relational model, not more.

The EO database does not query by path alone. The target path is one of nine reference strategies for arriving at a target. The other eight are provided by the operators themselves:

- **Absence** (NUL) — find targets where state is absent
- **Distinction** (SIG) — find targets currently under attention
- **Anchor** (INS) — find by content-addressed hash, regardless of where the target sits in the hierarchy
- **Containment** (path) — walk the hierarchy. This is the dot-path. One strategy out of nine
- **Relationship** (CON) — traverse the graph. Cross-table, cross-hierarchy. The graph does not respect the containment path
- **Composition** (SYN) — resolve through aliases. Two targets that merged are one thing addressable by either name
- **State** (DEF) — filter by current value. "All clients where status = active." Constraint-based reference — what Codd introduced
- **Constraint** (EVA) — filter by rule satisfaction. "All targets that currently fail validation"
- **Name** (target string) — direct lookup by full path

The containment path is the address space. SEG, CON, SYN, and DEF-based filtering are the query space. The relational model collapsed all reference into constraint-based queries (the eighth type). The hierarchical model used only containment (the fourth type). The EO database supports all nine — more degrees of freedom than either predecessor, not fewer.

### 6.2 The Operand Is Typed by the Operator, Not the Storage Engine

Current implementation: `operand: JSONB` — the database doesn't know or care what's inside.

EO-native: the operator declares the operand type, and the storage engine understands it.

```
DEF(target) : T          → stores a value of type T at target
CON(target) : Edge[]     → stores directed edges (the engine indexes them)
EVA(target) : Policy     → stores a rule (the engine can enforce it)
SEG(target) : Boundary   → stores a partition (the engine can query across/within)
```

The critical case is DEF. DEF establishes what holds at a target. Sometimes what holds is a static value. Sometimes what holds is a function — a formula, a constraint, a computation. In both cases DEF is doing its job. The operand type is what differs:

- `DEF(field, "hello@email.com")` — the operand is a value. The engine stores it. Done.
- `DEF(field, {formula: "SUM(linked.amount)"})` — the operand is a function. The engine stores the definition AND registers the target as EVA-active. Now the engine has something to evaluate.

This is the ⊢ / ⊨ relationship from model theory playing out concretely. DEF ⊢ derives what follows from the axioms — "this field is defined as the sum of linked amounts." EVA ⊨ tests whether the current state satisfies the formula — runs the computation, produces a result.

The database doesn't need to know every possible type at compile time. It needs a **type registry** — each type declares how it's stored, indexed, and queried. The registry doesn't just say "this is a vector, use HNSW." It says "this is a formula, register it for EVA computation." The operand type is the signal that separates passive storage from active computation. The engine doesn't need a separate mechanism to declare "this field is computed." The DEF operand itself carries that information.

### 6.3 The Projection Is a Fold, Not a Trigger

Current implementation: a PL/pgSQL trigger that does `INSERT ... ON CONFLICT DO UPDATE`.

EO-native: the projection is a per-operator fold function.

```
project : (currentState, event) → newState

project(state, INS(target))         = state.create(target, anchor)
project(state, DEF(target, value))  = state.set(target, merge(state.get(target), value))
                                      + if value is function: classify and register
                                        - all inputs internal → fold-computed
                                        - any input external → Horizon-computed (no stored result)
project(state, CON(target, edges))  = state.addEdges(target, edges)
                                      + state.recomputeFoldDependents(target)
project(state, NUL(target))         = state.remove(target) + state.removeEdges(target)
project(state, SEG(target, bounds)) = state.partition(target, bounds)
project(state, SYN(a, b))          = state.alias(a, b) + state.mergeEdges(a, b)
project(state, EVA(target, rule))   = state.evaluate(target, rule)
project(state, REC(target, ops))    = state.applyFrame(target, ops)   // atomic
```

The engine runs this fold on every append. The operator tells the engine what kind of state mutation to perform — and for fold-computed EVA-active targets, "mutation" includes recomputing formulas and writing results to projected state. For Horizon-computed targets, the fold stores the function definition but never stores a result — the Horizon evaluates it fresh at read time. Both paths run inside the database. The application calls `get(target)` and receives a value either way.

The fold is the integral. Point-in-time reconstruction is: run the fold from the beginning of the log to timestamp T. Retroactive policy application is: run the fold with a different EVA rule. Bug correction is: append a corrective REC; the fold produces the corrected state going forward without rewriting history. The state at any moment is the accumulation of all transformations up to that moment. The Horizon is where the integral currently stands.

### 6.4 The Graph Is Not a Separate Index — It Is the State

Current implementation: CON operands are `{ added: [...], removed: [...] }` inside JSONB. The graph is invisible to the storage engine.

EO-native: every CON event mutates a native adjacency structure. The graph is the primary way the database understands relationships between targets.

```
CON(scene.mesh[42], scene.material[7])
  → the engine knows mesh[42] is connected to material[7]
  → traverse(mesh[42], depth=2) returns materials, textures, shaders
  → no application code needed

CON(patient.rec123.fldCases, case.rec456)
  → same traversal, same cost, same syntax
```

The formula engine's N+1 link traversal disappears. Junction tables, JSONB parsing, and manual fan-out disappear. The graph is just there — maintained by the projection fold every time a CON event arrives.

This is where the calculus shows its hand. The three Structure-triad operators — SEG, CON, SYN — are simultaneously the operators that build structure when they emit and the operators that describe structure when they query. `SEG` as a query is `WHERE`. `CON` as a query is `JOIN`. `SYN` as a query is `GROUP BY`. Three operators. The entire query language. The same calculus that accumulates state also navigates it.

The query interface is not the containment path. The path gets you to a known address — one reference strategy. The query operators give you the rest: SEG filters the key-space by predicate (constraint-based reference, what Codd introduced), CON traverses relationships across the hierarchy (what graph databases provide), and SYN resolves aliases (what deduplication systems provide). A query like "all clients where status = active and linked to a case filed in 2025" uses SEG for the filter, CON for the link traversal, and the path only to identify which key-space prefix to start from. The hierarchy is the starting point, not the prison.

### 6.5 The Changefeed Is Operator-Aware

Current implementation: SSE stream sends raw events. The client figures out what changed.

EO-native: subscribers declare what they care about using the same target/operator vocabulary.

```
subscribe(target="scene.mesh[42].*", op=DEF)
  → notified when any vertex/property of mesh[42] changes

subscribe(target="patient.*", op=CON)
  → notified when any patient gets linked to anything

subscribe(target="*.embedding", op=DEF, where=nearest(query, k=10))
  → notified when the k-nearest embeddings change
```

The database doesn't broadcast everything to everyone. It routes events through the same target-space + operator semantics that govern storage. This is what replaces SSE polling with `since={lastSeq}`.

---

## 7. What This Actually Is

It is not a relational database. Not a document store. Not a graph database. Not a vector store. Not an event store. It is a **database whose storage, projection, query, and subscription are all governed by a single transformation calculus**.

The unit of storage is not a row, a document, or a node. It is a **transformation** — an operator acting on a target, carrying a typed operand, at a point in time, by an agent. The current state of the world is the integral of all transformations. The query interface supports nine reference strategies for arriving at targets — containment paths, graph traversal, constraint-based filtering, anchor lookup, alias resolution, absence detection, attention routing, rule satisfaction, and direct name — all governed by the same operators that write. The write interface is the same nine operators. No gap between the two.

```
┌───────────────────────────────────────────────┐
│            EO DATABASE                        │
│                                               │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐ │
│  │ LOG      │──▶│ PROJECT   │──▶│ STATE    │ │
│  │ append   │   │ per-op    │   │ typed    │ │
│  │ only     │   │ fold      │   │ indexes  │ │
│  └──────────┘   └───────────┘   └──────────┘ │
│       │                              │        │
│       │          ┌───────────┐       │        │
│       │          │ GRAPH     │◀──────┘        │
│       │          │ CON edge  │                │
│       │          │ index     │                │
│       │          └───────────┘                │
│       │                                       │
│       ▼                                       │
│  ┌───────────┐   ┌───────────────────┐        │
│  │ CHANGE    │   │ TYPE REGISTRY     │        │
│  │ FEED      │   │                   │        │
│  │ operator  │   │ vector → HNSW     │        │
│  │ aware     │   │ spatial → R-tree  │        │
│  │ target    │   │ text → B-tree     │        │
│  │ scoped    │   │ blob → CAS        │        │
│  └───────────┘   │ tensor → tiles    │        │
│                  └───────────────────┘        │
└───────────────────────────────────────────────┘
```

---

## 8. Native Operator Treatment: Above the Relational Model

The relational model operates at the level of storage and retrieval. It knows how to put tuples in relations and how to compose relational algebra to get them back. It does not know — and cannot know — what kind of transformation produced the data. INSERT, UPDATE, DELETE are syntactic categories. They describe what happened to the storage, not what happened in the world.

The EO database operates above this. It knows what kind of transformation each event represents, and it treats each operator differently because the engine understands the semantics of transformation, not just the mechanics of writing bytes. This is not a minor optimization. It is the structural reason the database works differently from anything built on the relational model.

Here is what native treatment means for each of the nine operators:

### NUL — The engine does nothing, and knows it

NUL is observation. State in, same state out. The engine's native treatment is to *skip the fold entirely*. No log entry, no state mutation, no disk write. In a high-observation system — one where many reads happen per write — this avoids unnecessary I/O that a generic database would perform. A relational database cannot distinguish a read from a no-op write at the storage level. The EO database can, because the operator says so.

### SIG — The engine holds attention without recording it

SIG is ephemeral — a cursor, not a record. The engine holds SIG in memory as session state: which target has attention right now. It never persists SIG to the log. No disk write, no log entry. But SIG is not inert — the engine uses it to route subscription notifications. A client whose SIG points at `patient.rec123` gets notified when DEF events arrive on that target's subtree. The engine knows SIG means "this client is watching here" and routes accordingly, without recording the watching as a transformation.

### INS — The engine mints an anchor and registers a coordinate

INS is the threshold operator. The engine mints a content-addressed hash (the anchor), registers the target coordinate in the key-space, and marks it as existing. Native treatment gives the engine three things a relational INSERT cannot:

First, existence checks without value scans. The engine can answer "does this target exist?" by checking the coordinate registry, without reading any stored values.

Second, uniqueness enforcement at the identity level. The engine rejects a second INS for the same anchor. This is not a unique constraint on a column — it is an ontological guarantee that the same entity cannot be instantiated twice.

Third, the pre-INS / post-INS distinction. The engine knows that NUL and SIG are ephemeral (below INS in the helix) and everything from INS onward produces enduring log entries. This is a structural property of the operator ordering that the engine enforces, not a convention the application maintains.

### SEG — The engine maintains partition metadata

SEG draws a boundary. The engine's native treatment is to maintain a partition index: which targets fall inside, which fall outside. This means filtered queries can skip entire key-space ranges rather than scanning and filtering. When SEG draws a boundary on a collection, the engine updates the partition metadata, and subsequent `getByPrefix` calls with a SEG predicate use the index rather than iterating all keys.

For spatial or temporal SEG boundaries, the engine maintains the appropriate index structure — interval trees for temporal ranges, R-trees for spatial regions. A relational database would store the boundary definition as a row in a table and require application-level filtering. The EO database makes the boundary an active structural feature of the key-space.

SEG is also the deletion operator in an append-only system. "Deletion" is boundary exclusion — the record is not destroyed, it is partitioned out of the active set. The engine knows that a SEG on an entity means "this entity is now outside the boundary," not "this entity's data should be erased." The log retains everything. The Horizon respects the boundary.

### CON — The engine maintains a native adjacency graph

CON is the most dramatic case. The engine maintains a first-class adjacency index, updated on every CON event. Without native treatment, links are JSONB arrays the application parses and chases manually — O(n × parse). With native treatment, `traverse(target, depth)` is a direct index walk — O(edges).

But CON's native treatment goes beyond graph traversal. The engine uses the CON graph as a **dependency map for EVA computation**. When a DEF arrives on a target, the engine walks the CON graph to find all EVA-active targets that depend on it, then triggers recomputation. This is the formula engine's entire job — currently implemented as application-level fan-out with N+1 reads — collapsed into a native database operation.

CON also enables native treatment of SYN: when two targets merge, the engine merges their adjacency sets, preserving graph connectivity at merge points.

### SYN — The engine maintains alias resolution and merges graphs

SYN produces a derived whole from parts. The engine's native treatment creates a redirect: queries for either constituent resolve to the merged entity. Every read path benefits without application-level alias checking.

The engine also merges the CON edges from both constituents into the merged entity's adjacency. Without this, graph traversal breaks at merge points — you'd walk to the old target and stop, unaware that it merged into something else. The engine handles the merge atomically: alias creation, edge merging, and dependent EVA recomputation all happen in one operation.

For decomposition (the inverse of SYN), the engine splits the merged entity's state, partitions the edges, and removes the alias. The decomposed targets become independently addressable again.

### DEF — The engine stores values or registers computations

DEF is the workhorse. Its native treatment depends on the operand type, which is where the type registry earns its keep:

**Value operand.** `DEF(target, "hello@email.com")` — the engine stores the value at the target using the storage backend appropriate to the type. Text → B-tree key. Vector → HNSW index. Blob → content-addressed store. The type registry dispatches. This is the closest DEF gets to a conventional key-value write, and the native benefit is modest — mainly type-aware storage rather than opaque JSONB.

**Function operand.** `DEF(target, {formula: "SUM(linked.amount)"})` — the engine stores the definition AND registers the target as EVA-active. This is a fundamentally different operation from storing a value. The engine now knows: this target depends on other targets (via CON), it has a computation to run (the formula), and it needs to be recomputed when its dependencies change. No separate mechanism declares "this field is computed." The DEF operand itself carries that information.

**Conflict operand.** When two DEFs arrive on the same path from different sources, the engine does not silently overwrite. It stores both values with their provenance, creating a conflict state. The conflict is data — auditable, queryable, resolvable later by EVA. A relational database's UPDATE silently destroys the previous value. DEF preserves it.

### EVA — The engine computes, it does not just store

EVA is ⊨ — satisfaction. This is where the EO database stops being a passive store and becomes an active compute layer. EVA's native treatment means the engine *runs operations*.

The engine classifies EVA-active targets into two types, determined automatically at DEF time by inspecting the function operand's input references:

**Fold-computed.** All inputs resolve to targets in the key-space. The engine recomputes the formula inside the fold whenever an upstream dependency changes, and stores the result in projected state. Reads are key lookups. No computation at read time.

When a DEF arrives on an upstream target, the engine walks the CON graph, finds all fold-computed EVA-active targets that depend on it, recomputes each formula, and writes the results to state. If any of those results are themselves upstream of other formulas, the engine continues walking. By the time the fold returns, every affected formula has its current value sitting in projected state. The formula recomputations do not write events to the log — they write results to projected state only. The log records what came from outside. The projected state records consequences. One upstream DEF that affects 50 formulas produces one log entry and 50 state updates.

The engine is reactive, not polling. 500,000 formula cells with no upstream changes are 500,000 pre-computed values sitting on disk costing nothing. A write triggers recomputation only in the connected subgraph of the dependency graph — not a scan of all formulas.

**Horizon-computed.** Any input references something outside the key-space — current time, a live API, a sensor value. The engine does not store a result in projected state. The result materializes at read time when the Horizon evaluates the function fresh, and evaporates afterward. The application calls `get(target)` and receives a computed value; it does not know or care whether the value was pre-computed by the fold or computed just now by the Horizon.

`DEF(field, {formula: "DAYS_UNTIL(hearing_date)"})` — `hearing_date` is a target in the log, but the computation requires current time. Current time is not a target. The engine detects this at DEF time, classifies the target as Horizon-computed, and never stores a result. Every read evaluates it fresh. This avoids the alternative — emitting a clock-tick DEF every minute and recomputing every time-dependent formula in the database, flooding the log with synthetic events.

The classification is a static analysis performed once at DEF time, not a runtime decision. The engine parses the formula, resolves the references, stores the classification alongside the function definition. If the formula is later redefined (a new DEF replaces the function operand), the engine re-inspects and reclassifies.

**Logged evaluations are an application pattern, not a third engine type.** Sometimes an evaluation is not just a derived value to keep current — it is a judgment that should be recorded as a historical fact. "This case was flagged high-risk on March 15th" is not the same as "this case currently meets the high-risk criteria." The first is a determination that happened; the second is a live readout.

The engine does not distinguish these. Both are fold-computed. The application makes the distinction by DEFing a policy on the evaluation: `DEF(field.policy, {log_results: true})`. The application reads the fold-computed result, reads the policy, and emits a DEF to the log recording the determination with provenance when the result changes. The engine computes. The application decides what's worth remembering. This keeps the engine at two structurally distinguishable types and puts domain knowledge where it belongs — in the application, not the calculus.

Beyond formulas, EVA's native treatment handles:

**Constraints.** "This field must be an email address" is an EVA that runs on every DEF to that target. The engine validates the incoming value against the constraint before accepting it into state. Rejection happens at the storage level, not the application level.

**Conflict resolution.** When multiple DEFs exist on the same path, EVA determines what the Horizon shows. The engine looks up the EVA rule (latest, priority, manual, formula) and applies it at read time.

The chain is always: CON tells the engine the dependency graph. DEF tells the engine what the computation is. EVA is the engine's act of running it. Three operators, three roles, one pipeline — and the pipeline runs inside the database, not in application code on top of it.

### REC — The engine guarantees atomicity across frame changes

REC wraps multiple sub-operations that must all land or none land. A schema migration that renames a field, updates all affected records, and revises the EVA rules is a single REC event containing nested DEF, EVA, and SEG operations.

The engine's native treatment guarantees:

**Atomicity.** All sub-operations apply or none do. This is not application-level transaction management — it is the fold recognizing REC as a frame boundary and treating its contents as an indivisible unit.

**Replay safety.** The nested structure makes the dependency relationship explicit. Replaying the REC replays all its sub-operations atomically. Partial replay of a REC's contents is safe because dependencies are contained within the structure, not implicit in the sequence.

**Frame separation.** REC creates a structural boundary between before and after. The engine can answer "what was the state under the old frame?" and "what is the state under the new frame?" as distinct queries. The log before the REC is queryable under the original frame; the log after is queryable under the corrected frame. A relational database's schema migration destroys the old frame. REC preserves both.

### The level above

What these nine native treatments have in common is that they operate above the relational model. A relational database sees tuples going into relations and tuples coming out. It does not know that one INSERT is minting an identity anchor, another is storing a formula definition, another is establishing a graph edge, and another is drawing a partition boundary. It treats them all as "put tuple in relation."

The EO database sees transformations. Each transformation has a type (the operator), a target (the coordinate), and a typed operand (the payload). The type determines the engine's behavior: skip the fold (NUL), hold in memory (SIG), mint an anchor (INS), update partition metadata (SEG), update the adjacency graph (CON), create an alias (SYN), store a value or register a computation (DEF), run a computation (EVA), apply atomically (REC).

Nine behaviors. Nine code paths. Each structurally different. This is not a feature of the query language bolted on top of a storage engine. It is the storage engine itself understanding what is happening, because the transformation calculus tells it.

---

## 9. The Closed Instruction Set

The reason this architecture collapses what conventional event sourcing splits into four systems (event store, projection engine, query index, audit log) is that the vocabulary is small enough that storage, classification, and execution are the same act.

A conventional event sourcing system has an open-ended vocabulary: `CustomerCreated`, `CustomerRelocated`, `InvoiceVoided`, `SchemaV3Migration`. Every new event type is a new instruction the consumer must learn to handle. A consumer encountering an event type it has never seen either crashes or silently drops it.

With nine operators, the instruction set never grows. A consumer built today will correctly execute every event emitted by every service built ten years from now, because those future services still emit the same nine functions. The domain-specific meaning — which customer, which email address — lives in the arguments. The transformation type — what kind of change — lives in the function name, and there are only nine of those, permanently.

The entire event processor is:

```
for event in log:
    event.op(event.target, event.operand)
```

Read a line. Call the function. Move to the next line. That is `eval` on a closed instruction set.

In practice, compositions stay shallow — most real transformations are depth 1 or 2, occasionally 3. The nesting is bounded not by a formal limit but by the dependency ordering between triads: you don't need existence operators inside significance operators, and the combinations that occur in practice are a small, predictable subset of the combinatorial space.

---

## 10. The Mathematics: Category Theory

The transformation calculus has a natural formalization, and it is categorical.

**Operators are morphisms** — arrows between states. Not functions on data. Arrows that compose, with an identity (NUL). The helix ordering is a partial order on those morphisms. The nine operators form a small category whose objects are states and whose arrows are the transformations between them.

**The fold is a catamorphism** — the canonical recursion scheme from category theory. A catamorphism tears down a structure (the log) into a single value (the current state) by replacing each constructor with an operation. That is exactly what the projection does: replace each event in the log with its operator-specific state mutation, accumulate. The catamorphism is the most optimizable recursion pattern in computer science. Compilers know how to fuse it, inline it, eliminate intermediate allocations.

**The type registry is functorial** — a structure-preserving mapping between categories. The operator says DEF; the functor maps that to the appropriate storage behavior depending on the type. Vector → HNSW insertion. Text → B-tree insertion. Spatial → R-tree insertion. Same morphism (DEF), different target category. That is a functor.

**The Horizon is a natural transformation** — a structure-preserving map between two functors. The Given-Log functor produces raw accumulated state. The Horizon functor produces projected state shaped by EVA rules and SEG/CON/SYN lenses. The natural transformation guarantees: for every target, the square commutes. Change the log then project, or project then apply the change — same result. This is what makes replay deterministic.

**The three axes are a product category** — Mode × Domain × Object. The 27-cell capacity ground is the product. The faces (Act, Site, Resolution) are projection functors from the product to a two-axis subcategory.

**The "limit" in "truth as limit" is a colimit** — a categorical construction, not an epsilon-delta argument. The Given-Log is a directed diagram; the current state is its colimit; defeasibility is the theorem that the diagram is never complete.

The relevant prior work is David Spivak's formalization of databases as functors from a schema category to Set. The EO database is a functor from the operator category to a state category, with the fold as the catamorphism and the type registry as a family of functors indexed by type. The categorical structure does not add runtime overhead. It is the design language, not the execution language. The fold is a for loop. The functor dispatch is a switch statement. The natural transformation is "apply the EVA rule after accumulating." Category theory tells you the design is correct — that the square commutes, that the fold produces the same result regardless of chunking, that the type dispatch preserves structure. It does not add instructions.

---

## 11. Performance

The native operator treatment described in §8 produces concrete performance differences.

**Where it is faster than the current setup:**

CON traversal drops from O(n × parse) to O(edges). This is detailed in §8 under CON — the adjacency index replaces N+1 JSONB reads with a single graph walk. For the formula engine in `amino-eo`, this is the primary bottleneck.

EVA computation moves from application-level fan-out to engine-level pipeline. Currently the formula engine reads CON links from JSONB, parses them, issues N reads for each linked record, computes the formula, and writes the result back — all as application code. Natively, the engine handles the entire chain: walk the CON graph, retrieve the DEF-stored function, evaluate, write. The application emits one DEF; the engine handles all downstream recomputation. For fold-computed targets, results are pre-computed and reads are key lookups. For Horizon-computed targets (those depending on external inputs like time), the computation happens at read time but still inside the database — the application calls `get(target)` either way.

Prefix scans on LevelDB are cheaper than `BETWEEN` range scans on a Postgres B-tree index over text. LevelDB's sorted key structure means prefix iteration is a seek + sequential read. No query planner, no SQL parsing, no transaction isolation overhead for reads that don't need it.

The network round-trip disappears. Postgres runs as a separate process; every read and write is a network call (even on localhost). An embedded database is a function call.

**Where it is inherently efficient:**

Nine operators means nine code paths in the fold. Not nine hundred. The branch prediction is nearly perfect. The dispatch table fits in cache. The entire projection engine — all nine cases — is small enough that the hot path stays in L1.

The catamorphism (fold) is the most optimizable recursion pattern in computer science. Compilers know how to fuse it, inline it, eliminate intermediate allocations. A fold over a log with nine cases is about as friendly to hardware as computation gets.

The engine avoids unnecessary work by operator type. NUL and SIG skip the fold entirely — no disk I/O for observation or attention. INS checks the coordinate registry rather than scanning values. SEG uses partition metadata rather than iterating keys. Each operator's native treatment is also a native optimization.

**Where it is slower than a purpose-built relational database doing relational things:**

Complex analytical queries. Postgres has forty years of query planner optimization for aggregation, windowing, and set operations. If analytical workloads arise, the right answer is to project from the EO database into an analytical consumer (Postgres, DuckDB) as a downstream read-only view. The EO database is upstream. The analytical engine is downstream.

Concurrent writes under contention. LevelDB has a single-writer model. For `amino-eo` this is irrelevant — the write path goes through n8n, which serializes events anyway.

---

## 12. Nearest Relatives

No existing system implements this design. The closest relatives each capture a piece:

**Datomic** — Immutable facts with time. Closest to the append-only log semantics and the replay-to-state derivation. But Datomic has no operator calculus, no graph-native traversal, no multi-modal type registry. Its schema is attribute-based, not operator-typed. The accretion model is right; the vocabulary is open.

**TerminusDB** — Immutable graph with diffs. Closest to EO's commitment to preserving history as a graph structure. But no operator typing, no vector/spatial support, no transformation calculus. It tracks what changed, not what kind of change occurred.

**FoundationDB** — Ordered key-value store with layers. A possible substrate. FoundationDB's layer architecture means EO semantics could be implemented as a layer: the key space maps to targets, the value space maps to operands, and the projection fold runs as a layer-level operation.

**SurrealDB** — Multi-model (document + graph + key-value + live queries + changefeeds). The closest to handling EO's multi-paradigm needs in a single engine. Record links are graph edges (CON becomes native). Documents are native (DEF operands store and query without GIN index gymnastics). Namespaced IDs map to target paths. Live queries replace SSE polling. But still young — not battle-tested at scale.

**ArangoDB** — Mature multi-model with document, graph, and key-value access via AQL. Proven in production. Less native support for changefeeds and event semantics than SurrealDB, but more operationally trustworthy.

The reason none of these is "the thing" is that they all start from a storage model and work up. EO starts from a transformation calculus and works down. The operators are the specification; the storage is derived.

---

## 13. The Multi-Modal Horizon

The most radical implication of typing operands by operator rather than by storage engine is that the same nine operators work across modalities without modification.

A target like `scene.mesh[42].vertex[1803]` is addressed the same way as `patient.rec123.fldEmail`. The key-space is navigable in the same way. INS mints the address. DEF sets the value. CON establishes relationships. SEG draws boundaries. The operators don't care whether the value at the target is a string, a vector, a waveform, a tensor, or a pixel buffer.

What changes across modalities is the type registry — how each type is stored, indexed, and queried. A vector operand goes into an HNSW index. A spatial operand goes into an R-tree. A text operand goes into a B-tree. A blob goes into content-addressed storage. The operator selects the behavior; the type registry provides the implementation.

This means an EO-native database could, in principle, handle:

- A 3D scene graph where meshes, materials, textures, and lights are all targets, CON relationships are rendering dependencies, and DEF events carry vertex buffers
- An audio workstation where tracks, regions, and effects are targets, CON relationships are signal chains, and DEF events carry waveform data
- A neural network where layers, neurons, and weights are targets, CON relationships are forward/backward connections, and DEF events carry tensor values
- A medical record system where patients, encounters, and observations are targets, CON relationships are clinical linkages, and DEF events carry structured clinical data

All using the same nine operators, the same fold, the same query interface. The modality is in the type registry, not the calculus.

This is the domain-invariance claim applied to storage: the same transformation calculus that describes how a crystal grows, how a language evolves, and how a database mutates can also describe how data is stored, indexed, and queried.

---

## 14. Practical Path

The EO database replaces Postgres for `amino-eo`. The source of truth is Airtable. The Postgres tables are already a downstream projection — events arrive via n8n, get appended to `eo_events`, get projected into `eo_state` by a trigger. The EO database takes over both tables. n8n writes to the EO database instead. Same flow, one system instead of two. Postgres goes away.

The specification is already written in application code. The path is extraction and unification.

**Phase 1: Extract and unify.** Take the Zustand store (`eo-store.ts`), the IndexedDB layer, and the Postgres projection trigger. Unify them into a single embedded database over `classic-level` (LevelDB bindings). One interface: `append(event) → void`, `get(target) → State`, `getByPrefix(prefix) → State[]`, `traverse(target, depth) → Graph`. This is under 1,000 lines of actual logic, stripped of the SQL and IndexedDB ceremony. The result is an embedded database in the way SQLite is an embedded database — a library linked into the application, no server process.

**Phase 2: Add the native graph index.** When the projection fold sees a CON event, it updates an adjacency structure alongside the key-value state. This eliminates the N+1 link traversal pattern. The formula engine calls `traverse()` instead of manually parsing JSONB arrays and issuing sequential reads.

**Phase 3: Add the operator-aware changefeed.** Replace SSE polling with subscriptions that declare target patterns and operator types. The engine routes events to subscribers based on the same semantics that govern storage.

**Phase 4: Add the type registry.** Make operand types pluggable. Register handlers for vector, spatial, temporal, blob, and tensor types. Each handler declares its storage backend (HNSW, R-tree, interval tree, CAS, tiled storage) and its query interface. The fold dispatches to the appropriate handler based on the operator and the registered type.

**What blocks this today:** not the code. The blocker is real Airtable fixture data to test against. The database is only as trustworthy as the test coverage, and the test coverage depends on capturing the actual data shapes coming through n8n. This is the same blocker that stalls amino-eo Stage 3 (EO Classifier).

---

## 15. Identity Layer: Matrix

Every EO event has an agent field. The log records not just what changed but who changed it. Matrix provides the identity infrastructure that makes the agent field a verified fact rather than a string the application fills in.

**Provenance is structural, not bolted on.** In Postgres, a `created_by` column is populated by application-level session middleware. If the middleware has a bug, the column is wrong. If a migration script runs without a session, the column is null. In the EO database with Matrix auth, the agent is a Matrix user ID (`@caseworker:homeserver.example`), verified by the authentication layer before the event reaches the fold. No event enters the log without a verified agent. Provenance is infrastructure, not convention.

**Access control maps to the key-space.** Matrix's power-level model maps to operator + target-prefix permissions. An agent can DEF targets under `app.tblClients.*` but cannot DEF targets under `app.tblBilling.*`. An agent can read (NUL) anything but can only write (DEF, CON, SEG) within their assigned scope. The permissions are evaluated at the API boundary before the fold sees the event.

**Session state is SIG.** When a user opens a record, their client emits a SIG — held in memory, not logged. The engine knows which users are looking at which targets. This enables collaboration awareness ("another user is viewing this record"), targeted subscription routing (push updates only to users whose SIG points at affected targets), and conflict prevention ("another user is editing this field right now").

**E2EE for sensitive operands.** For an immigration law firm, some field values are sensitive — SSNs, case notes, medical records. The DEF operand for those targets can be encrypted with Matrix's end-to-end encryption. The log stores the encrypted operand. The fold stores the encrypted value in projected state. Decryption happens at the client, inside the user's Matrix session. The server never sees the plaintext. The fold does not need to read the operand to store it — it needs the target and operator.

**Federation is multi-firm collaboration.** If the firm works with partner organizations — co-counsel, referring agencies, court liaisons — Matrix federation lets them share specific targets across homeservers without sharing the full database. Partner agents can DEF within their authorized scope, and the events arrive at the EO database with verified external agent identities. Cross-organization data sharing with per-agent provenance and per-target access control, without building a custom inter-organizational auth system.

**What Matrix replaces:** custom user management, password storage, session token implementation, role management tables, API key systems. The EO database trusts the Matrix homeserver for identity verification and delegates authorization to operator + target-prefix permissions at the API boundary.

---

## 16. Deployment Architecture

The EO database runs as a Node server on a VM with three jobs: store EO events, serve projected state, and provide a visual admin interface. It replaces both Postgres and the need for a separate admin tool.

```
Airtable → n8n → EO database app (VM) → WebSocket → amino-eo (browser)
                       ↑
                  admin interface (browser)
```

**Inbound.** n8n sends Airtable changes as EO events via webhook. The app authenticates the webhook (Matrix token or shared secret), appends to the log, runs the fold (updates projected state, CON graph, EVA-active formulas), and notifies connected clients via the changefeed.

**Outbound.** amino-eo connects via WebSocket, sends its last known sequence number. The app streams all events since that sequence, then pushes new events as they arrive. amino-eo runs its own fold client-side for local state — the Zustand store stays, the only change is the event source (WebSocket instead of SSE from the Postgres stack).

**Admin interface.** A browser-based visual interface served by the same server. Matrix login. Not a tree browser as the primary view — the primary view is the Horizon: projected state navigable by any combination of the nine reference strategies. SEG filters by predicate. CON traverses the graph. Direct path lookup for known targets. The hierarchy is one navigation mode, not the only one.

The interface provides: a query view for filtering the key-space by value, operator type, agent, or time range; a graph view for CON relationships and formula dependency chains; a formula editor where the engine classifies fold-computed vs Horizon-computed automatically; an EVA policy panel for conflict resolution strategy per target or prefix; a log view showing the chronological event stream with operator-coded entries; a replay tool for scrubbing to any point and seeing projected state at that timestamp; and webhook configuration for outbound notifications triggered by operator/target patterns.

**The server codebase:**

```
eo-db/
  server.ts          — Express/Fastify, WebSocket, Matrix auth middleware
  db/
    log.ts           — append-only event log over LevelDB (keyspace: log/)
    state.ts         — projected state over LevelDB (keyspace: state/)
    graph.ts         — CON adjacency index over LevelDB (keyspace: graph/)
    fold.ts          — the nine-case fold, EVA computation, dependency walk
    horizon.ts       — read-time evaluation for Horizon-computed targets
    feed.ts          — changefeed: operator-aware subscription routing
  api/
    webhook.ts       — inbound: n8n posts EO events here
    sync.ts          — outbound: WebSocket sync for amino-eo clients
    query.ts         — get, getByPrefix, traverse, log
    admin.ts         — serves the admin interface
  admin/
    index.html       — the visual interface (React app)
```

Approximately 3,000–5,000 lines of TypeScript for the server. The fold is under 500 lines — nine cases. The log, state, and graph modules are thin wrappers over LevelDB. The admin interface is the largest piece by lines of code but the most straightforward — a React app rendering data from the API.

**How amino-eo connects.** Remove all Postgres code. No more `eo_events` table, no more `eo_state` table, no more `project_event()` trigger. Replace the SSE endpoint with a WebSocket connection to the EO database app. The Zustand store stays — it already runs the fold client-side. IndexedDB stays for offline support. The n8n EO classifier (Stage 3) still does its job but posts to the EO database app's webhook endpoint instead of writing to Postgres.

---

## 17. What This Does Not Replace

The EO database does not replace Kafka, Debezium, CloudEvents, or any existing event infrastructure. Those systems handle transport, capture, envelope, and delivery. The EO database provides the execution semantics — the closed nine-word vocabulary that goes inside the envelope.

It does not replace application-level business logic. The operators classify what kind of transformation occurred. The business logic determines when and why to emit each operator. The database knows that DEF means "set a value." The application knows that the value should be set because the patient's lab results came back.

If analytical workloads arise — complex aggregations, window functions, pivoting across large datasets — the right answer is to project from the EO database into an analytical engine (Postgres, DuckDB) as a downstream read-only consumer. The EO database is upstream. The analytical engine is downstream. Not peers.

---

## 18. The Central Bet

The claim is that nine operators are sufficient and necessary to classify any data transformation. Every `CustomerUpdated` event is one of these nine types, or a composition of them. The question is whether the classification should be explicit, portable, and auditable — or implicit, application-specific, and lost the moment the schema changes.

An EO-native database is what happens when you take that claim seriously enough to build the storage engine around it. The transformation calculus is not a layer on top of storage. It is the storage.

The existing database ecosystem starts from "how do we hold data?" and works toward "what can we express?" EO starts from "what transformations are possible?" and works toward "how do we hold them?" The inversion is the contribution. Whether it survives contact with production workloads is the open question.

The specification exists. It's written in three redundant implementations across a Zustand store, an IndexedDB adapter, and a PL/pgSQL trigger. What doesn't exist yet is the one database that runs it natively.

---

*See also: [The Nine Operators], [Storage Architectures], [EO Event Streaming], [Replay Architecture], [The Experience Engine]*
