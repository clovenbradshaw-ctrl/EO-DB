# PATCH: Three-Layer Horizon — Figure, Ground, Signal

This patch modifies EO///DB to support three Object-axis positions natively in the Horizon read path. No changes to the log, the fold, or the nine operators. All changes are in how the Horizon reads and presents existing data.

Apply these modifications to `eo-db-technical-spec.md` and `build-eo-db-prompt.md`.

---

## 1. Concept

The database stores figures — discrete entities at specific targets with specific values. That doesn't change. What changes is what the Horizon returns when you read.

Currently the Horizon returns: the projected state at the target, with alias resolution and Horizon-computed evaluation.

After this patch, the Horizon returns three layers:

- **Figure** — what the target IS. The projected state at the target. Same as before.
- **Ground** — what the target is IN. Ambient conditions inherited from ancestor prefixes. Already in the log as DEFs at higher-level targets. The Horizon walks up the prefix hierarchy and collects them.
- **Signal** — what the target is PART OF. Emergent patterns detected across populations of figures. Computed on demand. Ephemeral. Never stored unless the user explicitly INS's them.

No new operators. No new fold cases. No new keyspaces. The log records the same events. The fold projects the same state. The Horizon just reads deeper.

---

## 2. Changes to Types (§3 of spec)

Add to `src/db/types.ts`:

```typescript
// Three-layer Horizon response
interface HorizonResponse {
  target: string;
  figure: EoState | null;                    // projected state at this target
  grounds: GroundEntry[];                    // ambient conditions from ancestor prefixes
  signals?: SignalEntry[];                   // emergent patterns (only when requested)
}

// A ground condition inherited from an ancestor prefix
interface GroundEntry {
  source: string;                            // the ancestor target where the DEF lives
  key: string;                               // the field/property name
  value: any;                                // the ambient value
  distance: number;                          // how many prefix levels up (1 = parent, 2 = grandparent)
}

// An ephemeral signal detected by population analysis
interface SignalEntry {
  description: string;                       // human-readable pattern description
  measure: string;                           // what was measured
  value: any;                                // the computed statistic
  population: string;                        // the prefix that was analyzed
  predicate?: Record<string, any>;           // the SEG filter applied
  n: number;                                 // population size
  computed_at: string;                       // ISO timestamp of computation
}

// Pattern definition — when a signal is INS'd into a tracked entity
interface PatternDef {
  formula: string;                           // aggregation formula (MEAN, COUNT, etc.)
  over: string;                              // key-space prefix to scan
  where?: Record<string, any>;              // SEG predicate for population membership
}
```

---

## 3. Changes to Horizon (§7 of spec)

Replace the current `horizonGet` function with a three-layer version:

