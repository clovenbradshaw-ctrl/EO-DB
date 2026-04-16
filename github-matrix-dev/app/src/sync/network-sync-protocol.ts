/**
 * Shared protocol types for the EO-native sync worker.
 *
 * These types describe the messages that flow between the main thread
 * (via `NetworkSyncClient` / the bridge) and the dedicated
 * `network-sync.worker` Web Worker.
 *
 * Naming mirrors the operator semantics on the wire. The runtime split
 * between ⊢DEF, ⊨EVA, and ↬REC is described in sync.md §3:
 *
 *   - ⊢DEF classifies a piece's hash into a fixed type (emitted by the
 *     worker when it detects a stable resolution path on the projection).
 *   - ⊨EVA evaluates whether delivered bytes satisfy a claimed hash
 *     (emitted by the worker after it verifies — or fails to verify —
 *     bytes received on the wire).
 *   - ↬REC restructures a peer or piece's category when evaluation has
 *     revealed something the prior definition did not anticipate
 *     (emitted by the worker to rewrite eligibility, or to recognize
 *     `unrecoverable_pending_author` state).
 *
 * These three operators form a loop: DEF-EVA-REC-DEF... Neither ⊨EVA
 * nor ↬REC is "just a function call" here — they are the operators by
 * which the system's encounter with its own data feeds back into its
 * defining structure.
 */

import type { EoEvent } from '../db/types';

// ─── Peer/piece addresses ───────────────────────────────────────────────

/** Site string of the form `peer:<user>|<device>`. */
export type PeerId = string;

/** Site string of the form `piece:<author>/v<version>/<index>`. */
export type PieceSiteStr = string;

/** Site string of the form `tail:<author>`. */
export type TailSiteStr = string;

// ─── Wire-level control / bulk messages ─────────────────────────────────

export type ControlMessage =
  | {
      kind: 'request_piece_bytes';
      req_id: string;
      piece_site: PieceSiteStr;
      expected_hash: string;
    }
  | {
      kind: 'request_tail_events';
      req_id: string;
      tail_site: TailSiteStr;
      from_seq: number;
    }
  | { kind: 'cancel'; req_id: string };

export type BulkMessage =
  | {
      kind: 'piece_bytes';
      req_id: string;
      piece_site: PieceSiteStr;
      content_hash: string;
      /** Canonical msgpack encoding of the events array for this piece. */
      events_msgpack: Uint8Array;
    }
  | {
      kind: 'tail_bytes';
      req_id: string;
      tail_site: TailSiteStr;
      from_seq: number;
      events_msgpack: Uint8Array;
    };

export type PreferTransport = 'rtc' | 'matrix';

// ─── Worker → main commands ─────────────────────────────────────────────

export type WorkerCommand =
  | { kind: 'send_control'; peer: PeerId; msg: ControlMessage }
  | {
      kind: 'send_bulk';
      peer: PeerId;
      msg: BulkMessage;
      preferTransport: PreferTransport;
    }
  | { kind: 'open_dc'; peer: PeerId }
  | { kind: 'close_dc'; peer: PeerId }
  /**
   * A derived event (DEF/SYN/REC) or a worker-originated bookkeeping
   * event (CON/EVA/REC on peer) that the main thread should submit
   * through the normal Matrix timeline emit path.
   */
  | { kind: 'emit_eo_event'; event: EoEvent }
  /**
   * Worker asks main thread to read the events for a piece out of OPFS
   * (so the worker can hash + re-serve them). Main responds via a
   * `piece_events_response` inbound message.
   */
  | { kind: 'read_piece_events'; reqId: string; pieceSite: PieceSiteStr };

// ─── Main → worker inbound messages ─────────────────────────────────────

export interface StartInit {
  roomId: string;
  myDeviceId: string;
  myUserId: string;
  /**
   * Events already folded locally (fed in at start so the worker's
   * projection is consistent with main before live traffic arrives).
   */
  seedEvents: EoEvent[];
  /**
   * Epoch ms at start. Used to initialize the worker's `nowMs` reference;
   * subsequent ticks receive their own `nowMs`.
   */
  nowMs: number;
  /**
   * Deterministic scheduler seed. Stays stable across the worker's life.
   */
  seed: number;
}

export type WorkerInbound =
  | { kind: 'start'; init: StartInit }
  | { kind: 'stop' }
  | { kind: 'folded_event'; event: EoEvent; nowMs: number }
  | {
      kind: 'inbound_control';
      msg: ControlMessage;
      fromPeer: PeerId;
      nowMs: number;
    }
  | {
      kind: 'inbound_bulk';
      msg: BulkMessage;
      fromPeer: PeerId;
      nowMs: number;
    }
  | { kind: 'peer_join'; peer: PeerId; nowMs: number }
  | { kind: 'peer_leave'; peer: PeerId; nowMs: number }
  | {
      kind: 'dc_state';
      peer: PeerId;
      state: 'open' | 'closed' | 'error';
      nowMs: number;
    }
  | {
      kind: 'piece_events_response';
      reqId: string;
      /** null ⇒ main could not read the piece (not instantiated locally). */
      events: unknown[] | null;
      nowMs: number;
    }
  /**
   * A synthetic tick from the main thread. Lets the main driver force a
   * scheduler re-run (e.g. after external timer) without a new event.
   */
  | { kind: 'tick'; nowMs: number };
