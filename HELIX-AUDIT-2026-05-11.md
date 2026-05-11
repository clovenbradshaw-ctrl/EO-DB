# Helix Audit — EO-DB Frontend

**Date:** 2026-05-11
**Branch:** `claude/audit-helix-dependencies-kymCw`
**Scope:** `github-matrix-dev/app/src/` — every state-transition entry point traced through
`NUL → SIG → INS → SEG → CON → SYN → DEF → EVA → REC`.

This is a research report. No code is changed. Findings are evidence-only with file:line citations
so each can be reviewed and fixed independently. The fast path is not a skip: when an operator's
precondition is satisfied by a cheap check (`compare two values`), that's the fast path. When it's
*assumed* from a prior cycle without a check, that's a violation.

---

## Verdict at a glance

| # | Entry point                  | Worst operator  | Status      |
|---|------------------------------|-----------------|-------------|
| 1 | Fresh load                   | —               | OK          |
| 2 | Refresh (warm)               | SEG (homeserver)| ⚠ partial   |
| 3 | Logout → re-login            | REC + SEG       | ✗ violation |
| 4 | Session expiry (401)         | REC             | ✗ violation |
| 5 | New device (cold)            | —               | OK          |
| 6 | Network reconnect            | SEG             | OK          |
| 7 | Background sync              | SYN (yield)     | ⚠ partial   |
| 8 | Space switch                 | —               | OK          |
| 9 | Worker restart               | SIG (re-detect) | ✗ violation |
|10 | Block hydration              | SYN (tail loop) | ⚠ partial   |
|11 | Airtable / seed import       | DEF (checkpoint)| ⚠ partial   |
|12 | Schema migration             | —               | OK (no migrator yet) |

Legend: OK = precondition satisfied; ⚠ partial = fast-path correct but a fallback or edge case
skips an operator; ✗ violation = the operator is consistently skipped.

---

## Top findings (ordered by user-visible blast radius)

### V1. `applyTail` is an unconditional monolithic fold — Scenario C freeze
`github-matrix-dev/app/src/sync/block-hydration.ts:188-196`

```ts
for (const ev of timeline) {
  if (!passedCutoff) {
    if (ev.getId() === cutoffEventId) passedCutoff = true;
    continue;
  }
  if (ev.getType() !== EO_EVENT_TYPE) continue;
  await processEvent(store, matrixEventToEo(ev), onEvent);  // ← tight loop, no yield
  applied++;
}
```

`applyTail` never accepts a `bulkApply` hook, so even callers who wire one for chain blocks
still take the per-event hit on every tail event. For a room with thousands of post-cutoff
tail events, this pins the main thread.

**Diagnostic:** `Block hydration tail-walk skips SEG(chunking) → runs SYN monolithically`.
**Fix sketch:** route tail events through the same `bulkApply` path used by `applyBlockEvents`
when `events.length` exceeds a small threshold.

---

### V2. `applyBlockEvents` fallback path is monolithic
`github-matrix-dev/app/src/sync/block-hydration.ts:160-163`

```ts
if (bulkApply && events.length > 0) { await bulkApply(events); return; }
for (const ev of events) { await processEvent(store, ev, onEvent); }
```

The comment on lines 142-144 acknowledges the limitation. Production UI calls all wire `bulkApply`,
but the fallback is reachable from tests, future callers, and anyone who forgets the option.

**Diagnostic:** `applyBlockEvents fallback skips SEG(chunking) → runs SYN monolithically`.
**Fix sketch:** make `bulkApply` non-optional, or yield via `await Promise.resolve()` every N events
in the fallback.

---

### V3. `processIncomingPeerEvents` is monolithic
`github-matrix-dev/app/src/matrix/peer-sync.ts:426-428`

```ts
for (const event of events) {
  await processEvent(this.store, event, this.onEvent);
}
```

Peer-sync delivers gap-fill payloads that can contain large event batches. This loop is on
the critical path when a peer answers an offer/request handshake.

**Diagnostic:** `Peer-sync ingestion skips SEG(chunking) → runs SYN monolithically`.
**Fix sketch:** route through `useEoStore.batchImport` (the worker-pool path).

---

### V4. Refresh fast path does not consult the homeserver head
`github-matrix-dev/app/src/store/eo-store.ts:224-232`

