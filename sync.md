# EO-Native Sync Layer — Specification

**Status:** Draft v1, replaces v2 BitTorrent plan
**Audience:** Senior engineer / architect implementing or reviewing this layer
**Repo:** `github-matrix-dev/app`

---

## 0. Why this exists (1 paragraph)

The v2 plan implemented a competent BitTorrent-over-Matrix sync layer where pieces, bitfields, peer states, and blacklists were worker-internal data structures invisible to the rest of the system. This spec replaces that approach with one in which every meaningful sync action is an EO event on the same log as application data, processed by the same fold, materialized into the same projected state, and rendered by the same Horizon. The goals are:

1. **Recursion:** the sync system syncs itself by the same mechanism it syncs application data.
2. **Self-healing:** divergences are detected and resolved by the operators themselves, not by ad-hoc code paths.
3. **Provenance:** every byte that enters the local log carries an explicit chain of custody.
4. **Honest uncertainty:** contested state is a first-class queryable phenomenon, not a hidden race.

If we cannot make the operators do this work — if we have to fall back to imperative engineering for the system that handles application data — the universality claim of EO is false. This spec is the test case.

---

## 1. Operator vocabulary

The nine operators of EO, organized in three triads.

| Triad | Operator | Glyph | Role |
|---|---|---|---|
| **Existence** | NUL | ∅ | Non-action; the identity function. The capacity to act and not. |
| | SIG | ◊ | Designation of signal from noise. Salience prior to instantiation. |
| | INS | △ | Coming-into-being for this device. Never replaces, only adds. |
| **Structure** | SEG | \| | Cut a continuum into discrete bounded segments. |
| | CON | ⋈ | Joins/type-level connectability between sites. |
| | SYN | ∨ | Emergent synthesis: parts combine into a genuine third. |
| **Significance** | DEF | ⊢ | Superposition; multiple simultaneously valid states held without collapse. |
| | EVA | ⊨ | Value change within a stable frame. The workhorse update. |
| | REC | ↬ | Pattern recognition; frame restructuring; meta-operator. |

Every event in the EO log has the shape:

```ts
interface EoEvent {
  event_id: string;            // sha256 over canonical event minus event_id and signature
  op: "NUL" | "SIG" | "INS" | "SEG" | "CON" | "SYN" | "DEF" | "EVA" | "REC";
  site: string;                // namespaced address, e.g. "piece:device_A/7"
  resolution: object;          // operator-specific payload
  prev_events: string[];       // causal DAG predecessors
  origin_device_id: string;    // Matrix deviceId of emitter
  origin_user_id: string;      // Matrix userId of emitter
  origin_server_ts: number;    // ms epoch
  client_event_id: string;     // emitter-side idempotency key
  signature: string;           // ed25519 over canonical event minus signature
}
```

CON's resolution carries `weight` (numeric, default 1.0) and `coupling` (string label) per the established spec. The other operators' resolution shapes are defined per-site below.

---

## 2. Site namespace

Sites are dotted/slashed strings that name the locus of a phenomenon. The sync layer uses these site families:

| Site | Meaning | Cardinality |
|---|---|---|
| `swarm:<room_id>` | The swarm for a Matrix room | one per joined room |
| `peer:<user_id>\|<device_id>` | A peer's identity in a swarm | many per swarm |
| `log:<author_device_id>` | An authoring device's emit stream | one per author seen |
| `piece:<author_device_id>/<piece_index>` | A specific piece slot in an author's emit stream | many per author |
| `tail:<author_device_id>` | The open trailing partial piece for an author | one per author |

Sites are addresses, not entities. An entity exists at a site when at least one INS event has been folded for it.

---

## 3. Operator semantics by site

### 3.1 `swarm:<room_id>`

| Op | Meaning | Resolution shape |
|---|---|---|
| INS | The swarm is established for this device (first time joining the room) | `{room_id, joined_at}` |
| CON | A peer is connected to the swarm | `{joined: peer_id, via: "matrix_membership" \| "webrtc_dc", weight, coupling: "active" \| "stale" \| "departed"}` |
| SIG | A piece is advertised as available somewhere in the swarm | `{kind: "piece_available", author_device_id, piece_index, expected_hash, advertised_by: peer_id}` |
| EVA | A swarm-level metric updates (e.g., redundancy, member count) | `{field, from, to, rationale}` |
| REC | The swarm is recognized as being in a particular pattern | `{recognized, pattern, implication}` |
| DEF | The swarm holds contested state (e.g., conflicting SIGs) | `{superposed: [...], awaiting: [...]}` |
| DES | (n/a — sites are addresses, swarm is not destroyed) | — |

**Projected state:** swarm membership (peer set with CON.coupling labels), piece-availability matrix (SIG events grouped by `(author, piece_index)`), swarm-level recognized patterns (latest REC per `recognized` value).

### 3.2 `peer:<user_id>|<device_id>`

| Op | Meaning | Resolution shape |
|---|---|---|
| INS | The peer first becomes known to this device | `{user_id, device_id, first_seen_at, capabilities: {rtc, ...}}` |
| EVA | A peer attribute changes | `{field: "reliability_score" \| "tail_head[author_id]" \| "eligibility_for[piece_id]" \| ..., from, to, rationale}` |
| REC | A pattern is recognized about this peer | `{recognized, pattern, suggested_action}` |
| CON | The peer is joined to a piece-slot (i.e., claims to have it or has delivered it) | `{joined: piece_site, via: "advertised" \| "delivered_unverified" \| "delivered_verified", weight, coupling}` |

