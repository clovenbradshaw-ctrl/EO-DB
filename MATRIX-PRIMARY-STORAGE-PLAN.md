# EO///DB → Matrix-Primary Storage Migration Plan (v2)

**Status:** DRAFT — incorporates Phase 0 code audit findings
**Date:** 2026-05-14
**Author:** Michael Lacy (v1), revised after codebase audit
**Branch:** `claude/matrix-primary-storage-DpWoQ`

---

## What Changed From v1

The v1 plan was written from architectural intent, not from a line-by-line audit. After auditing the actual codebase, several assumptions turned out to be wrong or incomplete. The most consequential corrections:

1. **Local seq allocation is the gating decision.** `db/fold-core.ts` uses a `SeqReservoir` to assign `seq` numbers locally. If Matrix becomes canonical, two offline devices will collide. v1 didn't address this. **New Phase 0.5** below.
2. **Snapshots already exist and are sophisticated.** `matrix/snapshot.ts` does delta snapshots with `prev_mxcs` chains, parallel batch fetch, state-event head pointers, and lease-based exclusive-writer claims. Today they upload to **Google Drive via n8n**, not Matrix media. Phase 1 is *transport switch + extension*, not greenfield.
3. **Custom event types already exist.** `matrix/event-bridge.ts` uses `com.eo-db.{prefix}` and a family of `EO_*_TYPE` constants. v1's `m.eodb.*` names need to reconcile with this namespace.
4. **State events are already used extensively.** Snapshot pointers, claim leases, governance, block heads, airtable cursors. "Use state events for canonical pointers" is already the established pattern.
5. **Phase 5 (blobs) is a transport switch.** Content addressing (SHA-256), AES-256-GCM, and gzip already exist in `storage/eodb-blob-writer.ts`. The 1GB Amino limit is what makes switching from Drive to Matrix media viable.
6. **Phase 4 (signing) has zero existing infrastructure.** `crypto/key-delivery.ts` distributes AES encryption keys, not signing keys. Use matrix-js-sdk **cross-signing** (MSC1756), not raw device keys, so signatures survive device rotation.
7. **WebRTC chunked transfer is already wired.** `matrix/webrtc-peer.ts` has resumable chunked frames with `transfer_id` + `received_chunks`. Phase 5 P2P fast path is much easier than v1 assumed.
8. **Yjs is explicitly carved out.** Rich-text collab documents remain local-first + P2P (`collab/yjs-matrix-provider.ts` + IndexedDB persistence). Not part of this migration.
9. **Fold cache + horizons must be in snapshot payloads.** `db/fold-cache.ts` (`_fold: { trajectory, trajectoryFingerprint, cadence }`) and `db/addressing-horizon.ts` state must be included, or fresh clients pay a full re-fold cost on hydrate.

---

## The Core Architectural Move (unchanged from v1)

Today: OPFS is the source of truth, Matrix is a sync transport.
Target: **Matrix rooms are the canonical append-only log; OPFS is a local materialized view.**

```
Write:  UI → Zustand action → MatrixStore.put() → HS confirms → /sync → OPFSCache.write() → Zustand patch
Read:   OPFS (hydrated on startup, patched live)
Cold:   Fetch latest snapshot state event → download mxc blob → replay tail → hydrated
```

**Why now:** the Amino homeserver at `app.aminoimmigration.com` now supports uploads up to 1 GB and has no cap on room notification volume. Both were prerequisites.

---

## Existing Systems To Reuse (Not Reinvent)

| System | File | What it already does | What changes |
|---|---|---|---|
| Custom event types | `matrix/event-bridge.ts` | `com.eo-db.{prefix}` timeline events; `EO_*_TYPE` state events | Bump schema version; add fields, don't rename |
| Delta snapshots | `matrix/snapshot.ts` | `prev_mxcs` chain, parallel fetch, state-event head pointer, lease-based claim | Switch upload target from `gdrive://` to `mxc://`; include fold-cache + horizon in payload |
| Blob envelope | `storage/eodb-blob-writer.ts` | SHA-256 content addressing, AES-256-GCM, gzip, n8n→Drive | Add a Matrix media backend behind the same interface; keep envelope identical |
| State events | (extensive) | Snapshot URI, snapshot claim lease, block head, governance, airtable cursor | Add: log cursor (per-room), schema version pin, device roster |
| Fold engine | `db/fold-core.ts`, `db/fold-cache.ts`, `db/log-index.ts` | Lazy materialized views, 9-op index, prefix trie, intersection cache, deterministic rebuild from log | Must tolerate non-dense seq if Phase 0.5 picks option (a) or (b) |
| WebRTC chunked transfer | `matrix/webrtc-peer.ts` | Resumable framed transfer with `transfer_id` + `received_chunks`, msgpack, keepalive | Wire blob chunks through the existing bulk-frame handler |

