# How EO-DB Stores and Processes Data

## The Short Version

EO-DB is not a database in the traditional sense. It's closer to a **ledger** — like an accounting ledger where you never erase entries, only add new ones. Your current "state" (what you see when you look something up) is always *calculated on the fly* from that ledger by a process called **the fold**.

---

## Part 1: The Traditional Database (What EO-DB is NOT)

To understand EO-DB, it helps to first understand what most databases do.

In a traditional database (like MySQL, PostgreSQL, or even Excel), data is stored **in place**. Think of it like a filing cabinet with labeled folders:

- You open folder `client.alice` and it contains `{ name: "Alice", status: "active" }`.
- You change Alice's status to "inactive". You open the folder, cross out "active", write "inactive", and close it.
- The old value is **gone**. There's no record that it was ever "active".

This works fine for many situations. But it has a hidden cost: **you lose history**. You can't ask "what was Alice's status three months ago?" You can't ask "who changed this, and when?" You can't reconstruct the database as it looked on a specific date — unless you've separately built an audit log system on top.

---

## Part 2: The EO-DB Approach — The Ledger

EO-DB works like a **bookkeeper's ledger**, not a filing cabinet.

Imagine an accounting ledger where:
- You *never* erase or cross out entries.
- Every change is written as a **new line at the bottom** with a timestamp, who made the change, and what changed.
- The current balance isn't *stored* anywhere — it's *calculated* every time by adding up all the rows.

In EO-DB, this ledger is called the **event log**. Every change to any piece of data is stored as an **event** — an immutable, timestamped, numbered record. Events look roughly like:

```
seq=1  | op=INS | target="cases.rec001"      | agent="@attorney" | "Create this case"
seq=2  | op=DEF | target="cases.rec001.name" | agent="@attorney" | value="Alice Smith"
seq=3  | op=DEF | target="cases.rec001.name" | agent="@attorney" | value="Alice Johnson"
seq=4  | op=DEF | target="cases.rec001.status" | agent="@system" | value="active"
```

Notice that `seq=3` doesn't *replace* `seq=2`. Both are kept. The log is **append-only**: you can only add to the bottom, never change anything above.

This means:
- **Nothing is ever lost.** Every version of every value, forever.
- **Every change is attributed.** Who did it, when, why.
- **You can reconstruct the past.** "Show me everything as it stood at event #47."
- **No silent data loss.** If something goes wrong, you can replay from the beginning.

---

## Part 3: The Fold — How Current State is Computed

So if the log keeps *every* change, how do you find out what Alice's name is *right now*?

This is where **the fold** comes in.

The fold is a process that **reads the event log from the beginning and accumulates state** — like a running total. Here's the mental model:

Imagine you're a cashier totaling up a receipt:
- You start with $0.00.
- You read line 1: add $5.00 → running total is $5.00.
- You read line 2: add $12.00 → running total is $17.00.
- You read line 3: subtract $3.00 → running total is $14.00.

Your "current balance" ($14.00) isn't stored anywhere on the receipt — it's *derived* from all the lines.

EO-DB works exactly the same way, but for data:

1. **Start** with no state for a target.
2. **Read** the first event that mentions `cases.rec001.name` (seq=2): set name to "Alice Smith".
3. **Read** the next event (seq=3): overwrite name with "Alice Johnson".
4. **Result**: current name is "Alice Johnson".

That final value ("Alice Johnson") is saved into a **projected state** — essentially a cache — so you don't have to replay the entire log every single time you want to read something. But the **log is always the real truth**. The projected state is just a shortcut.

### The Nine Operators

The fold doesn't just handle simple "set a value" operations. It understands nine different types of events (called **operators**), each of which does something different to the accumulated state:

| Operator | Meaning | Analogy |
|----------|---------|---------|
| **NUL** | "I observed this, nothing changed" | A note in the margin |
| **SIG** | "Send a signal; don't store this" | A phone call (ephemeral) |
| **INS** | "Create this entity" | Opening a new account |
| **SEG** | "Mark a boundary or partition" | A chapter divider |
| **CON** | "Connect two entities" | Drawing a line between two things |
| **SYN** | "Merge these two things together" | Combining two folders |
| **DEF** | "Set or define a value" | Writing a value in a cell |
| **EVA** | "Register a formula or policy" | Writing a spreadsheet formula |
| **REC** | "Repeat until stable" | Running a calculation until it converges |

Each operator builds on the ones before it. When a **DEF** event is processed, for example, the fold automatically handles cases like "what if this entity doesn't exist yet?" (it auto-creates it via the INS capacity) and "is there a formula registered here?" (it triggers the EVA capacity).

### The Transformation Hash

Every time the fold processes an event, it also updates a **transformation hash** — a cryptographic fingerprint of the complete history of that entity. Think of it like a rolling checksum. Two entities that have gone through the exact same sequence of operations will have identical hashes, making them **structural twins** that can be compared or deduplicated efficiently.

---

## Part 4: Where the Data Lives Physically

Data lives in two places simultaneously:

### The Event Log (Source of Truth)
Each event gets a sequential number (seq) and is stored with zero-padded keys like `log:000000000001`, `log:000000000002`, etc. The zero-padding is intentional — it makes the keys sort correctly in alphabetical order, so scanning "all events since seq 100" is a simple range read.