**Projected state:** per-peer reliability score (folded from EVAs and RECs), per-peer per-piece eligibility (folded from EVA on `eligibility_for[piece_id]` field with TTL semantics on the `to` value), per-peer capability flags.

### 3.3 `log:<author_device_id>`

| Op | Meaning | Resolution shape |
|---|---|---|
| INS | An authoring device's emit stream first becomes known | `{author_device_id, first_seen_event_id}` |
| SEG | The author closes a piece on its own log | `{segment_id: piece_site, bounds: {from_seq, to_seq}, closes_at: event_id, content_hash, schema_version: 1}` |
| EVA | The author's tail head advances (observed by this device) | `{field: "tail_head", from, to, observed_via}` |

**Authority rule:** SEG events are valid only if `origin_device_id === <author_device_id>`. SEGs from any other device are dropped at fold time as invalid (logged but not folded). This is the only authority rule in the system; everything else is consensus or last-writer-wins via standard MVR/LWW.

**Projected state:** authoritative piece manifest per author (the set of SEG events). Authoritative tail head per author (latest EVA from the author themselves; EVAs from other observers are treated as lower-priority hints).

### 3.4 `piece:<author_device_id>/<piece_index>`

| Op | Meaning | Resolution shape |
|---|---|---|
| INS | The piece is instantiated on this device (bytes received and verified) | `{content_hash, event_count, obtained_from: peer_id, obtained_via: "webrtc" \| "matrix_to_device" \| "self_authored", obtained_at}` |
| SIG | The piece is signaled as available (often paired with CON on a peer) | (see swarm:* SIG above) |
| DEF | The piece's identity is contested (multiple hashes claimed) | `{superposed: [{hash, advertised_by: [...], coupling}, ...], awaiting: [...]}` |
| SYN | The piece is swarm-attested (N independent verifying deliveries) | `{synthesized: "swarm_attested", contributors: [peer_id, ...], unanimous_hash, matches_authoring_seg: bool, threshold: N}` |
| REC | The piece is recognized as being in a special state | `{recognized: "unrecoverable_pending_author" \| "stuck_in_def" \| "fully_seeded" \| ..., pattern, awaiting?, suggested_action?}` |

**Projected state:** per-piece status — one of `absent | signaled | requested | in_def | instantiated | swarm_attested | unrecoverable`. The status is computed deterministically from the latest events on the site.

### 3.5 `tail:<author_device_id>`

| Op | Meaning | Resolution shape |
|---|---|---|
| INS | The first tail event from this author lands on this device | `{starting_seq, first_event_id, obtained_from}` |
| EVA | Tail head advances locally (we now have events through seq N) | `{field: "local_tail_head", from, to, obtained_from}` |
| SYN | Tail events have been multi-sourced and agree | `{synthesized: "tail_attested", range: {from_seq, to_seq}, contributors, unanimous_event_ids}` |
| REC | Tail is recognized as stalled (author offline, no peers can serve) | `{recognized: "tail_stalled", awaiting}` |

The tail is deliberately not SEG'd until the author closes a piece. While open, tail events are fetched via TAIL_FETCH (control message) and confirmed via SYN once multi-sourced.

---

## 4. Wire protocol

The wire is **a thin transport for EO events about the sync layer**, not a separate protocol. There is no HAVE/BITFIELD/REQUEST/CANCEL message family. There are EO events that get propagated, and there are control queries that ask peers to send specific events or piece bytes.

### 4.1 Event propagation

EO events on sync sites (`swarm:*`, `peer:*`, `log:*`, `piece:*`, `tail:*`) propagate through the same Matrix room timeline as application-data events. They are batched (per existing `io.groundtruth.eo.batch` event type) and folded by the same fold worker.

This means: when a peer joins, it does a full `/sync` against its homeserver, folds the timeline, and from that fold materializes the swarm view, piece manifest, peer reliability, contested-piece DEFs, etc. **No separate bootstrap protocol.** The log is the bootstrap.

### 4.2 Control queries

Three control message types over Matrix to-device, namespaced `com.eo-db.swarm.v2`:

```ts
type ControlMessage =
  | { kind: "request_piece_bytes"; req_id: string; piece_site: string; expected_hash: string }
  | { kind: "request_tail_events"; req_id: string; tail_site: string; from_seq: number }
  | { kind: "cancel"; req_id: string };
```

These do not enter the EO log. They are ephemeral asks. Responses do enter the log: a `request_piece_bytes` response is a delivery of bytes that, when verified locally, causes the receiver to emit an `INS` event on the piece-site with `obtained_from = sender, obtained_via = ...`.

### 4.3 Bulk transport

Two bulk message types over WebRTC DataChannel (primary) or Matrix to-device (fallback):

```ts
type BulkMessage =
  | { kind: "piece_bytes"; req_id: string; piece_site: string; content_hash: string; events_msgpack: Uint8Array }
  | { kind: "tail_bytes"; req_id: string; tail_site: string; from_seq: number; events_msgpack: Uint8Array };
```

