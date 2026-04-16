/// <reference lib="webworker" />
/**
 * EO-native sync worker — Web Worker entry.
 *
 * Thin wrapper around `NetworkSyncWorkerCore`. All logic lives in the
 * core; this file only pipes `postMessage` into `core.handle()` and
 * emits returned commands back to the main thread.
 *
 * See `src/sync/network-sync-worker-core.ts` for the DEF/EVA/REC
 * semantics implemented by the core. The wrapper itself is operator-
 * agnostic.
 */

import {
  NetworkSyncWorkerCore,
  dropDuplicateEmits,
} from '../sync/network-sync-worker-core';
import type {
  WorkerCommand,
  WorkerInbound,
} from '../sync/network-sync-protocol';

const core = new NetworkSyncWorkerCore();

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (ev: MessageEvent<WorkerInbound>) => {
  const commands: WorkerCommand[] = dropDuplicateEmits(core.handle(ev.data));
  for (const cmd of commands) ctx.postMessage(cmd);
});
