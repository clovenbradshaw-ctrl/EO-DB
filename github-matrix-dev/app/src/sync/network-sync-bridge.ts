/**
 * Bridge — turns worker commands into real-world I/O.
 *
 * Phase 4 keeps the bridge's dependencies abstract (structural interfaces
 * below) so the full `MatrixClient` / `WebRTCPeer` wiring can land in
 * Phase 5 without changing the worker contract.
 *
 * Responsibilities:
 *   - `send_control` / `send_bulk` → transport send (RTC preferred,
 *     Matrix to-device fallback).
 *   - `open_dc` / `close_dc` → DC lifecycle hints.
 *   - `emit_eo_event` → main-thread fold + Matrix timeline emit.
 *   - `read_piece_events` → read events out of OPFS and feed them back.
 *
 * The bridge also owns the `⊨EVA` verification step described in the
 * spec's Phase 4 flow: any incoming bulk bytes are hash-verified
 * **before** the worker is told about them. If verification fails, the
 * bridge reports the failure to the worker with a sentinel
 * `content_hash: '__INVALID__'` so the worker's existing EVA/REC path
 * emits the right events.
 */

import type {
  BulkMessage,
  ControlMessage,
  PeerId,
  PieceSiteStr,
  WorkerCommand,
} from './network-sync-protocol';
import type { NetworkSyncClient } from './network-sync-client';
import type { EoEvent } from '../db/types';
import { verifyPieceBytes, canonicalMsgpack, pieceHash } from '../db/hash';
import { unpack } from 'msgpackr';

const INVALID_HASH_SENTINEL = '__INVALID__';

/** Minimal structural type for the Matrix transport used by the bridge. */
export interface BridgeMatrixTransport {
  /** Send a control (to-device) message to a specific peer. */
  sendControlToPeer(peer: PeerId, msg: ControlMessage): Promise<void>;
  /** Send a bulk (to-device) message to a specific peer. */
  sendBulkToPeer(peer: PeerId, msg: BulkMessage): Promise<void>;
  /** Submit an EO event to the room timeline (goes through the fold). */
  emitEoEvent(event: EoEvent): Promise<void>;
}

/** Minimal structural type for the WebRTC transport used by the bridge. */
export interface BridgeRtcTransport {
  /** Whether a DataChannel is currently open to this peer. */
  isOpen(peer: PeerId): boolean;
  /** Open or reuse a DataChannel. */
  open(peer: PeerId): Promise<void>;
  /** Close a DataChannel if one exists. */
  close(peer: PeerId): Promise<void>;
  /** Send a bulk frame over the existing DC. */
  sendBulk(peer: PeerId, msg: BulkMessage): Promise<void>;
  /** Send a control frame over the existing DC (optional). */
  sendControl?(peer: PeerId, msg: ControlMessage): Promise<void>;
}

/** Minimal structural type for reading piece events off OPFS. */
export interface BridgeStore {
  /** Read the events for a piece. Returns null if the piece is not local. */
  readPieceEvents(piece_site: PieceSiteStr): Promise<unknown[] | null>;
}

export interface BridgeOptions {
  matrix: BridgeMatrixTransport;
  rtc: BridgeRtcTransport;
  store: BridgeStore;
  client: NetworkSyncClient;
  /**
   * Called when a transport send fails. Non-fatal — logged/surfaced as
   * the host wishes. Defaults to console.warn.
   */
  onError?: (scope: string, err: unknown) => void;
  /** Epoch ms source; default is `Date.now()`. */
  now?: () => number;
}

export interface NetworkSyncBridge {
  /**
   * Verify and deliver an inbound bulk frame from `fromPeer`. The bridge
   * performs ⊨EVA (hash verify) and then hands the result to the worker.
   */
  handleInboundBulk(msg: BulkMessage, fromPeer: PeerId): Promise<void>;
  /** Deliver an inbound control frame from `fromPeer`. */
  handleInboundControl(msg: ControlMessage, fromPeer: PeerId): void;
  /** Dispose the bridge; detaches the client subscription. */
  dispose(): void;
}