```typescript
// src/db/horizon.ts

/**
 * Three-layer Horizon read.
 *
 * Layer 1 — Figure: projected state at the target. Alias resolution. Horizon-computed EVA.
 * Layer 2 — Ground: walk up prefix hierarchy collecting ancestor-level state.
 * Layer 3 — Signal: on-demand population analytics (only when opts.signals === true).
 */
async function horizonGet(
  db: Level,
  target: string,
  opts?: { signals?: boolean }
): Promise<HorizonResponse> {

  // Layer 1: Figure
  const figure = await getFigureState(db, target);

  // Layer 2: Grounds
  const grounds = await getGrounds(db, target);

  // Layer 3: Signals (only when requested — expensive)
  let signals: SignalEntry[] | undefined;
  if (opts?.signals) {
    signals = await detectSignals(db, target);
  }

  return { target, figure, grounds, signals };
}

/**
 * Layer 1: Get figure state with alias resolution and Horizon-computed EVA.
 * This is the existing horizonGet logic, renamed.
 */
async function getFigureState(db: Level, target: string): Promise<EoState | null> {
  const state = await getState(db, target);
  if (!state) return null;

  // Alias resolution
  if (state.value?._alias) {
    return getFigureState(db, state.value._alias);
  }

  // Horizon-computed EVA
  let evaReg: EvaRegistration | null = null;
  try {
    evaReg = await db.get(`eva:${target}`);
  } catch (e) { /* not EVA-active */ }

  if (evaReg && evaReg.mode === 'horizon') {
    const inputs: Record<string, any> = {};
    for (const dep of evaReg.dependencies) {
      const depState = await getState(db, dep);
      inputs[dep] = depState?.value;
    }
    inputs['_now'] = new Date().toISOString();
    inputs['_today'] = new Date().toISOString().split('T')[0];
    const result = executeFormulaFunction(evaReg.formula, inputs);
    return { ...state, value: { ...state.value, _computed: result } };
  }

  return state;
}

/**
 * Layer 2: Walk up the prefix hierarchy collecting ambient conditions.
 *
 * For target "app.tblClients.rec001.fldEmail", check:
 *   - state entries at "app.tblClients.rec001" that are NOT record-field targets
 *     (i.e., collection-level properties that pervade the record)
 *   - state entries at "app.tblClients" (collection-level grounds)
 *   - state entries at "app" (application-level grounds)
 *
 * A ground is any DEF at an ancestor prefix that is not itself a record-level entity.
 * The heuristic: targets with exactly the collection prefix (no record segment) are grounds.
 *
 * Override rule: if the figure has an explicit value for a field that also exists
 * as a ground, the figure's value wins (CSS cascade).
 */
async function getGrounds(db: Level, target: string): Promise<GroundEntry[]> {
  const parts = target.split('.');
  const grounds: GroundEntry[] = [];
  const figureKeys = new Set<string>();

  // Collect the figure's own keys to detect overrides
  const figureState = await getState(db, target);
  if (figureState?.value && typeof figureState.value === 'object') {
    Object.keys(figureState.value).forEach(k => figureKeys.add(k));
  }

  // Walk up the hierarchy, skipping the target itself
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const ancestor = parts.slice(0, depth).join('.');
    const distance = parts.length - depth;

    // Scan for state entries at this ancestor level that look like ambient properties
    // (not record-level entities — those have deeper paths)
    const ancestorState = await getState(db, ancestor);
    if (ancestorState?.value && typeof ancestorState.value === 'object') {
      for (const [key, value] of Object.entries(ancestorState.value)) {
        // Skip if the figure overrides this key
        if (!figureKeys.has(key)) {
          grounds.push({ source: ancestor, key, value, distance });
        }
      }
    }

    // Also check for sibling-level ground targets (e.g., app.tblClients.defaultRegion)
    const siblingPrefix = ancestor + '.';
    const siblings = await getStateByPrefix(db, siblingPrefix);
    for (const sib of siblings) {
      // Only include targets that are at the ancestor level + 1 segment
      // and are NOT record-level entities (heuristic: no further segments)
      const sibParts = sib.target.split('.');
      if (sibParts.length === depth + 1) {
        const key = sibParts[sibParts.length - 1];
        // Skip record-like targets (those starting with 'rec')
        // This is a heuristic — refine based on actual naming conventions
        if (!key.startsWith('rec') && !key.startsWith('fld') && !figureKeys.has(key)) {
          grounds.push({
            source: sib.target,
            key,
            value: sib.value,
            distance
          });
        }
      }
    }
  }

  return grounds;
}

/**
 * Layer 3: Detect emergent patterns in the population around a target.
 *
 * This is the expensive, on-demand operation. Only runs when ?signals=true.
 * It is a SIG-level operation — ephemeral, never stored, computed on observation.
 *
 * Strategy: look at the collection the target belongs to, compute basic
 * population statistics, and surface anything that deviates significantly
 * from the population mean for this target's values.
 *
 * This is a placeholder implementation. A real signal detector would:
 * - Support configurable analysis types (temporal patterns, outlier detection, clustering)
 * - Cache results briefly to avoid recomputation on rapid reads
 * - Accept analysis parameters from the query
 */
async function detectSignals(db: Level, target: string): Promise<SignalEntry[]> {
  const signals: SignalEntry[] = [];
  const parts = target.split('.');

  // Determine the collection prefix (first 2 segments for app.table pattern)
  if (parts.length < 3) return signals;
  const collectionPrefix = parts.slice(0, 2).join('.');

  // Get all state entries in this collection
  const population = await getStateByPrefix(db, collectionPrefix + '.');

  // Filter to record-level entries only (3 segments: app.table.recXXX)
  const records = population.filter(s => s.target.split('.').length === 3);

  if (records.length < 3) return signals; // need at least 3 for meaningful stats

  // Compute basic statistics over numeric fields
  // Gather all field values across the population
  const fieldValues: Record<string, number[]> = {};
  const fieldPopulation = await getStateByPrefix(db, collectionPrefix + '.');
  for (const entry of fieldPopulation) {
    const entryParts = entry.target.split('.');
    // Field-level entries (4 segments: app.table.rec.fld)
    if (entryParts.length === 4 && typeof entry.value === 'number') {
      const field = entryParts[3];
      if (!fieldValues[field]) fieldValues[field] = [];
      fieldValues[field].push(entry.value);
    }
  }

  // Surface any field where this target's value deviates significantly
  for (const [field, values] of Object.entries(fieldValues)) {
    if (values.length < 3) continue;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    if (std === 0) continue;

    // Check if the current target has this field
    const targetFieldState = await getState(db, `${target}.${field}`);
    if (targetFieldState && typeof targetFieldState.value === 'number') {
      const z = (targetFieldState.value - mean) / std;
      if (Math.abs(z) > 1.5) {
        signals.push({
          description: `${field} is ${z > 0 ? 'above' : 'below'} population average (z=${z.toFixed(2)})`,
          measure: field,
          value: { target_value: targetFieldState.value, population_mean: mean, z_score: z },
          population: collectionPrefix,
          n: values.length,
          computed_at: new Date().toISOString()
        });
      }
    }
  }

  // Surface population-level patterns (not target-specific)
  signals.push({
    description: `Population: ${records.length} records in ${collectionPrefix}`,
    measure: 'count',
    value: records.length,
    population: collectionPrefix,
    n: records.length,
    computed_at: new Date().toISOString()
  });

  return signals;
}
```