```ts
const nothingNew =
  snapshotHit &&
  workerHeadSeq !== undefined &&
  workerHeadSeq === snapshotSeq;
```

This is *local* gap detection only: kv-snapshot vs OPFS log. It correctly avoids a redundant
replay, but does not check `m.eo.head.latest_block_event_id`. Strictly speaking the homeserver
SEG is delegated to `hydrateBlocksIfStale` called from `Layout.tsx:1736/1882` — so the SEG does
happen, but it is *post-mount, fire-and-forget*. UI code that reads the store between
`useEoStore.init` resolving and `hydrateBlocksIfStale` resolving sees stale state.

**Diagnostic:** Boot returns "ready" before remote SEG completes.
**Fix sketch:** track an explicit `staleAgainstChain` flag in the store; consumers that require
fresh data await its clearing. Or: surface hydration progress in the loading screen so users
don't act on stale reads.

---

### V5. Logout does not clear OPFS, does not flush the offline queue
`github-matrix-dev/app/src/components/Layout.tsx:1034-1069`,
`github-matrix-dev/app/src/db/clear-space-data.ts:13`,
`github-matrix-dev/app/src/matrix/sync-manager.ts:554-573`

- `clearSpaceLocalData()` is per-space, fired on space switch/delete — not on logout.
- The offline event queue lives in IndexedDB and is restored on next login via
  `restoreQueueFromIdb()` with no session-id check.
- Zustand is cleared by `set({...null})` (eo-store.ts:622-634) — same store instance reused.

Combined, this means: log out as user A → log in as user B on the same device → user B can
inherit user A's OPFS snapshot and queued writes.

**Diagnostic:** `Logout skips REC(state purge) → next cycle inherits prior DEF`.
**Fix sketch:** on logout, either (a) wipe OPFS+IDB entirely, or (b) set a `logged-out-pending`
flag in localStorage that forces the next boot to run SEG against the homeserver before
trusting any cache, and to drop queued events that don't carry the new session's device id.

---

### V6. Token expiry does not trigger REC at all
`github-matrix-dev/app/src/components/Layout.tsx:475-490`

A 401 / `M_UNKNOWN_TOKEN` is surfaced as a toast. No automatic logout fires. The SDK retries
indefinitely with the dead token while the user keeps interacting with stale local state.

**Diagnostic:** `Session expiry skips REC → frame break never happens`.
**Fix sketch:** on `M_UNKNOWN_TOKEN`, call the same `handleLogout` path used for explicit
logout, plus the V5 cache-invalidation hook.

---

### V7. Worker crash leaves stale state and "busy forever" slots
`github-matrix-dev/app/src/db/lazy-fold.ts:196-202`,
`github-matrix-dev/app/src/db/fold-worker-transport.ts:316-344`

`onerror` rejects pending requests but does not re-create the worker, re-seed projection,
or re-run SIG. The fold-pool's `busyUntil` chain holds a resolved promise pointing at a
dead slot; subsequent dispatches to that slot hang.

**Diagnostic:** `Worker restart skips SIG(re-detect) → assumes prior worker state`.
**Fix sketch:** in `onerror`, kill the worker reference, reset `busyUntil`, and require the
next `dispatch` to spawn a replacement worker + re-seed via `network-sync-system.ts:161`.

---

### V8. Returning-device init never runs block-chain SEG inside sync-manager
`github-matrix-dev/app/src/matrix/sync-manager.ts:328-341`

```ts
if (currentSeq === 0) {
  hydrationLanes.push(this.hydrateFromBlockChain()...);
} else {
  hydrationLanes.push(this.replayTimelineEvents()...);
}
```

`hydrateFromBlockChain` (line 379) is only called for `currentSeq === 0`. Returning devices
rely on a separate `hydrateBlocksIfStale` call from `Layout.tsx`. If the host swaps Layout
(or mounts it conditionally), the SEG is lost. The bookkeeping is split across two
unrelated modules.

**Diagnostic:** SEG is a UI concern, not a sync-manager concern. Brittle.
**Fix sketch:** move the `hydrateBlocksIfStale` call into `SyncManager.initialize` so the
SEG always runs, regardless of which shell hosts the sync manager.

---

### V9. `last_hydrated_block_event_id` is in localStorage, not in the snapshot
`github-matrix-dev/app/src/sync/block-hydration.ts:328-349`