In the server version, this is stored in **LevelDB** — a fast key-value store (think of it like a very efficient sorted dictionary on disk). In the browser version, it uses **IndexedDB** — the browser's built-in storage engine, encrypted with AES-GCM so no one can read the raw files.

### The Projected State (The Cache)
After the fold runs, the current computed value for each target is saved under keys like `state:cases.rec001.name`. This is what gets returned when you ask "what is Alice's name?" — the system reads the cached projected value rather than replaying the entire log.

If the projected state were ever lost or corrupted, it can always be rebuilt by replaying every event in the log from the beginning. The log is the only thing that can never be regenerated.

### The Graph Index
When a **CON** (connect) event links two entities, the connection is stored in a graph index under keys like `graph:fwd:cases.rec001:client.alice` (and a reverse pointer `graph:rev:client.alice:cases.rec001`). This allows fast answers to questions like "show me everything connected to Alice" without scanning the entire log.

---

## Part 5: Branches — Multiple Timelines

EO-DB supports **branches**: separate timelines that can diverge, evolve independently, and then be merged back together.

Think of it like a **choose-your-own-adventure book**, except all paths are recorded simultaneously:

- The **main** branch is the shared, authoritative timeline.
- You can create a **branch** (say, a "draft review" branch) where you make changes without affecting main.
- The branch accumulates its own events.
- When you're done, you **merge** the branch back into main.
- If both branches changed the same value, there's a **conflict** — and the system records the conflict explicitly rather than silently picking one winner.

This is very different from a traditional database where there's only ever one version of the truth, and concurrent edits either serialize (one waits for the other) or overwrite each other with no trace.

---

## Part 6: Reactive Formulas (EVA)

One of the most distinctive features is **EVA** — a way to register *formulas* that automatically recompute when their dependencies change.

This is essentially a **live spreadsheet cell** embedded in the database. You can define:
> "The value of `cases.rec001.days_open` should always be calculated from `cases.rec001.opened_date` and today's date."

When the fold processes any event that affects `opened_date`, it checks whether any EVA formulas depend on that target and automatically re-evaluates them, cascading the update through the projected state.

Unlike a spreadsheet (which only recalculates when you open it), EO-DB's EVA formulas recompute *as part of the fold* — meaning derived values are always up-to-date the moment a change is written.

---

## Part 7: Decentralization and Offline-First

Traditional databases live on a server. You connect to the server to read or write data. If the server is down, you're stuck.

EO-DB is designed to run **entirely in your browser**, with no server required.

Here's how it works:

1. Your browser holds a **complete copy of the event log**.
2. The fold runs **locally** in your browser — state is computed on your device.
3. When you make a change, the event is written to your local log *immediately*.
4. When you're online, your events **sync to other devices** via encrypted Matrix rooms (the same protocol used by some encrypted messaging apps).
5. Other devices receive your events, append them to their local logs, and re-run the fold.

This means:
- **No server required** for reading or writing.
- **Works offline** — changes queue up and sync when reconnected.
- **End-to-end encrypted** — data is encrypted before it leaves your device; even the sync server can't read it.
- **Every device is an equal peer** — there's no "master" copy.

---

## Part 8: Why This Is Different from a Traditional Database

Here's the big-picture comparison:

| | Traditional Database | EO-DB |
|--|---------------------|-------|
| **Core metaphor** | Filing cabinet | Accounting ledger |
| **Writes** | Update in place | Append to log |
| **History** | Gone (unless you build audit tables) | Permanent and complete |
| **Current state** | Directly stored | Derived by folding the log |
| **Offline** | Usually impossible | Native — the fold runs locally |
| **Conflicts** | One write wins (or error) | Both recorded, explicit resolution |
| **Relationships** | Foreign keys in tables | Graph edges via CON operator |
| **Formulas** | Views and triggers (secondary) | First-class EVA operators |
| **Encryption** | Optional, database-level | Built-in, end-to-end, at application layer |
| **Decentralization** | Centralized server | Every device holds the complete database |
| **Schema** | Rigid (columns, types) | Flexible dot-path targets |
| **Query language** | SQL | Operators + path traversal |

The deepest philosophical difference is this:

> In a traditional database, **state is primary**. You store the current truth directly and derive history as an afterthought (if at all).
>
> In EO-DB, **events are primary**. You store the complete history of what happened, and derive the current truth by computing it.

This inversion changes everything. It makes EO-DB slower to write (you must store and process every event) but immeasurably richer — every question about the past is answerable, every change is attributable, every conflict is visible, and the entire database can be reconstructed from scratch on any device that has a copy of the log.

---

## Summary

1. **Every change is an event** — an immutable, numbered, timestamped record appended to the log.
2. **Current state is computed** by "folding" (accumulating) the event log, like totaling a receipt.
3. **Nine operators** define what a fold does with each type of event (create, connect, define, evaluate, etc.).
4. **Physical storage** is split: the log (truth) + projected state (fast-lookup cache), both encrypted.
5. **Branches** allow multiple diverging timelines that can be merged with explicit conflict handling.
6. **EVA formulas** make derived values reactive — they recompute automatically when dependencies change.
7. **The whole database runs in your browser** — offline-first, end-to-end encrypted, server-optional.

The result is a system that behaves less like a database and more like a **distributed, encrypted, reactive ledger** — one where the complete history is the data, and the "database" is just a convenient view computed from that history.
