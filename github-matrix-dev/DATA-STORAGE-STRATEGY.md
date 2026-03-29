# EO///DB — Data Storage Strategy for Fast Hydration

> **Recommendation**: Strategy B (Matrix Media Store + Room Index) with three targeted optimizations. It is already implemented, aligns with the zero-server-dependency architecture, and scales to the target range of 100K events. Strategy C (external object store) should remain a future Tier 3 escape hatch for disaster recovery, not primary hydration.

---

## 1. Problem Statement

When a new device opens EO///DB for the first time (seq === 0), it must reconstruct the complete database state — projected values, graph edges, EVA registrations — before the user can work. This is the **cold-start hydration** problem.

The hydration path determines:
- How long a user waits on a new device before seeing data
- How much network bandwidth is consumed
- How resilient the system is to homeserver outages
- How much operational complexity the team maintains

Three candidate strategies are evaluated below.

---

## 2. Current State

### Hydration Flow (implemented in `snapshot.ts` + `sync-manager.ts`)

```
Fresh device (seq === 0)
  1. Authenticate against Matrix homeserver
  2. Derive AES-GCM key via PBKDF2(accessToken, userId:deviceId)
  3. Resolve #amino-data room
  4. Paginate room timeline backwards to find latest eo.snapshot event
  5. Download binary snapshot from mxc:// URL
  6. Deserialize (msgpack unpack) → bulk-write state/graph/eva to IndexedDB
  7. Set sync cursor to snapshot seq
  8. Sync room timeline from snapshot seq → current (fold tail events)
  9. Listen for real-time events going forward
```

### Current Performance (from DEVELOPMENT-STAGES.md)

| Scale | Events | Snapshot Size | Snapshot Hydration | Full Replay (no snapshot) |
|-------|--------|---------------|--------------------|---------------------------|
| Small | < 1K | 100–500 KB | < 1 sec | < 500 ms |
| Medium | 1K–10K | 1–5 MB | 1–3 sec | 2–10 sec |
| Large | 10K–100K | 10–50 MB | 5–15 sec | 30–120 sec |
| Very Large | 100K+ | 100–500 MB | Minutes | Minutes+ |

### What Works

- **Local-first fold** is instant — users never wait for network on writes
- **Snapshot hydration** avoids full replay for new devices
- **Offline queue** with `client_event_id` deduplication handles connectivity gaps
- **msgpack binary** is compact and fast to serialize/deserialize

### What Could Be Better

- **Finding the latest snapshot** requires paginating the room timeline backwards — O(n) in room event count, slow if the snapshot event is buried deep
- **Full-state snapshots** scale linearly — a 100K-event database produces a 10–50 MB snapshot every 1000 events, even if only 50 records changed
- **No compression** on snapshot blobs — msgpack is compact but not compressed
- **No partial hydration** — the entire database is loaded even if the user only needs one collection

---

## 3. Strategy A: Append-Only to Matrix Room

### How It Works

Every EO event lives exclusively as a Matrix room event. The room timeline IS the database log. To hydrate, a device paginates the entire room history and folds every event sequentially. Room state events could optionally cache the latest projected state for key targets.

```
Write:    sendEvent(roomId, "com.aminoimmigration.eo.event", content)
Hydrate:  paginate room timeline from start → fold each event → build state
Cache:    (optional) sendStateEvent(roomId, "eo.state", target, projected_value)
```

### Evaluation

| Dimension | Rating | Analysis |
|-----------|--------|----------|
| **Hydration speed** | Poor | Must paginate entire room history. Matrix pagination rate ~1000 events/sec over HTTP. At 10K events = 10 sec. At 100K events = 100+ sec. No shortcut — every event must be fetched and folded. |
| **Write performance** | Good | `sendEvent()` is 100–500 ms. Already happening for sync. No additional write path. |
| **Storage efficiency** | Poor | JSON wire format is 3–5x larger than msgpack binary. Each Matrix event carries ~500 bytes of overhead (sender, origin_server_ts, event_id, unsigned, signatures). A 200-byte EO event becomes a 700+ byte Matrix event. |
| **Complexity** | Low | No snapshot machinery. No media uploads. One code path. However, room state caching adds complexity back, and without it hydration is unusable at scale. |
| **Encryption** | Excellent | Megolm E2EE handled entirely by Matrix SDK. No custom encryption code. Events are encrypted in transit and at rest on homeserver. |
| **Offline resilience** | Poor | Cold start requires network to paginate room history. No local fallback for a fresh device. Existing devices still have IndexedDB, but new devices are blocked. |
| **Cost at scale** | High | Room history is immutable — no compaction, no deletion. 100K events at ~700 bytes each = 70 MB of room state that grows forever. Federation amplifies this across participating homeservers. |
| **Matrix alignment** | Excellent | Uses Matrix exactly as designed. Room timeline as append-only log is the canonical Matrix pattern. |