Receivers verify `content_hash` (for piece) or per-event hashes (for tail) before folding. Verified events flow through the existing `processEvent` path. After successful fold, the receiver emits an `INS` (piece) or `EVA` (tail head advance) event on the appropriate site.

### 4.4 What replaces HAVE/BITFIELD

Nothing replaces them as wire messages. The equivalent information is carried by:

- **HAVE → SIG event** on `swarm:<room_id>`. Authoring device emits a SIG when it closes a piece (paired with the SEG event); receiving devices emit SIGs as they instantiate pieces (paired with their INS events). All SIGs propagate through the normal Matrix timeline.
- **BITFIELD → query the local fold.** "What does peer Q have?" is answered by querying SIG events whose `advertised_by = Q`. There is no on-the-wire bitfield. A reconnecting peer that wants its peers' state simply syncs the room and folds.

This eliminates an entire class of bugs: bitfield drift, missed HAVE messages, BITFIELD too large for a single Matrix message. The state is in the log; the log is the source of truth.

### 4.5 What replaces REQUEST/CANCEL

The control message above. These are explicitly ephemeral because they're not phenomena worth keeping in the log. The phenomena worth keeping — "we now have piece X obtained from peer Y" — are the resulting INS events.

---

## 5. The scheduler as fold-driven loop

The scheduler is not a stateful actor running its own data structures. It is a function `schedule(state) -> intents` where `state` is a projection of the EO log and `intents` are control-query messages to send.

```ts
function schedule(state: ProjectedState): SchedulerIntent[] {
  const missing = state.pieceStatus
    .filter(p => p.status === "absent" || p.status === "signaled" || p.status === "in_def")
    .filter(p => !state.inFlight.has(p.site));

  const ranked = rankRarestFirst(missing, state.swarmView);

  const intents: SchedulerIntent[] = [];
  for (const piece of ranked) {
    const eligiblePeers = state.swarmView[piece.site]
      .filter(p => state.peerEligibility[p][piece.site] === "eligible")
      .filter(p => state.peerInFlightCount[p] < IN_FLIGHT_PER_PEER);

    if (eligiblePeers.length === 0) continue;

    const peer = pickPeer(eligiblePeers, state.peerReliability);
    intents.push({
      kind: "request_piece_bytes",
      peer,
      piece_site: piece.site,
      expected_hash: piece.expectedHash,
    });

    if (state.totalMissing < ENDGAME_THRESHOLD) {
      // Endgame: also ask other eligible peers
      for (const otherPeer of eligiblePeers.slice(1, 3)) {
        intents.push({
          kind: "request_piece_bytes",
          peer: otherPeer,
          piece_site: piece.site,
          expected_hash: piece.expectedHash,
        });
      }
    }
  }

  return intents;
}
```

The scheduler runs every 250ms or when state changes. Its inputs are the projection. Its outputs are intents. It holds no state of its own.

In-flight tracking, blacklist state, reliability scores, swarm view — all are projected state, materialized by the fold from EO events. The scheduler reads from projection, never from worker-internal data.

This means: **the scheduler's behavior is replayable**. Given the same EO log up to time T, the scheduler at time T will produce the same intents on every device. This is the analog to fold determinism, applied to the control plane.

---

## 6. Self-healing flows (concrete operator traces)

### 6.1 Hash divergence

```
t1: Author A emits SEG on log:device_A → segment_id=piece:device_A/3, hash=H1
t2: A also emits SIG on swarm:room → piece:device_A/3, hash=H1, advertised_by=A
t3: Buggy peer B emits SIG on swarm:room → piece:device_A/3, hash=H2, advertised_by=B
t4: Receiver R folds events. Sees two SIGs with different hashes for piece:device_A/3.
    Fold materializes DEF on piece:device_A/3 (superposed: H1 from A, H2 from B).
t5: R's scheduler reads DEF, requests from B (rarest path).
t6: B delivers bytes. R verifies: hash = H2. Matches B's claim, but doesn't match
    SEG's H1. R emits EVA on peer:B → eligibility_for[piece:device_A/3]:
    eligible → blacklisted_until_T.
t7: R also emits REC on peer:B → recognized="delivered_bad_hash".
    This REC propagates to other devices via normal sync.
t8: R's scheduler re-reads, now sees B blacklisted for this piece. Picks next peer.
t9: Another peer delivers bytes hashing to H1. R emits INS on piece:device_A/3.
t10: DEF is resolved by INS arrival (status transitions in projection).
```

No special "if hash mismatch then refetch" code. The operators handle it.

### 6.2 Schema evolution

```
v1 devices emit SEGs with schema_version=1, PIECE_SIZE=64.
v2 devices emit SEGs with schema_version=2, PIECE_SIZE=256.

Both fold without conflict because they target different segment_ids.
A v1 device requesting piece:device_A/3 gets the v1 SEG's bounds.
A v2 device requesting piece:device_A/3 may get a v2 SEG with different bounds —
  the segment_id naming convention must include version, or v2 uses different indexing.

Decision: segment_id is `piece:device_A/v<N>/<index>`. Old segment_ids still work
by being treated as v1 implicitly. New version emits new namespace. Both coexist.

Migration is gradual: v2-aware devices serve both v1 and v2 segments; v1-only
devices serve only v1 segments. EVA on swarm:room can recognize "swarm is now
N% v2-capable" and devices can adjust scheduling preferences accordingly.
```