---

## 4. Changes to API (§9.3 of spec)

Modify the GET /horizon/:target endpoint:

```
GET /horizon/:target
  Query params:
    prefix=true    → return all state under prefix (existing)
    signals=true   → include Layer 3 signal detection (new, expensive)
    grounds=false  → exclude Layer 2 ground inheritance (new, default: true)

  Response (single target):
  {
    "target": "app.tblClients.rec001",
    "figure": {
      "target": "app.tblClients.rec001",
      "value": { "name": "Maria Garcia", "status": "active" },
      "last_seq": 4201,
      "last_op": "INS",
      "last_agent": "@intake:amino",
      "last_ts": "2025-03-27T09:12:00Z"
    },
    "grounds": [
      { "source": "app.tblClients", "key": "regulatoryHold", "value": true, "distance": 1 },
      { "source": "app.timezone", "key": "timezone", "value": "America/Chicago", "distance": 2 }
    ],
    "signals": [
      {
        "description": "resolution_days is above population average (z=2.14)",
        "measure": "resolution_days",
        "value": { "target_value": 45, "population_mean": 28, "z_score": 2.14 },
        "population": "app.tblCases",
        "n": 47,
        "computed_at": "2025-03-27T17:00:00Z"
      }
    ]
  }
```

When `prefix=true`, each entry in the array gets its own three-layer response. Grounds and signals are per-target, not per-batch. When `grounds=false`, the grounds array is omitted (for performance on bulk reads where the client already knows the ambient context).

---

## 5. Changes to Pattern INS (fold behavior)

When a user decides to track a detected signal, they INS it and DEF it with a population formula:

```
POST /ops/ins  { target: "pattern.q3_delay" }
POST /ops/def  { target: "pattern.q3_delay", operand: {
  formula: "MEAN(resolution_days)",
  over: "app.tblCases",
  where: { filed_quarter: "Q3" },
  pattern: true
}}
```

Add to the DEF handler in fold.ts — when the operand has `pattern: true`, the engine:

1. Evaluates the SEG predicate (`where`) against the population prefix (`over`)
2. Finds all matching targets
3. Creates auto-CON edges from each matching target to the pattern target
4. Registers the pattern target as EVA-active (fold-computed)
5. Computes the initial formula result
6. On subsequent INS events under the `over` prefix, checks if the new target matches the predicate and adds/removes CON edges accordingly
7. On DEF events that change fields referenced by the predicate, re-evaluates membership

Add to `src/db/types.ts`:

```typescript
// Population-tracked pattern in the eva: keyspace
interface PatternRegistration extends EvaRegistration {
  pattern: true;
  over: string;                              // key-space prefix to scan
  where?: Record<string, any>;              // SEG predicate for population membership
  population_targets: string[];             // current set of matching targets
}
```

Add to fold.ts executeOperator:

```typescript
// In the DEF handler, after the formula registration block:
if (isPatternOperand(event.operand)) {
  await registerPattern(db, event.target, event.operand);
}

function isPatternOperand(operand: any): boolean {
  return operand && typeof operand === 'object' && operand.pattern === true && 'over' in operand;
}

async function registerPattern(db: Level, target: string, operand: any): Promise<void> {
  const { formula, over, where } = operand;

  // Find all targets matching the predicate under the prefix
  const population = await getStateByPrefix(db, over + '.');
  const matching: string[] = [];

  for (const entry of population) {
    // Only record-level targets
    if (entry.target.split('.').length !== 3) continue;
    if (matchesPredicate(entry.value, where)) {
      matching.push(entry.target);
    }
  }

  // Create auto-CON edges (reverse: population member → pattern target)
  for (const member of matching) {
    await addEdge(db, {
      source: member,
      dest: target,
      edge_type: '_pattern',
      seq: 0  // system-generated edge
    });
  }

  // Register as EVA-active with pattern metadata
  const registration: PatternRegistration = {
    target,
    formula: operand,
    mode: 'fold',
    dependencies: matching,
    pattern: true,
    over,
    where,
    population_targets: matching
  };

  await db.put(`eva:${target}`, registration);

  // Compute initial value
  await evaluateFormula(db, registration);
}

/**
 * Simple predicate matcher.
 * Checks if a value object matches all key-value pairs in the predicate.
 */
function matchesPredicate(value: any, predicate?: Record<string, any>): boolean {
  if (!predicate) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(predicate).every(([k, v]) => value[k] === v);
}
```

Also add a hook in the INS handler — after creating the new target, check if it matches any pattern predicates:

```typescript
// At the end of executeINS:
await checkPatternMembership(db, event.target, event.operand);

async function checkPatternMembership(db: Level, target: string, value: any): Promise<void> {
  // Scan all pattern registrations
  for await (const [key, reg] of db.iterator({ gte: 'eva:', lte: 'eva:\uffff' })) {
    if (!reg.pattern) continue;
    // Check if this target falls under the pattern's prefix
    if (!target.startsWith(reg.over + '.')) continue;
    // Check if only record-level
    if (target.split('.').length !== 3) continue;
    // Check predicate
    if (matchesPredicate(value, reg.where)) {
      // Add CON edge and update registration
      await addEdge(db, { source: target, dest: reg.target, edge_type: '_pattern', seq: 0 });
      reg.population_targets.push(target);
      reg.dependencies.push(target);
      await db.put(key, reg);
      // Recompute
      await evaluateFormula(db, reg);
    }
  }
}
```

---

## 6. Changes to WebSocket Sync (§10 of spec)

Add a new subscription type for signals:

```
Client sends:
{ "type": "subscribe_signals", "prefix": "app.tblCases", "interval": 60 }

Server responds:
Every 60 seconds (or on demand), the server runs detectSignals for the prefix
and pushes results:

{ "type": "signals", "prefix": "app.tblCases", "signals": [...], "computed_at": "..." }

Client sends to stop:
{ "type": "unsubscribe_signals", "prefix": "app.tblCases" }
```

This is an optional subscription. No client is required to use it. It's the equivalent of SIG — directing attention at a region and receiving ephemeral observations.

---

## 7. Changes to Admin Interface