### Verdict

Strategy A is elegant in its simplicity but only viable for small datasets (< 1K events). At medium scale (1K–10K), hydration latency becomes noticeable (2–10 sec). At large scale (10K+), it's unusable without adding snapshot-like caching — which reintroduces the complexity this strategy aims to avoid.

**Best for**: Prototypes, demos, very small teams (< 5 users, < 1K records).

---

## 4. Strategy B: Matrix Media Store + Index in Room

### How It Works

Binary msgpack snapshots are uploaded to the Matrix media repository via `uploadContent()`. The room contains lightweight pointer events (`com.aminoimmigration.eo.snapshot`) with metadata: `{mxc, seq, size_bytes, version}`. Individual EO events still sync through the room timeline. Hydration downloads the latest snapshot binary, applies it, then folds only the tail events since the snapshot.

```
Write:    sendEvent(roomId, "eo.event", content)          — individual events
Snapshot: uploadContent(binary) → mxc:// URL
          sendEvent(roomId, "eo.snapshot", {mxc, seq})    — pointer event
Hydrate:  find latest eo.snapshot → download mxc blob → apply → fold tail
```

This is the current implementation.

### Evaluation

| Dimension | Rating | Analysis |
|-----------|--------|----------|
| **Hydration speed** | Good | 1–5 sec for snapshot download + deserialize at 10K events. Bounded by snapshot frequency (every 1000 events), not total history. Tail sync is typically < 100 events. |
| **Write performance** | Good | Individual events: same as Strategy A (~100–500 ms). Snapshot creation: ~100 ms (msgpack serialize). Upload: async, non-blocking. Auto-triggered every 1000 events. |
| **Storage efficiency** | Good | msgpack snapshots are 30–50% smaller than equivalent JSON. Snapshots contain only the latest projection (deduplicated), not full history. Old snapshots can be ignored. |
| **Complexity** | Moderate | Already implemented across `snapshot.ts` (206 lines) and `sync-manager.ts` (151 lines). Well-understood code paths. Room pagination to find snapshots is the main complexity. |
| **Encryption** | Excellent | Double-layered: Megolm E2EE for room events + AES-GCM for snapshot binary content. Media store blobs are opaque to the homeserver. Session-derived keys ensure snapshots are unreadable without credentials. |
| **Offline resilience** | Excellent | IndexedDB has complete state locally. Snapshots are a recovery mechanism for new devices, not the primary store. Existing devices never depend on network for reads. |
| **Cost at scale** | Moderate | Media blobs accumulate but only the latest matters. Homeserver admins can configure media retention policies. Room events still grow linearly (same as A), but snapshot references are tiny (~200 bytes each). |
| **Matrix alignment** | Good | Matrix media store is designed for file uploads. Custom event types are idiomatic. The pattern of "pointer event in room + blob in media" is used by Matrix clients for file sharing. |

### Proposed Optimizations

#### Optimization 1: Snapshot Index as Room State Event

**Problem**: `findLatestSnapshot()` currently paginates the room timeline backwards to find the latest `eo.snapshot` event. If the snapshot is 5000 events back in the timeline, this requires multiple pagination requests.

**Solution**: Use a Matrix **room state event** instead of a timeline event for the snapshot pointer. Room state events are immediately available after room sync — no pagination needed.

```typescript
// Current: timeline event (requires pagination to find)
await client.sendEvent(roomId, EO_SNAPSHOT_TYPE, { mxc, seq, ... });

// Proposed: room state event (instant lookup)
await client.sendStateEvent(roomId, 'com.aminoimmigration.eo.snapshot_index', {
  mxc: mxcUrl,
  seq: snapshot.seq,
  ts: snapshot.ts,
  size_bytes: binary.byteLength,
  version: 1,
}, '');  // empty state_key = singleton
```