The hydration cursor lives at `localStorage[eo-db-hydrated-head:<roomId>]`. The OPFS
kv-snapshot does not carry it. Consequences:

1. localStorage cleared while OPFS intact → re-walk the whole chain (correct, but wasteful;
   idempotent dedup saves us).
2. OPFS cleared while localStorage intact → snapshot rebuilds from scratch with a stale
   "we already hydrated up to X" marker. Subsequent `hydrateBlocksIfStale` short-circuits
   incorrectly: it thinks the chain is up to date but the new snapshot has no chain events.
3. Cross-device OPFS export/import (not currently supported) would carry no cursor at all.

**Diagnostic:** `DEF persistence misses the hydration boundary marker — split across two
stores with no atomicity`.
**Fix sketch:** record `last_hydrated_block_event_id` inside the kv-snapshot itself (it's
already a JSON blob keyed by space). Treat localStorage as a hint, not the source of truth.

---

### V10. `flushToOpfs` can fire mid-fold via visibility-change
`github-matrix-dev/app/src/components/Layout.tsx:1740, 1758, 1889, 1909`,
`github-matrix-dev/app/src/store/eo-store.ts:594-610`

The snapshot is written when the tab is hidden, on a 30s timer, and after every hydrate.
If a hydrate is in flight when the user backgrounds the tab, the partial state can be
snapshotted before fold completes. Combined with V9, the next load sees a snapshot whose
`last_hydrated_block_event_id` doesn't reflect what's actually in the kv map.

In practice the `client_event_id` dedup means a subsequent re-fold is idempotent — so this
manifests as wasted work, not data loss. But it breaks the audit trail and the "DEF written
only after SYN completes" invariant.

**Diagnostic:** `DEF written mid-SYN → snapshot claims a seq it hasn't earned`.
**Fix sketch:** gate `flushToOpfs` on a "fold-in-progress" flag; defer until quiescent.

---

## Per-entry-point checklist

### 1. Fresh load (new tab, no prior state) — **OK**
- NUL: clean runtime, no prior cycle. ✓
- SIG: `loadKvSnapshot` returns null on miss (eo-store.ts:211). ✓
- INS: empty `MemoryStore` constructed (eo-store.ts:218). ✓
- SEG: implicit — no local state to compare. `hydrateFromBlocks` reads server head (sync-manager.ts:330). ✓
- CON: SDK fetches Megolm keys on-demand during decrypt (block-hydration.ts:286-292). ✓
- SYN: chunked via `bulkApply` → `batchImport` (block-hydration.ts:156). ✓ (caveat: tail still monolithic, V1.)
- DEF: `saveKvSnapshot` post-fold (eo-store.ts:301). ✓
- EVA / REC: N/A on cold start.

### 2. Refresh (same session, same device, OPFS snapshot exists) — **partial**
- NUL → DEF same as fresh load.
- **V4** — homeserver SEG happens outside sync-manager, fire-and-forget from Layout. UI reads can race.
- **V10** — `flushToOpfs` mid-hydration can persist partial state.

### 3. Logout → re-login — **violation**
- **V5** — OPFS and offline queue survive; no flag forces SEG.
- **V8** — returning-device init skips block-chain SEG inside sync-manager.
- No pre-flight Megolm check before fold (block-hydration.ts:286). Surfaces during SYN as a decrypt error.
- Zustand cleared by mutation, not by replacing the store instance (eo-store.ts:622-634).
  Shared references survive across cycles.

### 4. Session expiry (401) — **violation**
- **V6** — no auto-REC. The frame doesn't break; the user keeps interacting with stale state.

### 5. New device (no OPFS/IDB/localStorage) — **OK**
- All three signal sources empty → fall through to fresh chain walk. ✓

### 6. Network reconnect — **OK**
- `online` event + `sync` state transitions trigger `debouncedFlush` (sync-manager.ts:310-318). ✓
- `hydrateBlocksIfStale` is invoked on `m.eo.head` change via `listenForChainUpdates` (Layout.tsx:1748). ✓
- The persisted `last_hydrated_block_event_id` (V9 caveat) drives `stopAtBlockEventId`. ✓

### 7. Background sync — **partial**
- **V1** — tail-walk is monolithic; background catch-up of a busy room can block on first tab focus.
- Snapshot written post-hydrate via `.then(() => flushToOpfs())` (Layout.tsx:1740). ✓