Modify `eo-db-admin.html`:

**Horizon view:** Add a toggle button "Show Grounds" (default on) and "Detect Signals" (default off) in the toolbar. When grounds are on, each row in the state table shows inherited ground values in a muted style below the figure value. When signals are on, a panel below the table shows detected patterns for the currently visible population.

**Detail drawer:** When a target is selected, the drawer shows three sections:
- **Figure** — current projected state (existing)
- **Grounds** — inherited ambient conditions with source path and distance
- **Signals** — detected patterns this target participates in (only computed when the drawer is open)

**Log view:** No changes. The log shows events as written. Grounds and signals are not events.

**Graph view:** When patterns are INS'd, they appear as nodes in the graph with auto-CON edges from population members. Pattern nodes are styled differently (dashed border, pattern icon).

---

## 8. Changes to Build Order (build prompt)

Insert after Phase 3 (Horizon):

### Phase 3b: Three-Layer Horizon
- Implement `getGrounds` — prefix-walk collecting ancestor-level state. Respect override rule (child value wins over ancestor).
- Implement `detectSignals` — placeholder population analytics. Return basic statistics over numeric fields in the target's collection. Only runs when `opts.signals === true`.
- Modify `horizonGet` to return `HorizonResponse` with figure, grounds, and optional signals.
- Implement predicate matcher `matchesPredicate` for pattern population filtering.
- Write tests:
  - DEF at collection level is returned as ground for record-level reads
  - DEF at app level is returned as ground for deeper reads
  - Figure value overrides ancestor ground with same key
  - Signals only computed when requested
  - Empty signals array when population too small

Insert after Phase 3b:

### Phase 3c: Pattern Registration
- Implement `isPatternOperand` detection in DEF handler
- Implement `registerPattern` — scan population, create auto-CON edges, register EVA-active, compute initial value
- Implement `checkPatternMembership` hook in INS handler — check new targets against existing pattern predicates
- Write tests:
  - DEF with `pattern: true` creates auto-CON edges for matching population
  - INS of new target matching pattern predicate adds CON edge and recomputes
  - DEF that changes a predicate-tested field updates population membership
  - Pattern value recomputes when upstream population member changes

---

## 9. Changes to Test Fixtures

Add ground-level fixtures:

```typescript
// Append to existing FIXTURES array:

// Ground: collection-level ambient condition
{ op: 'DEF', target: 'app.tblClients', operand: { regulatoryHold: true, defaultRegion: 'Nashville' }, client_event_id: 'fix-020', agent: '@admin:app.aminoimmigration.com' },

// Ground: app-level ambient condition
{ op: 'DEF', target: 'app', operand: { timezone: 'America/Chicago', firm: 'Amino Immigration' }, client_event_id: 'fix-021', agent: '@admin:app.aminoimmigration.com' },

// Pattern: tracked population statistic
{ op: 'INS', target: 'pattern.active_client_count', operand: {}, client_event_id: 'fix-022', agent: '@admin:app.aminoimmigration.com' },
{ op: 'DEF', target: 'pattern.active_client_count', operand: { formula: 'COUNT(*)', over: 'app.tblClients', where: { status: 'active' }, pattern: true }, client_event_id: 'fix-023', agent: '@admin:app.aminoimmigration.com' },
```

---

## 10. What This Does NOT Change

- The log format. Events are the same.
- The fold. Nine cases, same behavior. Pattern registration adds a hook in DEF and INS, but no new operator.
- The nine operators. No tenth operator. Grounds are DEFs at ancestor prefixes. Patterns are DEFs with population formulas. Signals are ephemeral Horizon computations.
- The keyspaces. `state:`, `graph:`, `eva:`, `log:`, `meta:`, `idem:` — all the same. Pattern registrations use the existing `eva:` keyspace with a `pattern: true` flag.
- The auth model. No changes.
- The WebSocket sync protocol. Event streaming is unchanged. Signal subscriptions are a new optional message type.

The entire patch is: the Horizon reads deeper, patterns are a subtype of EVA-active formulas with auto-maintained CON edges, and signals are ephemeral computations that never touch the log.