**Impact**: Eliminates the backwards pagination loop in `findLatestSnapshot()`. Snapshot pointer is available immediately after initial sync. Reduces hydration latency by 1–10 seconds depending on room size.

#### Optimization 2: Collection-Sharded Snapshots

**Problem**: Full-state snapshots serialize the entire database. If a user only works with `app.tblClients`, they still download `app.tblCases`, `app.tblDocuments`, etc.

**Solution**: Create separate snapshots per collection prefix (first two path segments). The room state event becomes an index mapping collection prefixes to mxc URLs.

```typescript
// Room state: com.aminoimmigration.eo.snapshot_index
{
  collections: {
    "app.tblClients":    { mxc: "mxc://...", seq: 4500, size_bytes: 120000 },
    "app.tblCases":      { mxc: "mxc://...", seq: 4200, size_bytes: 350000 },
    "app.tblDocuments":  { mxc: "mxc://...", seq: 4100, size_bytes: 890000 },
  },
  global_seq: 4500,
  ts: "2026-03-29T...",
  version: 2,
}
```

**Impact**: Enables partial hydration — download only the collections the user needs first, lazy-load the rest. Reduces initial download size by 50–80% for focused workflows. Individual collection snapshots are smaller and faster to create/upload.

#### Optimization 3: Compression Before Upload

**Problem**: msgpack is compact but not compressed. Repetitive field names, similar record structures, and string-heavy operands compress well.

**Solution**: Apply compression before upload using the browser-native `CompressionStream` API (no dependency needed).

```typescript
async function compressSnapshot(binary: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([binary]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompressSnapshot(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
```

**Impact**: 30–60% additional size reduction on top of msgpack. A 5 MB snapshot becomes 2–3.5 MB. Faster downloads on constrained connections. `CompressionStream` is supported in Chrome 80+, Firefox 113+, Safari 16.4+.

### Verdict

Strategy B is the right foundation. It's already implemented, well-understood, and scales to the target range. The three optimizations above address the remaining friction points: slow snapshot lookup (state event), unnecessary data transfer (sharding), and transfer size (compression).

---

## 5. Strategy C: 3rd-Party Object Store (S3/R2/B2)

### How It Works

Binary snapshots are uploaded to an external object storage service (Cloudflare R2, AWS S3, Backblaze B2, or similar). The Matrix room contains reference events pointing to external URLs. Could use content-addressed keys (SHA-256 hash of snapshot binary) for integrity verification.

```
Write:    sendEvent(roomId, "eo.event", content)           — events still via Matrix
Snapshot: PUT https://storage.example.com/snapshots/{hash}  — binary to object store
          sendEvent(roomId, "eo.snapshot", {url, hash, seq}) — reference in room
Hydrate:  find latest eo.snapshot → fetch(url) → verify hash → apply → fold tail
```

### Evaluation

| Dimension | Rating | Analysis |
|-----------|--------|----------|
| **Hydration speed** | Excellent | CDN-backed downloads with edge caching. Parallel range requests for large files. 2–10x faster than Matrix media for blobs > 10 MB. Cloudflare R2 has zero egress fees. |
| **Write performance** | Good | S3-compatible PUT is fast (50–200 ms). But requires authentication: presigned URLs from a signing service, or browser-stored API keys. |
| **Storage efficiency** | Excellent | Purpose-built for binary blobs. Lifecycle policies auto-delete old snapshots. Storage classes (infrequent access, archive) for cost optimization. Native support for multipart upload, compression, content-encoding. |
| **Complexity** | High | Introduces a new dependency outside Matrix. Requires: (1) credential management in the browser, (2) CORS configuration on the bucket, (3) a signing service for presigned URLs or direct API key storage, (4) health checks for the external service. |
| **Encryption** | Fair | Cannot rely on Megolm — external service is outside the Matrix trust boundary. Must encrypt client-side with AES-GCM before upload (feasible — already doing this for IndexedDB). But key distribution and rotation become the app's responsibility entirely. |
| **Offline resilience** | Good | Same as B for existing devices (IndexedDB is primary). But adds a failure mode: if the external service is down or the bucket is misconfigured, new devices cannot hydrate. Matrix media at least shares the homeserver's uptime. |
| **Cost at scale** | Lowest | R2: $0.015/GB/month, zero egress. S3: $0.023/GB/month + $0.09/GB egress. B2: $0.005/GB/month + $0.01/GB egress. At 500 MB of snapshots: $0.0025–$0.0115/month. Negligible. But operational cost (CORS, credentials, monitoring) is non-trivial. |
| **Matrix alignment** | Poor | Breaks the "everything through Matrix" architecture principle. Adds an external dependency that must be configured, monitored, and paid for. Users must trust a third-party service with their encrypted blobs. Contradicts the decentralized spec's "no center" design. |