### 6.3 Network partition

```
Partition occurs at t=100. Two halves continue emitting normally.
At t=200, partition heals.

Half-A's events about pieces, peers, RECs, etc. fold into half-B and vice versa.

Where halves emitted EVAs on the same field of the same site (e.g., a peer's
reliability_score), MVR materializes both values. The receiver's scheduler
treats it as uncertain and may emit a REC about the conflict.

Where halves SIG'd the same piece with different hashes, DEF materializes the
contradiction. Subsequent INS events from verifying deliveries resolve them
one-by-one as in 6.1.

Where halves had divergent peer-reachability views, this resolves naturally:
the scheduler will discover which peers are now actually reachable and emit
EVAs accordingly.

No partition-recovery code. The same fold that handles steady-state handles
partition healing.
```

### 6.4 Reputation gossip

```
Device R observes peer Q deliver bad bytes for piece P1. R emits REC on
peer:Q with recognized="delivered_bad_hash", pattern includes P1 site.

Device S receives R's REC via normal Matrix timeline sync. S folds it.
S's projection now includes R's recognition of Q's failure.

S's scheduler reads its own peer reliability projection, which now
incorporates R's REC as one signal among many.

If 3+ devices independently REC Q for similar failures, the projection
materializes a SYN on peer:Q with synthesized="cross_device_unreliability".
This is stronger than any single REC.

Q's scheduler eventually folds these RECs (assuming Q is in the swarm and
syncing the room). Q can see itself being recognized as unreliable.
Q can emit a REC on its own peer site with recognized="self_failure_detected"
and take corrective action (e.g., reverify its local copies, request
re-fetch from authoritative source).

No central reputation server. No consensus protocol. Just observation,
recognition, propagation.
```

---

## 7. Worker topology

The worker still exists as the long-lived dedicated worker per tab. Its responsibilities shift:

| Worker responsibility | Mechanism |
|---|---|
| Fold incoming events from the Matrix timeline | Existing `fold.worker.ts`; no change to interface |
| Project sync state from the fold | New: `sync-projection.worker.ts` runs alongside fold; subscribes to fold's changefeed for sync sites |
| Run scheduler tick | New: pure function over projected state |
| Emit control messages | Worker → main bridge sends via Matrix to-device |
| Verify and fold incoming piece bytes | Worker verifies hash, hands events to fold; fold materializes INS automatically |
| Emit sync-layer EO events (SIG, EVA, REC, DEF, SYN) | Worker computes them from observation and sends to main thread for emission via Matrix timeline |

The worker does not maintain a piece table, bitfield, swarm view, or blacklist as separate data structures. These are all computed projections of the EO log, served by the projection module on demand.

---

## 8. The fold's new responsibilities

The fold worker (`fold.worker.ts`) gains handlers for the new operators on sync sites. Critically, the existing per-operator handler logic stays the same; only the sites and resolution shapes are new.

| Handler addition | What it does |
|---|---|
| INS on `peer:*` | Add peer to swarm projection |
| INS on `piece:*` | Mark piece instantiated on this device |
| SIG on `swarm:*` | Add to piece-availability projection |
| SEG on `log:*` | Validate `origin_device_id === author_device_id`; if valid, add to authoritative piece manifest |
| EVA on `peer:*` field `eligibility_for[*]` | Update peer eligibility projection (with TTL semantics if `to` value encodes expiry) |
| EVA on `peer:*` field `reliability_score` | Update reliability projection |
| REC on `peer:*` | Update reputation projection (latest REC per `recognized` value) |
| REC on `piece:*` recognized="unrecoverable_*" | Update piece status projection |
| DEF on `piece:*` | Compute from concurrent SIGs (this is derived state, not emitted directly) |
| SYN on `piece:*` synthesized="swarm_attested" | Compute when N independent verifying INSs accumulate |

**DEF and SYN are derived, not emitted by the wire.** They are materialized by the fold when it detects the conditions. This is the recursion: the fold itself recognizes and emits operators about its own state.

---

## 9. Operator idempotence and concurrency (Layer 1 carried forward)

The Layer 1 commitments still hold:

- All operators are concurrent-safe per the table established in Layer 1.
- `EVA` on the same site/field from concurrent emitters resolves via MVR by default; certain fields (e.g., `tail_head`) use LWW.
- `INS` is idempotent on `(site, content_hash)` — a second INS with the same content is dropped at fold time.
- `SIG` is idempotent on `(site, advertised_by, expected_hash)`.
- `SEG` is idempotent on `(site, segment_id)` and rejects mismatched hashes from same author (which would indicate a bug in the author).

The fold computes a rolling state hash per Layer 1, allowing two devices to compare projections without exchanging full state.

---

## 10. What is explicitly out of scope