**Explicit non-goal:** Yjs documents (`collab/yjs-matrix-provider.ts`, `collab/yjs-persistence.ts`) remain local-first + P2P + IndexedDB. They are not migrated.

---

## Event Schema (Reconciled)

Three timeline event shapes and two state event shapes, named to extend — not collide with — the existing `com.eo-db.{prefix}` namespace and `EO_*_TYPE` family.

### Timeline: `com.eo-db.mutation` (extension of existing `EO_EVENT_TYPE`)

```jsonc
{
  "type": "com.eo-db.mutation",
  "content": {
    "v": 2,
    "id": "rec_a1b2c3",
    "op": "CON",                       // NUL|DES|INS|SEG|CON|SYN|DEF|EVA|REC
    "resolution": "merge",
    "site": "cases.plaintiff",
    "site_hash": "1234567890abcdef",   // xxHash64 hex, matches log-opfs.ts IndexRecord.siteHash
    "payload": { /* inline if < 48 KB */ },
    "blob": {                          // present iff payload exceeded inline threshold
      "mxc": "mxc://amino/sha256-...",
      "sha256": "...",
      "size": 284910,
      "enc": { "key": "...", "iv": "...", "tag": "..." }
    },
    "seq": "<see Phase 0.5>",          // shape depends on seq-allocation decision
    "prev_hash": "sha256:...",         // hash of previous mutation observed by this writer
    "sig": "ed25519:DEVICEID:..."      // cross-signing user signature (see Phase 4)
  }
}
```

Authorship comes from the Matrix `sender` field (consistent with current `event-bridge.ts:68-69`); the `sig` field provides cryptographic provenance independent of HS trust.

### Timeline: `com.eo-db.blob_manifest` (new)

```jsonc
{
  "type": "com.eo-db.blob_manifest",
  "content": {
    "v": 1,
    "id": "blob_petition_draft",
    "chunks": [
      { "mxc": "mxc://amino/c0", "sha256": "...", "size": 52428800, "order": 0 },
      { "mxc": "mxc://amino/c1", "sha256": "...", "size": 52428800, "order": 1 }
    ],
    "total_sha256": "...",
    "total_size": 104857600,
    "enc": { "key": "...", "iv": "...", "tag": "..." },
    "mime": "application/pdf"
  }
}
```

With 1 GB upload caps, chunking is rare but the manifest type is the resumable path for very large objects.

### State: `com.eo-db.snapshot` (extends existing `EO_SNAPSHOT_STATE_TYPE`)

```jsonc
{
  "type": "com.eo-db.snapshot",
  "state_key": "cases",
  "content": {
    "v": 2,
    "uri": "mxc://amino/snapshot-xyz",   // was "gdrive://..."; both must be readable during transition
    "sha256": "...",
    "enc": { "key": "...", "iv": "...", "tag": "..." },
    "from_seq": 9501,                    // delta semantics, matches current snapshot.ts
    "to_seq": 10000,
    "prev_mxcs": ["mxc://...", "..."],   // chain to older deltas (up to 25)
    "at_event": "$eventId",
    "fold_cache_included": true,         // NEW: payload includes _fold annotations
    "horizon_included": true,            // NEW: payload includes AddressingHorizon + DeclaredHorizon
    "record_count": 1842,
    "schema_v": 2,
    "created": "2026-05-14T..."
  }
}
```

`uri` is intentionally scheme-prefixed so the transition period can serve both Drive and Matrix media blobs.

### State: `com.eo-db.log_cursor` (new)

```jsonc
{
  "type": "com.eo-db.log_cursor",
  "state_key": "",
  "content": {
    "v": 1,
    "head_event_id": "$abc",
    "head_seq": "<see Phase 0.5>",
    "device_id": "DEVICEID"
  }
}
```

Per-device cursor for cheap "am I caught up?" checks. Optional; replay can derive from sync token.

### State: `com.eo-db.schema` (extends existing `EO_SCHEMA_TYPE`)

Unchanged from v1 spec — already partially in use.

---

## Room Topology (Amino)

| Room | Purpose | Event types |
|---|---|---|
| `#amino-clients` | Client/contact records | `mutation`, `snapshot`, `schema`, `log_cursor` |
| `#amino-cases` | Case records | `mutation`, `snapshot`, `schema`, `log_cursor` |
| `#amino-documents` | Large files | `mutation`, `blob_manifest`, `snapshot` |
| `#amino-schema` | Schema registry / migration log | `schema` (state only) |
| `#amino-audit` | Cross-collection audit trail | `mutation` (read-only for most) |