### Authentication Challenge

The browser must authenticate to the object store. Three options, all with trade-offs:

| Method | Security | Complexity | UX |
|--------|----------|------------|-----|
| **Presigned URLs** | Good (time-limited) | High (requires signing service) | Seamless |
| **Browser API keys** | Poor (keys in JS) | Low | Manual config |
| **Proxy through Matrix** | Good (reuses auth) | Medium | Transparent |

The presigned URL approach requires a lightweight signing service — reintroducing a server dependency and contradicting the zero-server principle. Browser API keys are a security risk. Proxying through Matrix is possible but eliminates the CDN speed advantage.

### Verdict

Strategy C offers the best raw performance for very large datasets (100K+ events, 50+ MB snapshots). However, it introduces significant complexity, breaks the zero-server-dependency principle, and adds an external failure mode. The performance advantage over Strategy B is meaningful only at the "Very Large" scale tier (100K+ events), which is beyond the current target range.

**Best for**: Tier 3 disaster recovery and archival (already planned in DEVELOPMENT-STAGES.md Stage 6). Not recommended as the primary hydration path.

---

## 6. Comparison Matrix

| Dimension | A: Room Only | B: Media + Index | C: External Store |
|-----------|:------------:|:----------------:|:-----------------:|
| **Hydration speed** | Poor | Good | Excellent |
| **Write performance** | Good | Good | Good |
| **Storage efficiency** | Poor | Good | Excellent |
| **Complexity** | Low | Moderate | High |
| **Encryption** | Excellent | Excellent | Fair |
| **Offline resilience** | Poor | Excellent | Good |
| **Cost at scale** | High | Moderate | Lowest |
| **Matrix alignment** | Excellent | Good | Poor |
| **Already implemented** | Partial | Yes | No |
| **Max viable scale** | ~1K events | ~100K events | ~1M+ events |

### Hydration Time Estimates (Cold Start, New Device)

| Event Count | A: Room Only | B: Media + Index | B: With Optimizations | C: External Store |
|-------------|:------------:|:----------------:|:---------------------:|:-----------------:|
| 1K | 1–2 sec | < 1 sec | < 1 sec | < 1 sec |
| 10K | 10–15 sec | 1–3 sec | 1–2 sec | < 1 sec |
| 100K | 100+ sec | 5–15 sec | 3–8 sec | 2–5 sec |
| 1M | Infeasible | Minutes | 30–90 sec | 10–30 sec |

---

## 7. Recommendation

### Primary: Strategy B with Optimizations

Strategy B (Matrix Media Store + Room Index) is the right choice for EO///DB. It is:

1. **Already implemented** — `snapshot.ts` and `sync-manager.ts` are working code
2. **Architecturally aligned** — respects the "everything through Matrix, no center" principle
3. **Sufficient for target scale** — handles up to 100K events with acceptable hydration times
4. **Incrementally improvable** — the three optimizations below address remaining pain points without architectural changes

### Implementation Priorities

| Priority | Optimization | Impact | Effort |
|----------|-------------|--------|--------|
| **P0** | Room state event for snapshot pointer | Eliminates pagination; saves 1–10 sec on hydration | Small — change `sendEvent` to `sendStateEvent` in `uploadSnapshot()`, simplify `findLatestSnapshot()` |
| **P1** | Gzip compression before upload | 30–60% smaller snapshots; faster downloads | Small — ~20 lines using native `CompressionStream` API |
| **P2** | Collection-sharded snapshots | Partial hydration; 50–80% faster for focused workflows | Medium — refactor `createSnapshot()` to iterate by prefix, update index schema |