- **NUL emission.** NUL is implicit in the worker's filter — events the worker chooses not to act on. We do not emit NUL events to the log; doing so would be infinite (every event the worker doesn't act on would generate one). NUL is conceptual ground, not log content.
- **Cross-room sync.** Each room is its own swarm. A device in multiple rooms runs one worker that handles each room's swarm independently.
- **Encrypted piece bodies.** Existing `encryptPeerPayload`/`decryptPeerPayload` continues to wrap bulk transport bodies when a keyring is present. This is transport-layer; the EO log inside is the same.
- **Incentive mechanisms.** Trusted-swarm semantics for the per-user case; token bucket for the federated case. No tit-for-tat, no choking algorithm.

---

## 11. Verification plan

1. **Type check.** `npx tsc -b --noEmit` clean before each commit.
2. **Operator unit tests.** For each new (operator, site) handler: idempotence, MVR/LWW behavior on conflict, correct projection update.
3. **Fold determinism test.** Generate 10K random sync events, fold on two simulated devices in different orders (after sorting by causal+ts+id), assert identical projections.
4. **Two-device convergence.** Device A authors 200 events. Device B comes online. B folds, materializes the swarm view from log alone, requests pieces in rarest-first order, ends with same projection as A within 5s.
5. **Three-device redundancy.** A, B both author 100 events while offline from each other. C joins fresh. C ends with all 200 events; verify SYN events on `piece:*` materialize for pieces delivered by both A and B.
6. **Hash divergence test.** Inject a bad-byte peer. Assert: DEF materializes; EVA blacklists peer for that piece; REC propagates; INS from another peer resolves DEF.
7. **All-peers-bad fallback.** All swarm peers return bad bytes. Assert REC on piece:* with recognized="unrecoverable_pending_author" materializes. When author returns, assert author's scheduler prioritizes serving this piece (because it folds the REC).
8. **Reputation propagation.** Three devices independently REC peer Q for failures. Assert SYN on peer:Q with synthesized="cross_device_unreliability" materializes on a fourth device that observes all three RECs.
9. **Schema-version coexistence.** Mix v1 and v2 SEGs in a swarm. Assert both fold without conflict; assert v2-aware devices serve both; assert v1-only devices ignore v2.
10. **Partition heal.** Split swarm at t=100; let each half emit for 60s; rejoin; assert convergence within 30s including DEF materialization for any concurrent SIG/EVA conflicts.
11. **Tab background.** Worker continues sync while tab backgrounded.
12. **Rate limit (token bucket).** Single peer floods; assert other peers' requests still served.
13. **Self-recognition.** Device Q observes its own REC arriving in fold (via cross-device propagation); assert Q's scheduler responds (e.g., reverifies local pieces).

Tests 6–8 and 10 are the operator-native tests; they have no analog in v2.

---

## 12. Migration

v2 plan is replaced wholesale. The feature flag `VITE_NETWORK_SYNC_WORKER=2` selects the operator-native worker; older flags select legacy `peer-sync.ts`. Both v2 and operator-native cannot run simultaneously on the same room (they would race to fold). Worker startup checks the flag and refuses to start the wrong kind.

`peer-sync.ts` and `transport-router.ts` remain in the codebase for one release cycle behind the flag, then removed.

---

## 13. The deeper claim, restated

If this works, the framework is operational at the system level, not just the data level. The fold processing CON edges between cases and defendants is the same fold processing CON edges between peers and piece-slots. The Horizon rendering "pieces in DEF" is the same Horizon rendering "evictions in DEF." The scheduler reading projected state is reading the same projection that the UI is reading.

There is no sync subsystem. There is one log, one fold, one projection. Sync is an aspect of the system disclosing itself.

This is the spec. The implementation prompt below builds it.

# Implementation Prompt: EO-Native Sync Layer

You are implementing a sync layer for EO///DB where every meaningful sync action is an EO event, processed by the same fold as application data. Read `SPEC-operator-native-sync.md` in full before starting. This prompt assumes you've read it.

This replaces the v2 BitTorrent sync plan entirely. There is no per-piece "bitfield" data structure, no separate "swarm view," no separate "blacklist." All of that is projected state from EO events on `swarm:*`, `peer:*`, `log:*`, `piece:*`, and `tail:*` sites.

---

## Repo and conventions

- Repo: `github-matrix-dev/app`
- Run typecheck after every code change: `cd github-matrix-dev/app && npx tsc -b --noEmit`. It must pass before committing. (Per `CLAUDE.md`.)
- Test runner: whatever is already in `package.json`. Use it; don't introduce a new framework.
- Style: match the existing codebase. Don't reformat unrelated code.
- Commit hygiene: small, focused commits. Each commit must typecheck and pass existing tests.

---

## Build order

Build in this exact order. Each phase must be fully working and tested before the next begins. Do not skip ahead.

### Phase 1 — Operator schema and projection module (no I/O yet)

**Goal:** define the operator events and the projection that materializes from them. Pure functions only. No worker, no Matrix, no WebRTC.

Create:

- `src/sync/sites.ts` — site naming helpers: `swarmSite(roomId)`, `peerSite(userId, deviceId)`, `logSite(authorDeviceId)`, `pieceSite(authorDeviceId, pieceIndex, schemaVersion=1)`, `tailSite(authorDeviceId)`. Each returns the canonical string. Include parsers: `parsePieceSite(s) -> {authorDeviceId, pieceIndex, schemaVersion}`. All site strings are case-sensitive and use `/` and `|` separators per spec §2.