Room membership = access control. Invite-only. Megolm on all.

---

## Phase 0.5: Seq Allocation Decision (NEW — gates everything else)

`db/fold-core.ts` allocates `seq` locally via `SeqReservoir`. `db/log-opfs.ts` writes `seq` into the fixed-stride `eodb.idx`. Two offline devices will produce the same `seq`. Three resolutions:

### Option (a): Drop local seq; derive total order from Matrix

- Use `(origin_server_ts, sender, event_id)` lexicographic ordering as the canonical order.
- Rewrite `log-opfs.ts` to be addressable by `event_id` and time-ordered, not seq-indexed.
- Rebuild `log-index.ts` and `fold-core.ts` to tolerate sparse / non-monotonic ordering keys.
- **Pro:** clean, no allocator. **Con:** largest blast radius; touches the fold engine.

### Option (b): Device-scoped seq; treat the log as a DAG

- `seq` becomes `{deviceId}:{localSeq}`. Each device has its own monotonic local seq.
- Fold engine becomes DAG-ordered, with deterministic tiebreak `(localSeq, deviceId)`.
- Snapshots include per-device `head_seq` maps.
- **Pro:** preserves local-write semantics; smallest fold-engine change. **Con:** every consumer of `seq` (index, snapshot, blob writer) needs to understand the compound key.

### Option (c): Lease-based seq broker on the HS

- Single writer at a time holds the snapshot claim (already implemented in `snapshot.ts:141-174`); generalize to a seq lease.
- Writers reserve ranges, hand back unused.
- **Pro:** minimal code change. **Con:** offline writes are blocked or buffered indefinitely, defeating offline-first.

**Recommendation:** Option (b). Preserves offline-first semantics, smallest fold rewrite, and the existing `prev_hash` chain remains meaningful inside each device's lineage. Decision must be made before Phase 1.

---

## Migration Phases

### Phase 0: Code Review (done — see audit findings in this doc's header)

### Phase 0.5: Seq Allocation Decision (above)

### Phase 1: Snapshot Transport Switch + Schema Extension

**Goal:** Move snapshots from Google Drive to Matrix media; include fold cache + horizon in the payload; reconcile event schema.

- Add a Matrix-media backend behind the existing `EodbBlobWriter` interface. Selection between `gdrive://` and `mxc://` is configurable per room. Existing envelope (SHA-256 + AES-256-GCM + gzip) is unchanged.
- Extend `matrix/snapshot.ts` delta-snapshot payload to include:
  - Materialized fold-cache annotations (`_fold: { trajectory, trajectoryFingerprint, cadence }`) per record
  - `AddressingHorizon` + `DeclaredHorizon` checkpoint state
- Bump snapshot state event schema to `v: 2`; readers must handle both v1 (Drive-only, no cache) and v2.
- Reconcile event type names: `com.eo-db.{prefix}` for mutations stays, add new fields under `v: 2`. Update `event-bridge.ts` to emit/parse the new fields.
- **Do not change the write path yet.** Writes still go to OPFS first. This phase is read-side only.

**Deliverable:** A new client joining a room hydrates from a Matrix-media snapshot + tail in under 10 s for a 10K-record collection, with fold-cache populated (no full re-fold on first query).

### Phase 2: OPFS as Materialized View

**Goal:** Flip the read path so OPFS is explicitly a cache.

- Refactor consumers of `log-opfs.ts` so the log file is treated as rebuildable from Matrix at any time.
- Implement a `SyncEngine` (Web Worker) that:
  - On startup: read snapshot state event → if cursor stale or absent, hydrate from snapshot + tail → otherwise replay from cursor.
  - Subscribes to `/sync`, materializes each `com.eo-db.mutation` into OPFS, patches Zustand via `postMessage`.
  - Owns the `com.eo-db.log_cursor` state event (writes after every batch).
- Zustand: remove direct OPFS writes from actions; actions now optimistically patch local state and call `MatrixStore.putMutation()`. Pending mutations are marked `pending` until confirmed via `/sync`. Conflict resolution: sync version wins.

**Deliverable:** App works identically from the user's perspective, but `rm -rf` of OPFS recovers fully on next load.

### Phase 3: Flip the Write Path (Commitment Point)

**Goal:** Matrix is the sole write target. OPFS is never written to by user actions.