export function createNetworkSyncBridge(opts: BridgeOptions): NetworkSyncBridge {
  const now = opts.now ?? (() => Date.now());
  const onError = opts.onError ?? ((scope, err) => console.warn(`[sync-bridge] ${scope}`, err));

  const unsubscribe = opts.client.onCommand((cmd) => {
    void handleCommand(cmd).catch((err) => onError(cmd.kind, err));
  });

  async function handleCommand(cmd: WorkerCommand): Promise<void> {
    switch (cmd.kind) {
      case 'send_control': {
        // Control messages are small and reliable — always via Matrix
        // to-device unless the RTC transport implements sendControl.
        if (opts.rtc.isOpen(cmd.peer) && opts.rtc.sendControl) {
          await opts.rtc.sendControl(cmd.peer, cmd.msg);
        } else {
          await opts.matrix.sendControlToPeer(cmd.peer, cmd.msg);
        }
        return;
      }
      case 'send_bulk': {
        // The worker proposes a preferred transport; fall back if the
        // DC is not open. This realizes the spec's "WebRTC primary,
        // Matrix fallback" (§4.3).
        const preferRtc = cmd.preferTransport === 'rtc' && opts.rtc.isOpen(cmd.peer);
        try {
          if (preferRtc) {
            await opts.rtc.sendBulk(cmd.peer, cmd.msg);
          } else {
            await opts.matrix.sendBulkToPeer(cmd.peer, cmd.msg);
          }
        } catch (err) {
          // Retry on the other transport.
          onError('send_bulk.primary', err);
          if (preferRtc) {
            await opts.matrix.sendBulkToPeer(cmd.peer, cmd.msg);
          } else if (opts.rtc.isOpen(cmd.peer)) {
            await opts.rtc.sendBulk(cmd.peer, cmd.msg);
          }
        }
        return;
      }
      case 'open_dc':
        await opts.rtc.open(cmd.peer);
        return;
      case 'close_dc':
        await opts.rtc.close(cmd.peer);
        return;
      case 'emit_eo_event':
        await opts.matrix.emitEoEvent(cmd.event);
        return;
      case 'read_piece_events': {
        const events = await opts.store.readPieceEvents(cmd.pieceSite);
        opts.client.reportPieceEventsResponse(cmd.reqId, events, now());
        return;
      }
    }
  }

  async function handleInboundBulk(msg: BulkMessage, fromPeer: PeerId): Promise<void> {
    if (msg.kind !== 'piece_bytes') {
      opts.client.reportInboundBulk(msg, fromPeer, now());
      return;
    }
    const events = decodeEventsFromBulk(msg.events_msgpack);
    const okHash = events === null
      ? false
      : await verifyPieceBytes(events, msg.content_hash);
    if (okHash && events !== null) {
      // ⊨EVA succeeded. Feed the events to the main-thread fold so the
      // resulting piece INS flows back to the worker via
      // `reportFoldedEvent`. The bridge only needs to tell the worker
      // the frame arrived and verified.
      opts.client.reportInboundBulk(msg, fromPeer, now());
      // Caller-owned: the host wires inbound bulk to the fold worker
      // separately. We don't invoke the fold here to keep the Phase 4
      // contract minimal; Phase 5 wires the fold path end-to-end.
    } else {
      // ⊨EVA failed. Emit a failure frame to the worker so it can emit
      // EVA(peer){result:false} + REC(peer){blacklisted} on the log.
      const failureFrame: BulkMessage = {
        ...msg,
        content_hash: INVALID_HASH_SENTINEL,
      };
      opts.client.reportInboundBulk(failureFrame, fromPeer, now());
    }
  }

  function handleInboundControl(msg: ControlMessage, fromPeer: PeerId): void {
    opts.client.reportInboundControl(msg, fromPeer, now());
  }

  function dispose(): void {
    unsubscribe();
  }

  return { handleInboundBulk, handleInboundControl, dispose };
}

// ─── Encoding helpers ───────────────────────────────────────────────────

/**
 * Decode events from bulk bytes. Returns null if the buffer can't be
 * decoded — treated as a verification failure upstream.
 */
function decodeEventsFromBulk(bytes: Uint8Array): unknown[] | null {
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    const decoded = unpack(bytes);
    if (!Array.isArray(decoded)) return null;
    return decoded as unknown[];
  } catch {
    return null;
  }
}

/**
 * Helper exported for Phase 5 / tests: encode an events array as the
 * bulk frame body and compute its canonical hash.
 */
export async function encodeBulkBody(events: unknown[]): Promise<{
  bytes: Uint8Array;
  content_hash: string;
}> {
  const bytes = canonicalMsgpack(events);
  const content_hash = await pieceHash(events);
  return { bytes, content_hash };
}

export { INVALID_HASH_SENTINEL };