- `src/sync/operators.ts` — TypeScript discriminated union for sync-layer events. One type per (operator, site-family) pair listed in spec §3. Each carries a `resolution` typed strictly to its row in the spec table. Export a type guard `isSyncEvent(event: EoEvent): boolean` based on whether the site matches one of the sync site families.

- `src/sync/projection.ts` — pure functions that fold sync events into projected state. Export:
  ```ts
  interface SyncProjection {
    swarm: SwarmProjection;        // from swarm:*
    peers: Map<PeerId, PeerProjection>;  // from peer:*
    logs: Map<AuthorDeviceId, LogProjection>;  // from log:*
    pieces: Map<PieceSite, PieceProjection>;   // from piece:*
    tails: Map<AuthorDeviceId, TailProjection>; // from tail:*
  }

  function applyEvent(proj: SyncProjection, event: EoEvent): SyncProjection;
  function emptyProjection(): SyncProjection;
  ```
  `applyEvent` is pure: `(proj, event) -> newProj`. Use immutable updates (spread or immer). Each PieceProjection has a derived `status: "absent" | "signaled" | "requested" | "in_def" | "instantiated" | "swarm_attested" | "unrecoverable"` computed from the events on that site.

- `src/sync/derived.ts` — functions that compute derived events (DEF, SYN) from observed states. Export:
  ```ts
  function computeDefEvents(proj: SyncProjection): EoEvent[];  // emit DEF when concurrent SIGs on same piece site disagree on hash
  function computeSynEvents(proj: SyncProjection, threshold: number): EoEvent[];  // emit SYN on piece when N independent verifying INSs accumulate
  function computeRecognitionEvents(proj: SyncProjection): EoEvent[];  // emit RECs for unrecoverable pieces, peer patterns, swarm health
  ```
  These are called by the projection-driver (Phase 4) and emitted into the log via the normal emit path.

**Tests for Phase 1** (`src/sync/__tests__/`):

- `sites.test.ts` — round-trip parse and stringify; reject malformed sites.
- `operators.test.ts` — type guards correctly classify events.
- `projection.test.ts` — for each (operator, site-family) handler:
  - Idempotence (applying same event twice = applying once).
  - MVR semantics on concurrent EVA on same field (both values present).
  - LWW semantics where specified.
  - Correct status transitions on PieceProjection.
  - Authority rule: SEG with `origin_device_id !== authorDeviceId` is dropped.
- `derived.test.ts` — for each derived-event type, hand-construct a projection and assert correct derived events emitted.
- `fold-determinism.test.ts` — generate 10K random sync events, fold in 5 different orders (after sorting by causal+ts+id), assert identical final projections.

Phase 1 is complete when all tests pass and `npx tsc -b --noEmit` is clean. Commit.

### Phase 2 — Scheduler as pure function

**Goal:** the scheduler reads projected state and produces intents. No state of its own.

Create:

- `src/sync/scheduler.ts` — pure function:
  ```ts
  interface SchedulerInput {
    projection: SyncProjection;
    inFlight: Map<PieceSite, Set<PeerId>>;  // computed from in-flight intents the worker is tracking; not persistent
    myDeviceId: string;
    myUserId: string;
    knobs: SchedulerKnobs;
  }

  interface SchedulerKnobs {
    inFlightPerPeer: number;          // default 4
    maxConcurrentPeers: number;       // default 4
    endgameThreshold: number;         // default 5
    requestTimeoutFirstMs: number;    // default 15000
    requestTimeoutSubsequentMs: number; // default 10000
    seedTokenBucketRefillPerSec: number; // default 10
    seedTokenBucketBurst: number;     // default 20
    seedGlobalConcurrencyCap: number; // default 16
  }

  type SchedulerIntent =
    | { kind: "request_piece_bytes"; peer: PeerId; pieceSite: string; expectedHash: string }
    | { kind: "request_tail_events"; peer: PeerId; tailSite: string; fromSeq: number }
    | { kind: "cancel"; peer: PeerId; reqId: string };

  function schedule(input: SchedulerInput): SchedulerIntent[];
  ```
  Implement: rarest-first ranking, per-peer in-flight cap, peer eligibility check (read from `peerProjection.eligibility`), endgame fan-out when total missing < threshold, escalation to authoring device when all swarm peers are blacklisted for a piece.

**Tests for Phase 2** (`src/sync/__tests__/scheduler.test.ts`):

- Empty projection → no intents.
- Single missing piece, single eligible peer → single request intent.
- Single missing piece, no eligible peers → no intent.
- Multiple missing pieces → ordered by rarest-first.
- Endgame: when missing < threshold, fan out to multiple peers per piece.
- Blacklist respected (eligibility = blacklisted_until_T).
- Authoring-device escalation when all peers blacklisted.
- In-flight cap respected per peer.
- Determinism: same input → same intents (no random tiebreak that varies; use deterministic random from a seed in input if needed).

Phase 2 is complete when all tests pass. Commit.

### Phase 3 — Hash and verification helpers

**Goal:** verify incoming piece bytes against expected hash; no I/O.

