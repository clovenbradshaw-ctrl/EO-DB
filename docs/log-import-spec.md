# Log Import Format Specification

EO-DB supports bulk import of events via two formats: **JSON** and **CSV**.
Both are submitted through authenticated API endpoints and processed sequentially
through the fold, triggering all normal side effects (REC cycle detection, INS2+
derived entity creation, changefeed notifications, etc.).

---

## API Endpoints

### `POST /import/json`

Import events from a JSON array.

**Request body:**

```json
{
  "events": [ ... ],
  "halt_on_error": false
}
```

| Field           | Type    | Required | Description                                   |
|-----------------|---------|----------|-----------------------------------------------|
| `events`        | array   | yes      | Array of event objects (see Event Schema)      |
| `halt_on_error` | boolean | no       | Stop on first error (default: false, skip errors) |

### `POST /import/csv`

Import events from CSV text.

**Request body:**

```json
{
  "csv": "op,target,operand\nINS,app.foo,{}\n...",
  "halt_on_error": false
}
```

| Field           | Type    | Required | Description                                   |
|-----------------|---------|----------|-----------------------------------------------|
| `csv`           | string  | yes      | CSV text with header row and data rows         |
| `halt_on_error` | boolean | no       | Stop on first error (default: false, skip errors) |

---

## Event Schema

Each event (JSON object or CSV row) has the following fields:

| Field             | Type   | Required | Description                                                |
|-------------------|--------|----------|------------------------------------------------------------|
| `op`              | string | yes      | Operator: `INS`, `DEF`, `CON`, `SEG`, `SYN`, or `EVA`     |
| `target`          | string | yes      | Dot-separated target path (e.g., `app.tblCases.rec001`)    |
| `operand`         | any    | no       | Operation-specific payload (default: `{}`)                 |
| `ts`              | string | no       | Submission timestamp, ISO 8601 (default: current time)     |
| `client_event_id` | string | no       | Idempotency key — duplicate IDs return the original seq    |
| `meta`            | object | no       | Arbitrary metadata attached to the event                   |

### Notes

- `REC` is system-generated and **cannot** be submitted via import.
- `agent` is set automatically from the authenticated user's Matrix ID.
- `acquired_ts` is set automatically to the server's current time.
- Events are processed **sequentially** in array/row order — later events
  can depend on earlier events in the same import batch.

---

## JSON Format

The JSON format is a flat array of event objects:

```json
[
  {
    "op": "INS",
    "target": "app.tblClients.rec001",
    "operand": { "name": "Maria Garcia", "status": "active" }
  },
  {
    "op": "DEF",
    "target": "app.tblClients.rec001",
    "operand": { "email": "maria@example.com" }
  },
  {
    "op": "INS",
    "target": "app.tblClients.rec002",
    "operand": { "name": "John Smith" },
    "client_event_id": "import-002"
  },
  {
    "op": "CON",
    "target": "app.tblClients.rec001",
    "operand": { "added": ["app.tblClients.rec002"], "edge_type": "referral" }
  }
]
```

### Operand shapes by operator

| Operator | Operand shape                                                        |
|----------|----------------------------------------------------------------------|
| `INS`    | `{ ...initial_value }` — any object to set as the entity's value     |
| `DEF`    | `{ ...fields }` — shallow-merged into existing value                 |
| `CON`    | `{ added?: string[], removed?: string[], edge_type?: string }`       |
| `SEG`    | `{ ...boundary_definition }` — replaces the target's value           |
| `SYN`    | `{ merge: [targetA, targetB], into?: mergedTarget }`                 |
| `EVA`    | `{ ...evaluation_policy }` — policy or formula definition            |

---

## CSV Format

The CSV format uses a header row followed by data rows. Columns are
comma-separated, and fields containing commas or quotes must be quoted
per RFC 4180.

### Required columns

| Column   | Description                                      |
|----------|--------------------------------------------------|
| `op`     | Operator code (`INS`, `DEF`, `CON`, etc.)        |
| `target` | Dot-separated target path                        |

### Optional columns

| Column            | Description                                              |
|-------------------|----------------------------------------------------------|
| `operand`         | JSON-encoded operand (e.g., `{"name":"Maria"}`)          |
| `ts`              | ISO 8601 timestamp                                       |
| `client_event_id` | Idempotency key                                          |
| `meta`            | JSON-encoded metadata object                             |

### Example CSV

```csv
op,target,operand,ts,client_event_id
INS,app.tblCases.rec001,"{""case_type"":""H1B"",""status"":""open""}",2025-06-01T00:00:00Z,import-001
INS,app.tblCases.rec002,"{""case_type"":""L1"",""status"":""open""}",2025-06-01T00:00:01Z,import-002
DEF,app.tblCases.rec001,"{""assigned_to"":""@maria:amino.im""}",2025-06-01T00:01:00Z,import-003
CON,app.tblCases.rec001,"{""added"":[""app.tblCases.rec002""],""edge_type"":""related""}",2025-06-01T00:02:00Z,import-004
```

### CSV quoting rules

- Fields containing commas, quotes, or newlines **must** be enclosed in double quotes.
- Double quotes within a quoted field are escaped by doubling them: `""`.
- JSON operands should be quoted: `"{""key"":""value""}"`.
- Empty operand fields default to `{}`.

---

## Response Format

Both endpoints return the same response shape:

```json
{
  "total": 4,
  "processed": 3,
  "skipped": 1,
  "errors": [
    { "index": 2, "error": "Target already instantiated: app.tblCases.rec001" }
  ],
  "sequences": [1, 2, 4]
}
```

| Field       | Type     | Description                                             |
|-------------|----------|---------------------------------------------------------|
| `total`     | number   | Total rows/events in the input                          |
| `processed` | number   | Successfully processed events                           |
| `skipped`   | number   | Events skipped due to validation or processing errors   |
| `errors`    | array    | Array of `{ index, error }` for each failed event       |
| `sequences` | number[] | Assigned sequence numbers for successfully processed events |

---

## Error Handling

- **Default mode** (`halt_on_error: false`): Errors are captured per-row.
  The import continues with remaining events. Skipped events appear in
  the `errors` array.
- **Halt mode** (`halt_on_error: true`): The import stops at the first
  error. Events already processed are committed (they are not rolled back).
- **Validation errors** (missing op, invalid op, missing target) are caught
  before the event reaches the fold.
- **Fold errors** (duplicate INS, missing CON endpoints, etc.) are caught
  during processing.

---

## Side Effects

Imported events flow through the same fold as individual API submissions.
This means an import batch can trigger:

1. **Idempotency deduplication** — Events with duplicate `client_event_id`
   values return the original seq without re-processing.
2. **No-op detection** — DEF events that would not change state are skipped.
3. **EVA formula recomputation** — DEF/CON events trigger fold-mode formula
   re-evaluation on dependent targets.
4. **REC cycle detection** — Completing a dependency cycle triggers a
   system-generated REC event with fixed-point iteration.
5. **INS2+ derived entities** — When REC converges, a derived entity is
   created at the next INS level.
6. **Cascade upward** — Changes to constituents of derived entities trigger
   re-evaluation up the level hierarchy.
7. **Changefeed notifications** — All events (human and system-generated)
   are broadcast to WebSocket subscribers.
