/**
 * Main-thread client for the EO-native sync worker.
 *
 * Wraps a `Worker` (or any object that conforms to the structural
 * `Worker`-like interface below — handy for tests that drive the core
 * synchronously) and exposes a typed surface to the rest of the app.
 *
 * The client is transport-agnostic: it does not know about the Matrix
 * client or the WebRTC DataChannel. `network-sync-bridge.ts` connects
 * the two sides.
 */

import type {
  WorkerCommand,
  WorkerInbound,
  PeerId,
  ControlMessage,
  BulkMessage,
  StartInit,
} from './network-sync-protocol';
import type { EoEvent } from '../db/types';

/** Subset of the DOM `Worker` API the client actually uses. */
export interface WorkerLike {
  postMessage(msg: WorkerInbound): void;
  addEventListener(
    type: 'message',
    listener: (ev: MessageEvent<WorkerCommand>) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (ev: MessageEvent<WorkerCommand>) => void,
  ): void;
  terminate(): void;
}

export interface NetworkSyncClient {
  start(init: StartInit): Promise<void>;
  stop(): Promise<void>;
  onCommand(handler: (cmd: WorkerCommand) => void): () => void;
  reportFoldedEvent(event: EoEvent, nowMs?: number): void;
  reportInboundControl(msg: ControlMessage, fromPeer: PeerId, nowMs?: number): void;
  reportInboundBulk(msg: BulkMessage, fromPeer: PeerId, nowMs?: number): void;
  reportPeerJoin(peer: PeerId, nowMs?: number): void;
  reportPeerLeave(peer: PeerId, nowMs?: number): void;
  reportDcState(peer: PeerId, state: 'open' | 'closed' | 'error', nowMs?: number): void;
  reportPieceEventsResponse(reqId: string, events: unknown[] | null, nowMs?: number): void;
  tick(nowMs?: number): void;
}

export interface NetworkSyncClientOptions {
  /** Optional clock; defaults to `Date.now()`. */
  now?: () => number;
}

export function createNetworkSyncClient(
  worker: WorkerLike,
  options: NetworkSyncClientOptions = {},
): NetworkSyncClient {
  const now = options.now ?? (() => Date.now());
  const handlers = new Set<(cmd: WorkerCommand) => void>();

  const listener = (ev: MessageEvent<WorkerCommand>) => {
    for (const handler of handlers) handler(ev.data);
  };
  worker.addEventListener('message', listener);

  function send(msg: WorkerInbound) {
    worker.postMessage(msg);
  }

  return {
    async start(init) {
      send({ kind: 'start', init });
    },
    async stop() {
      send({ kind: 'stop' });
      worker.removeEventListener('message', listener);
      worker.terminate();
      handlers.clear();
    },
    onCommand(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    reportFoldedEvent(event, nowMs = now()) {
      send({ kind: 'folded_event', event, nowMs });
    },
    reportInboundControl(msg, fromPeer, nowMs = now()) {
      send({ kind: 'inbound_control', msg, fromPeer, nowMs });
    },
    reportInboundBulk(msg, fromPeer, nowMs = now()) {
      send({ kind: 'inbound_bulk', msg, fromPeer, nowMs });
    },
    reportPeerJoin(peer, nowMs = now()) {
      send({ kind: 'peer_join', peer, nowMs });
    },
    reportPeerLeave(peer, nowMs = now()) {
      send({ kind: 'peer_leave', peer, nowMs });
    },
    reportDcState(peer, state, nowMs = now()) {
      send({ kind: 'dc_state', peer, state, nowMs });
    },
    reportPieceEventsResponse(reqId, events, nowMs = now()) {
      send({ kind: 'piece_events_response', reqId, events, nowMs });
    },
    tick(nowMs = now()) {
      send({ kind: 'tick', nowMs });
    },
  };
}

// ─── In-process driver for tests ────────────────────────────────────────

/**
 * A `WorkerLike` that runs the core synchronously in the same JS
 * context. Convenient for deterministic integration tests that don't
 * want the overhead of a Worker bundle. The caller holds the core
 * reference so tests can also poke it directly.
 */
export function createInProcessWorkerLike(
  handle: (msg: WorkerInbound) => WorkerCommand[],
): WorkerLike {
  const listeners = new Set<(ev: MessageEvent<WorkerCommand>) => void>();
  return {
    postMessage(msg) {
      const commands = handle(msg);
      for (const cmd of commands) {
        const ev = { data: cmd } as MessageEvent<WorkerCommand>;
        for (const listener of listeners) listener(ev);
      }
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    terminate() {
      listeners.clear();
    },
  };
}