### 8. Space switch — **OK**
- `SyncManager.destroy` unregisters listeners (sync-manager.ts:187-213). ✓
- Fresh `MemoryStore` (eo-store.ts:197). ✓
- `clearSpaceLocalData` wipes per-space OPFS / localStorage / SIGs (clear-space-data.ts:20-47). ✓
- `releaseRoomProtocol` releases the room sync guard (network-sync-system.ts:184). ✓

### 9. Worker restart — **violation**
- **V7** — fold-worker, shard-worker, and network-sync-worker all lack recovery paths.
- Pending message-port promises against dead workers reject with generic "Worker error"
  but don't re-detect state.

### 10. Block hydration — **partial**
- **V1**, **V2** — monolithic paths on tail and fallback.
- CON correctly precedes SYN (Phase 3 → Phase 4 barrier, block-hydration.ts:286-306). ✓
- **V9** — boundary marker in localStorage, not snapshot.

### 11. Airtable / seed import — **partial**
- Chunked through `batchImport`. ✓
- **V10** — `flushToOpfs` interleaved with fold can write a mid-import DEF.
- Resumable hydration writes per-table checkpoint
  (`airtable-resumable-hydration.ts:209, 536`) — good, but the same V9 concern applies:
  the checkpoint is separate from the kv-snapshot.

### 12. Schema migration — **OK (vacuously)**
- No migration loader exists. A schema bump requires writing a new block; recipients re-fold.
- This is fine as long as the design holds. **Add this audit step back when the first
  migrator lands.**

---

## Cross-cycle contamination checks

| Vector                              | Status | Evidence |
|-------------------------------------|--------|----------|
| `.then()` from prior session resolving into new memStore | ⚠ | Offline-queue restore (sync-manager.ts:554) has no session-id check. |
| Shared mutable Zustand store across logout | ⚠ | `teardown` mutates the existing store (eo-store.ts:614-636) instead of replacing the slice. |
| Implicit DEF inheritance via OPFS    | ✗ (V5) | OPFS persists across logout with no validity flag. |
| Implicit DEF inheritance via localStorage hydration cursor | ✗ (V9) | `eo-db-hydrated-head:*` persists across logout. |
| Pending fetch from prior session     | ✓ | SDK's HTTP client is destroyed in `handleLogout` (Layout.tsx). |

---

## Recommended fix order

Two of the violations above account for most of the user-visible risk: V5 (logout pollutes
next session) and V1 (tail-walk freeze on a populous room). Both have clean, contained fixes.

1. **V1, V2, V3** — chunking violations. Mechanical: pipe through `batchImport`. No
   architectural changes. Each is a ~10-line patch.
2. **V5** — write a `eo-db-pending-cleanup` flag on logout; on next boot, run a full
   chain-SEG (force=true) before trusting any cache. Also drop queued events whose
   originating device_id doesn't match the new session.
3. **V6** — wire `M_UNKNOWN_TOKEN` to `handleLogout` so the frame breaks cleanly.
4. **V7** — give each worker pool an `onerror → respawn` policy.
5. **V8** — move `hydrateBlocksIfStale` into `SyncManager.initialize`. The Layout call
   becomes redundant and can be removed.
6. **V9, V10** — fold the hydration cursor into the kv-snapshot; gate `flushToOpfs` on
   a "fold-quiescent" flag.
7. **V4** — surface hydration progress in the boot screen so users don't read stale state.

Items 1–3 are localized and low-risk. Items 4–6 touch invariants and want test coverage
for logout/re-login, worker-kill, and tab-hide mid-fold.

---

## Notes on methodology

This audit was conducted from a clean working tree on the audit branch with no other work
in progress. Findings were collected by four parallel investigations (boot/refresh, session
lifecycle, runtime sync, bulk import) covering ~60 files, then the highest-impact claims
were re-verified by direct reads of the cited line ranges. The diagnostic shorthand and
operator definitions follow the ruleset in the original prompt.

The audit does not include test coverage. A follow-up should add a test suite that exercises
each entry point at least once — logout/re-login is the highest-leverage scenario because
it triggers V5, V6 (when paired with token expiry), V7 (workers restart on space rebind),
and V8 simultaneously.
