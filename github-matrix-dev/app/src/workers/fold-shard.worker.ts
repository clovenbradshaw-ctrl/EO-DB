/// <reference lib="webworker" />
/**
 * fold-shard.worker.ts — Phase G shard worker.
 *
 * A dedicated Web Worker that implements the `ShardDispatcher` contract
 * from fold-worker-transport.ts over postMessage. The coordinator sends a
 * `WorkerDispatchMessage` containing a `ShardRequest`; this worker
 * reconstructs an isolated TrackedStore from the snapshot, runs the shard
 * body via `dispatchShardInProcess`, and posts back a `WorkerResultMessage`
 * with the mutation log.
 *
 * The worker has no shared state between dispatches. Every request is
 * fully self-contained — the snapshot travels on the wire, the mutation
 * log travels back. This is the property that lets a single worker
 * process shards from many unrelated stores over its lifetime.
 *
 * No `onEvent` hook is threaded through. Functions can not cross the
 * structured-clone boundary, and the coordinator side can subscribe to
 * the merged store directly if it needs event-by-event callbacks.
 *
 * Errors thrown inside the shard body are caught here and posted back as
 * a typed `error` result. The coordinator re-throws locally so stack
 * traces attach to the shard's own call site rather than the worker
 * thread's event loop, which is what debuggers expect.
 */

import {
  dispatchShardInProcess,
  type WorkerDispatchMessage,
  type WorkerResultMessage,
} from '../db/fold-worker-transport';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: WorkerResultMessage): void {
  ctx.postMessage(msg);
}

ctx.addEventListener('message', (ev: MessageEvent<WorkerDispatchMessage>) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'dispatch') return;

  const { id, request } = msg;
  dispatchShardInProcess(request)
    .then((response) => {
      post({ type: 'result', id, response });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      post({ type: 'error', id, error: message });
    });
});