Extend `src/db/hash.ts`:
- Add `pieceHash(events: EoEvent[]): Promise<string>` — canonical msgpack encoding (verify which msgpack lib is used; if the project doesn't use canonical msgpack, document this and either switch to one that supports canonicalization or implement a small wrapper that sorts map keys before encoding). SHA-256 of bytes, hex-encoded.
- Add `verifyPieceBytes(events: EoEvent[], expectedHash: string): Promise<boolean>`.

Tests in `src/db/__tests__/hash.test.ts`:
- Same events → same hash, regardless of object key declaration order.
- Different events → different hash.
- verifyPieceBytes catches mismatch.

Phase 3 is complete when tests pass. Commit.

### Phase 4 — The worker (replaces v2 worker)

**Goal:** long-lived dedicated worker that runs the projection driver and scheduler.

Create:

- `src/workers/network-sync.worker.ts` — worker entry. Owns a `SyncProjection`. On every inbound event from the main thread, applies it to the projection and re-runs the scheduler. Emits commands to the main thread.

- `src/sync/network-sync-client.ts` — main-thread client that talks to the worker. Exposes:
  ```ts
  interface NetworkSyncClient {
    start(initial: { roomId: string; myDeviceId: string; myUserId: string; seedEvents: EoEvent[] }): Promise<void>;
    stop(): Promise<void>;
    onCommand(handler: (cmd: WorkerCommand) => void): void;  // worker → main
    reportFoldedEvent(event: EoEvent): void;                  // main → worker
    reportInboundControl(msg: ControlMessage, fromPeer: PeerId): void;
    reportInboundBulk(msg: BulkMessage, fromPeer: PeerId): void;
    reportPeerJoin(peer: PeerId): void;
    reportPeerLeave(peer: PeerId): void;
    reportDcState(peer: PeerId, state: "open" | "closed" | "error"): void;
  }

  type WorkerCommand =
    | { kind: "send_control"; peer: PeerId; msg: ControlMessage }
    | { kind: "send_bulk"; peer: PeerId; msg: BulkMessage; preferTransport: "rtc" | "matrix" }
    | { kind: "open_dc"; peer: PeerId }
    | { kind: "close_dc"; peer: PeerId }
    | { kind: "emit_eo_event"; event: EoEvent }   // worker computed a derived event (DEF/SYN/REC); main thread submits it via Matrix timeline
    | { kind: "read_piece_events"; reqId: string; pieceSite: string };  // worker needs OPFS data; main reads and reports back
  ```

- `src/sync/network-sync-bridge.ts` — glue. Wires the client to the existing `MatrixClient`, `WebRTCPeer`, and `EoStore`. Translates worker commands into actual I/O.

The worker on each tick:
1. Receives any new events via `reportFoldedEvent` (these come from the main fold; the main fold processes both application and sync events).
2. Updates its own copy of the projection.
3. Runs `computeDefEvents`, `computeSynEvents`, `computeRecognitionEvents` to detect any newly-derivable RECs/DEFs/SYNs. Emits `emit_eo_event` commands for any new ones. Track which derived events have already been emitted to avoid duplicates (use `client_event_id` stable hash of derivation inputs).
4. Runs `schedule()` to determine which control messages to send.
5. Issues `send_control` / `send_bulk` / `open_dc` commands as needed.

On inbound bulk (piece bytes):
1. Verify hash via `verifyPieceBytes`.
2. If match: command main thread to fold the events (existing fold path); after fold confirms, the resulting INS event will come back via `reportFoldedEvent` and update projection.
3. If mismatch: emit an `EVA` on `peer:*` blacklisting the peer for that piece; emit a `REC` on `peer:*` recognizing the failure pattern. Both are submitted via `emit_eo_event`.

On inbound control (request_piece_bytes from a peer):
1. Check token bucket for that peer.
2. Issue `read_piece_events` to main thread; main reads from OPFS, returns events.
3. Worker hashes the events, confirms it matches what was requested, and issues `send_bulk` with the events.

**Tests for Phase 4** (`src/workers/__tests__/network-sync.worker.test.ts`):

- Worker can be instantiated and started in a test environment (use `worker_threads` shim or similar).
- Round-trip: feed worker an event, observe it in scheduler output.
- Worker emits derived events (DEF) when concurrent SIGs disagree.
- Worker correctly handles inbound bulk verification (good and bad bytes).

Phase 4 is complete when tests pass. Commit.

### Phase 5 — Wire up and replace

**Goal:** integrate the new worker into the app, behind a feature flag, replacing v2.

- Extend `src/lib/matrix-domain.ts` with the `com.eo-db.swarm.v2` to-device event type and control/bulk message schemas (per spec §4).

- Extend `src/matrix/webrtc-peer.ts` with the new bulk frame types (`piece_bytes`, `tail_bytes`). Reuse the existing chunking/reassembly state machine.

- Modify `src/components/Layout.tsx` (lines ~1794–1810): add a feature-flag check:
  ```ts
  const useOperatorSync = (import.meta.env.VITE_NETWORK_SYNC_WORKER === "2") ||
                         (localStorage.getItem("eo.sync.mode") === "operator");
  if (useOperatorSync) {
    const netSync = createNetworkSyncClient({ client, room, store, webrtcPeer });
    await netSync.start({ roomId, myDeviceId, myUserId, seedEvents });
  } else {
    // existing PeerSync path
  }
  ```

- Critically: the main fold (`fold.worker.ts`) must now process sync-layer events the same way it processes application events. No special path. The fold's existing operator handlers don't change; they just operate over additional sites.

- Ensure the two protocols (legacy peer-sync and operator-native) cannot run simultaneously on the same room. Worker startup checks the flag and refuses if the wrong worker is already running.

**Tests for Phase 5** — full integration tests:

- Two-browser test (manual): two profiles, same user, same space. A authors 200 events offline. B comes online. B's projection (queried via debug endpoint) materializes the swarm view, requests pieces in rarest-first order, ends with the same projection as A within 5s.
- Three-device redundancy: A and B both author 100 disjoint events while offline. C joins fresh. C ends with all 200 events; assert SYN on `piece:*` materializes for the pieces.
- Hash divergence: inject a peer that returns wrong bytes. Assert DEF materializes; EVA blacklists the peer; INS from another peer resolves DEF; REC propagates.
- All-peers-bad fallback: all peers return bad bytes. Assert REC with `recognized="unrecoverable_pending_author"` materializes. When author returns online, assert author folds the REC and prioritizes serving.
- Reputation propagation: three devices REC peer Q for failures; fourth device folds and materializes SYN on `peer:Q` with `synthesized="cross_device_unreliability"`.
- Schema-version coexistence: mix v1 and v2 SEGs in a swarm; assert both fold; v2-aware devices serve both.
- Partition heal: split swarm at t=100; both halves emit; rejoin at t=160; assert convergence with proper DEF materialization for conflicts.
- Tab background: backgrounded tab continues to fold, emit, and serve.
- Token bucket: one peer floods; other peers' requests still served.

Phase 5 is complete when integration tests pass. Commit.

---

## Critical correctness invariants

These must hold at all times. If any test or code path violates them, stop and fix before proceeding.

1. **The projection is a pure function of the log.** No mutable worker-internal state outside the projection. The scheduler reads from projection only.
2. **Determinism.** Two devices with the same log produce the same projection. Tested by `fold-determinism.test.ts`.
3. **Authority rule for SEG.** A SEG event is valid only if `origin_device_id === authorDeviceId` parsed from its site. Invalid SEGs are dropped at fold time, not silently accepted.
4. **Idempotence.** Replaying any event has no effect. INSs deduped by `(site, content_hash)`. SIGs deduped by `(site, advertised_by, expected_hash)`. Derived events (DEF/SYN/REC) deduped by stable `client_event_id` hash of their derivation inputs.
5. **Two protocols cannot run simultaneously on the same room.** Worker startup enforces this.
6. **Verify before fold.** Bytes received from any peer are hash-verified before being handed to the fold worker. No exceptions.
7. **Control messages are ephemeral.** They do not enter the EO log. Only the resulting INSs/EVAs/RECs do.

---

## Things to avoid

- Do not introduce a separate piece-table data structure outside the projection. The projection is the piece table.
- Do not introduce a separate bitfield. The projection is the bitfield (queryable as: which `piece:*` sites have an `instantiated`+ status?).
- Do not introduce a separate blacklist data structure. Blacklist state is EVA on `peer:*` with `field: "eligibility_for[piece_site]"`.
- Do not emit NUL events. NUL is conceptual ground (the worker filters out non-sync events) but emitting NULs would be infinite.
- Do not recompute DEF or SYN from scratch on every tick. Track which derived events have been emitted (by stable client_event_id) and only emit new ones.
- Do not let the worker hold mutable state that isn't derived from the log. The only mutable worker state is the projection itself (which is derived) and the in-flight tracking map (which is short-lived bookkeeping for outbound requests, cleared on response/timeout).

---

## When you finish each phase

Report:
1. Phase complete.
2. Test summary: N tests pass, M files added/modified.
3. Any places where the spec was ambiguous and you made a judgment call. Cite the call and ask whether to revise the spec.
4. Any places where the spec was contradicted by an implementation reality (e.g., a library limitation). Cite the contradiction and ask how to resolve.

Do not proceed to the next phase without that report.

---

## When you finish all five phases

Final deliverables:
1. All phases committed and passing.
2. `docs/sync-operator-native.md` summarizing the implementation, deviations from spec, and any follow-up work identified.
3. Updated `CLAUDE.md` (or equivalent) with the feature flag and how to enable it for development.
4. A short demo script: a `pnpm test:sync:demo` (or equivalent) that spins up two simulated devices in-process, exercises a partition+heal, and prints the resulting projections side-by-side to demonstrate convergence.

---

## What to ask if anything is unclear

Before starting, confirm:
1. The msgpack library currently used (for canonical hashing in Phase 3). If non-canonical, propose a fix.
2. The existing test framework name and conventions.
3. The location and format of `CLAUDE.md` or equivalent contributor guide for commit hygiene rules.
4. Whether the existing fold worker can be extended in-place to handle sync-site events, or whether a separate fold instance is preferred. (The spec assumes in-place extension.)
5. Whether `worker_threads` shim or some other mechanism exists for testing the worker outside a browser.

If any of these are blocking, stop and ask before writing code.