### Future Escape Hatch: Strategy C as Tier 3

Strategy C should remain the planned Tier 3 backup path (per DEVELOPMENT-STAGES.md Stage 6) for:
- **Disaster recovery** — if the Matrix homeserver loses media, an external backup exists
- **Archival** — long-term storage with lifecycle policies
- **Very large scale** — if a deployment exceeds 100K events and needs sub-5-second hydration

This can be added later without changing the primary hydration flow. The snapshot binary format is the same — only the upload/download transport changes.

---

## 8. Implementation Notes

### Files to Modify

| File | Change |
|------|--------|
| `src/matrix/snapshot.ts` | Replace `sendEvent` with `sendStateEvent` for snapshot pointer (P0). Add gzip compress/decompress wrappers (P1). Refactor `createSnapshot` for collection sharding (P2). |
| `src/matrix/sync-manager.ts` | Update `hydrateFromSnapshot()` to read room state instead of paginating timeline. Support partial collection hydration. |
| `src/matrix/event-bridge.ts` | Add `EO_SNAPSHOT_INDEX_TYPE = 'com.aminoimmigration.eo.snapshot_index'` constant. |
| `src/db/types.ts` | Add `SnapshotIndex` interface for the sharded snapshot manifest. |

### Room State Event Schema (P0)

```typescript
// Event type: com.aminoimmigration.eo.snapshot_index
// State key: '' (empty — singleton)
interface SnapshotIndex {
  version: 2;
  global_seq: number;
  ts: string;
  created_by: string;
  // Version 1: single snapshot
  mxc?: string;
  seq?: number;
  size_bytes?: number;
  // Version 2: collection-sharded
  collections?: Record<string, {
    mxc: string;
    seq: number;
    size_bytes: number;
  }>;
}
```

### Compression (P1)

Use browser-native `CompressionStream` API — zero dependencies.

```typescript
// Compress
const compressed = new Blob([binary]).stream()
  .pipeThrough(new CompressionStream('gzip'));
const result = new Uint8Array(await new Response(compressed).arrayBuffer());

// Decompress
const decompressed = new Blob([data]).stream()
  .pipeThrough(new DecompressionStream('gzip'));
const result = new Uint8Array(await new Response(decompressed).arrayBuffer());
```

Browser support: Chrome 80+, Firefox 113+, Safari 16.4+ — covers all target browsers.

### Collection Sharding Key (P2)

Shard by the first two segments of the target path:
- `app.tblClients.rec001.fldEmail` → shard key: `app.tblClients`
- `app.tblCases.case042` → shard key: `app.tblCases`

Graph edges that cross collection boundaries are stored in both shards (source collection and destination collection) to ensure each shard is self-contained for its collection's traversals.

---

## 9. Risk Analysis

| Risk | Mitigation |
|------|-----------|
| Matrix media upload limit (homeserver-dependent, often 50–100 MB) | Collection sharding keeps individual blobs small. Compression reduces size further. At 100K events, sharded + compressed snapshots should be < 10 MB each. |
| `CompressionStream` not available in older browsers | Feature-detect and fall back to uncompressed upload. Snapshot format includes version field to distinguish. |
| Room state event size limit (~65 KB) | The snapshot index is metadata only (mxc URLs + seq numbers). Even with 100 collections, the index is < 5 KB. |
| Snapshot creation blocks UI thread | Run `createSnapshot()` in a Web Worker or use `requestIdleCallback()` to yield during serialization of large states. |
| Stale snapshot after crash (no beforeunload) | `beforeunload` handler is best-effort. The room event log is the source of truth — tail sync catches up from whatever seq the last snapshot recorded. Worst case: slightly longer hydration due to more tail events. |

---

## 10. Summary

Strategy B is the right answer today. It respects the decentralized architecture, builds on working code, and scales to the target range with three focused optimizations. Strategy A is too slow at scale. Strategy C is the right answer for a future we haven't reached yet — keep it as a planned escape hatch, not a present-day dependency.

The three optimizations (state event index, compression, collection sharding) can be implemented incrementally in priority order. Each one independently improves hydration speed without requiring the others.