- All writes go through `MatrixStore.putMutation()`. The SyncEngine is the only OPFS writer.
- **Offline write queue (new):** when disconnected or send fails, writes append to `/_pending/` in OPFS as a WAL with the device-scoped seq from Phase 0.5. On reconnect, flush in `(localSeq)` order. Matrix event order is canonical once they land.
- Conflict semantics: under option (b) seq, two offline devices' writes always merge by the EO operator rules (CON, INS, DEF) — no `prev_hash` collisions because each device chains its own lineage.
- Remove legacy write paths from `log-opfs.ts` and `event-bridge.ts`.

**Deliverable:** `grep -r "opfsCache.write\|appendEvent" src/` returns hits only inside `SyncEngine` and the offline-queue flusher.

### Phase 4: Cross-Signing for Authorship Provenance

**Goal:** Cryptographic proof of which *user* wrote each mutation, surviving device rotation.

- Adopt matrix-js-sdk **cross-signing** (MSC1756). Each user has a master signing key; devices are signed by it. Old device signatures remain verifiable after rotation via the master key.
- Pre-encryption: compute `sha256(canonical_json(content minus sig))`. Sign with the current device's signing key. Embed `sig`.
- On read: verify signature against device key, walk cross-signing chain back to master, mark record `sig_verified: bool` in OPFS materialization.
- **New crypto code lives alongside** `crypto/key-delivery.ts` and `crypto/keyring-store.ts` (which remain for AES-GCM encryption keys); the two systems are independent.

**Deliverable:** Every mutation has a cryptographic provenance chain to a user master key, verifiable by any room member without trusting the homeserver.

### Phase 5: Blob Transport Switch + Chunking + P2P Fast Path

**Goal:** Make Matrix media the canonical blob store; reuse the WebRTC layer for online-online transfers.

- Default new blobs to `mxc://` via the Matrix backend added in Phase 1. Keep `gdrive://` readable indefinitely for backward compatibility.
- Chunked upload: split blobs > 500 MB into 256 MB chunks (well under Amino's 1 GB cap, headroom for envelope overhead), emit `com.eo-db.blob_manifest`. Reuse the SHA-256 + AES-GCM envelope per chunk.
- P2P fast path: when a peer with the blob is online, serve chunks via `webrtc-peer.ts`'s existing bulk-frame handler. The `mxc://` URL is the durable fallback. Discovery via Matrix presence + room membership.

**Deliverable:** A 500 MB document uploads to Matrix media, syncs to a second device, and downloads — preferring the P2P path when both devices are online.

### Phase 6: Compaction + Room Upgrades

**Goal:** Bound timeline growth; establish the schema-migration boundary.

- Compaction: when a room exceeds 50K events, create a new room with a full-state genesis snapshot, tombstone the old room (`m.room.tombstone`) pointing to the new one.
- Clients follow tombstones automatically: join the new room, hydrate from its genesis snapshot.
- Schema versioning: `v` field in event content; bumps happen at room-upgrade boundaries.

**Deliverable:** A 100K-event room can be compacted; a fresh client joining the upgraded room hydrates in under 10 s.

---

## What This Gets You (unchanged from v1)

- Multi-device sync, offline-first reads, immutable audit trail, room-membership-based ACL, E2EE at rest + in transit, EO-native event log, cryptographically verifiable authorship without consensus overhead.

---

## Known Risks and Open Questions

- **Phase 0.5 decision dominates.** All later phases assume option (b). If you pick (a) or (c), reorder.
- **Synapse Postgres growth.** Phase 6 compaction must be automated, not manual.
- **E2EE kills server-side search.** Already mitigated by `log-index.ts` + fold engine; load-test under realistic query volume before Phase 3.
- **`/sync` overhead.** Sliding sync (MSC3575) would help; check Synapse support on Amino.
- **matrix-js-sdk buffers media downloads in memory.** For 1 GB blobs, bypass the SDK and hit `/_matrix/media/v3/download` directly with streaming `fetch()`.
- **Snapshot delta chain traversal cost.** Current code batch-fetches `prev_mxcs` in parallel (`snapshot.ts:374-386`). With Matrix media instead of Drive, latency profile shifts; verify before Phase 1 ships.
- **Drive-era snapshots must remain readable** during transition. Don't break v1 readers.
- **Yjs is out of scope.** If a future requirement says "Yjs docs should also live in Matrix canonical," that's a separate plan.

---

## Recommended Starting Point

1. **Phase 0.5** — pick seq allocation. Half a day of design, no code.
2. **Phase 1** — snapshot transport + schema extension. Read-side only, low risk.
3. **Phase 2** — OPFS-as-cache. Refactor; no behavior change.

These three prove the architecture without flipping writes. **Phase 3 is the commitment point.** Everything after Phase 3 is hardening and optimization.
