/**
 * Concrete transports for the EO-native sync bridge.
 *
 * Phase 5 wiring: turns the abstract `BridgeMatrixTransport` /
 * `BridgeRtcTransport` / `BridgeStore` interfaces into adapters over
 * the live `MatrixClient`, `WebRTCPeer`, and `EoStore`. The bridge
 * itself (see `network-sync-bridge.ts`) stays transport-agnostic.
 *
 * Wire mapping:
 *   - control (request_piece_bytes, cancel, ...)
 *       → Matrix to-device `<prefix>.swarm.v2.control`
 *   - bulk over WebRTC
 *       → WebRTCPeer.sendBulkFrame (piece_bytes / tail_bytes DC frame)
 *   - bulk over Matrix fallback
 *       → Matrix to-device `<prefix>.swarm.v2.bulk`
 *   - emit_eo_event
 *       → local fold (so projection updates right away) + broadcast
 *         via the room timeline (so other devices see it).
 *   - read_piece_events
 *       → read events out of local OPFS by `target = piece_site` and
 *         filter SEG-bounded ranges (§3.3, §3.4).
 */

import type { MatrixClient } from 'matrix-js-sdk';
import type { EoStore } from './../db/encrypted-store';
import type { EoEvent, EoEventInput } from './../db/types';
import { processEvent } from './../db/fold';
import { readLogForTarget, readLogForPrefix } from './../db/log';
import { sendEoEvent } from './../matrix/event-bridge';
import type { WebRTCPeer, SwarmV2BulkFrame } from './../matrix/webrtc-peer';
import { swarmV2EventTypes } from './../lib/matrix-domain';
import { toDeviceContent } from './../matrix/webrtc-peer';
import { parsePieceSite, parsePeerSite } from './sites';
import type {
  BulkMessage,
  ControlMessage,
  PeerId,
  PieceSiteStr,
} from './network-sync-protocol';
import type {
  BridgeMatrixTransport,
  BridgeRtcTransport,
  BridgeStore,
} from './network-sync-bridge';
import type { NetworkSyncClient } from './network-sync-client';

const SWARM_V2 = swarmV2EventTypes();

// ─── Matrix transport ───────────────────────────────────────────────────

export interface MatrixTransportDeps {
  client: MatrixClient;
  roomId: string;
  store: EoStore;
  /**
   * Callback invoked by the local fold after an emitted event has been
   * assigned a seq. Should forward the event to the worker via
   * `client.reportFoldedEvent(event)`.
   */
  onLocallyFolded: (event: EoEvent) => void;
}

export function createMatrixTransport(deps: MatrixTransportDeps): BridgeMatrixTransport {
  const { client, roomId, store, onLocallyFolded } = deps;

  return {
    async sendControlToPeer(peer, msg) {
      const { userId, deviceId } = splitPeerId(peer);
      await client.sendToDevice(
        SWARM_V2.control,
        toDeviceContent(userId, deviceId, { ...msg, room_id: roomId }),
      );
    },
    async sendBulkToPeer(peer, msg) {
      const { userId, deviceId } = splitPeerId(peer);
      await client.sendToDevice(
        SWARM_V2.bulk,
        toDeviceContent(userId, deviceId, { ...msg, room_id: roomId }),
      );
    },
    async emitEoEvent(event) {
      // Local fold first so the worker sees the event (and its seq)
      // before the Matrix round-trip completes. The fold assigns seq.
      const input: EoEventInput = toFoldInput(event);
      await processEvent(store, input, onLocallyFolded);
      // Broadcast through the room timeline so peers see it too.
      await sendEoEvent(client, roomId, input);
    },
  };
}

// ─── WebRTC transport ───────────────────────────────────────────────────

export interface RtcTransportDeps {
  peer: WebRTCPeer;
  /** Initiates a connection on an `open_dc` command. */
  connect: (peerUserId: string, peerDeviceId: string) => Promise<void>;
  /** Disconnects on a `close_dc` command. */
  disconnect: (peerUserId: string, peerDeviceId: string) => Promise<void>;
}

export function createRtcTransport(deps: RtcTransportDeps): BridgeRtcTransport {
  const { peer, connect, disconnect } = deps;
  return {
    isOpen(peerSite) {
      const { userId, deviceId } = splitPeerId(peerSite);
      return peer.hasChannel(userId, deviceId);
    },
    async open(peerSite) {
      const { userId, deviceId } = splitPeerId(peerSite);
      if (peer.hasChannel(userId, deviceId)) return;
      await connect(userId, deviceId);
    },
    async close(peerSite) {
      const { userId, deviceId } = splitPeerId(peerSite);
      await disconnect(userId, deviceId);
    },
    async sendBulk(peerSite, msg) {
      const { userId, deviceId } = splitPeerId(peerSite);
      const frame = bulkMessageToRtcFrame(msg);
      const ok = await peer.sendBulkFrame(userId, deviceId, frame);
      if (!ok) throw new Error(`WebRTC DC not open for ${peerSite}`);
    },
  };
}

// ─── Store adapter ──────────────────────────────────────────────────────

export interface StoreAdapterDeps {
  store: EoStore;
}

export function createStoreAdapter(deps: StoreAdapterDeps): BridgeStore {
  const { store } = deps;
  return {
    async readPieceEvents(piece_site) {
      const parsed = parsePieceSite(piece_site);
      if (!parsed) return null;
      // Canonical read: events whose target is exactly the piece_site.
      // For v1 pieces that's sufficient; future schema versions may
      // group multiple targets under a piece — extend here.
      const events = await readLogForTarget(store, piece_site);
      return events.length > 0 ? events : null;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void readLogForPrefix;
    },
  };
}

// ─── Inbound wiring ─────────────────────────────────────────────────────

export interface InboundWiringDeps {
  client: NetworkSyncClient;
  matrix: MatrixClient;
  peer: WebRTCPeer;
  roomId: string;
}

/**
 * Subscribe to Matrix to-device events for swarm.v2 control and bulk,
 * plus WebRTC DC frames. Every inbound is forwarded to the sync
 * worker via the `NetworkSyncClient`. Returns an unsubscribe.
 */
export function wireInbound(deps: InboundWiringDeps): () => void {
  const { client, matrix, peer, roomId } = deps;

  const handleToDevice = (event: unknown): void => {
    const ev = event as {
      getType: () => string;
      getContent: () => Record<string, unknown>;
      getSender: () => string;
    };
    const type = ev.getType();
    const content = ev.getContent();
    const sender = ev.getSender();
    if (content.room_id && content.room_id !== roomId) return;
    if (type === SWARM_V2.control) {
      const msg = toDeviceContentToControl(content);
      if (!msg) return;
      const fromPeer = asPeerId(sender, content);
      client.reportInboundControl(msg, fromPeer);
    } else if (type === SWARM_V2.bulk) {
      const msg = toDeviceContentToBulk(content);
      if (!msg) return;
      const fromPeer = asPeerId(sender, content);
      client.reportInboundBulk(msg, fromPeer);
    }
  };
  matrix.on('toDeviceEvent' as unknown as never, handleToDevice as never);

  peer.setBulkFrameHandler((frame: SwarmV2BulkFrame, peerUserId, peerDeviceId) => {
    const fromPeer = `peer:${peerUserId}|${peerDeviceId}`;
    client.reportInboundBulk(rtcFrameToBulkMessage(frame), fromPeer);
  });

  return () => {
    matrix.removeListener?.(
      'toDeviceEvent' as unknown as never,
      handleToDevice as never,
    );
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function splitPeerId(peerSite: PeerId): { userId: string; deviceId: string } {
  const parsed = parsePeerSite(peerSite);
  if (!parsed) {
    throw new Error(`Invalid peer site: ${peerSite}`);
  }
  return { userId: parsed.userId, deviceId: parsed.deviceId };
}

function asPeerId(
  sender: string,
  content: Record<string, unknown>,
): PeerId {
  const deviceId =
    typeof content.my_device === 'string'
      ? (content.my_device as string)
      : typeof content.from_device === 'string'
        ? (content.from_device as string)
        : '';
  return `peer:${sender}|${deviceId}`;
}

function toDeviceContentToControl(content: Record<string, unknown>): ControlMessage | null {
  const kind = content.kind;
  if (kind === 'request_piece_bytes' && typeof content.req_id === 'string' && typeof content.piece_site === 'string' && typeof content.expected_hash === 'string') {
    return {
      kind: 'request_piece_bytes',
      req_id: content.req_id,
      piece_site: content.piece_site as PieceSiteStr,
      expected_hash: content.expected_hash,
    };
  }
  if (kind === 'request_tail_events' && typeof content.req_id === 'string' && typeof content.tail_site === 'string' && typeof content.from_seq === 'number') {
    return {
      kind: 'request_tail_events',
      req_id: content.req_id,
      tail_site: content.tail_site,
      from_seq: content.from_seq,
    };
  }
  if (kind === 'cancel' && typeof content.req_id === 'string') {
    return { kind: 'cancel', req_id: content.req_id };
  }
  return null;
}

function toDeviceContentToBulk(content: Record<string, unknown>): BulkMessage | null {
  const kind = content.kind;
  const bytes = content.events_msgpack;
  if (!(bytes instanceof Uint8Array)) return null;
  if (kind === 'piece_bytes' && typeof content.req_id === 'string' && typeof content.piece_site === 'string' && typeof content.content_hash === 'string') {
    return {
      kind: 'piece_bytes',
      req_id: content.req_id,
      piece_site: content.piece_site as PieceSiteStr,
      content_hash: content.content_hash,
      events_msgpack: bytes,
    };
  }
  if (kind === 'tail_bytes' && typeof content.req_id === 'string' && typeof content.tail_site === 'string' && typeof content.from_seq === 'number') {
    return {
      kind: 'tail_bytes',
      req_id: content.req_id,
      tail_site: content.tail_site,
      from_seq: content.from_seq,
      events_msgpack: bytes,
    };
  }
  return null;
}

function bulkMessageToRtcFrame(msg: BulkMessage): SwarmV2BulkFrame {
  if (msg.kind === 'piece_bytes') {
    return {
      type: 'piece_bytes',
      req_id: msg.req_id,
      piece_site: msg.piece_site,
      content_hash: msg.content_hash,
      events_msgpack: msg.events_msgpack,
    };
  }
  return {
    type: 'tail_bytes',
    req_id: msg.req_id,
    tail_site: msg.tail_site,
    from_seq: msg.from_seq,
    events_msgpack: msg.events_msgpack,
  };
}

function rtcFrameToBulkMessage(frame: SwarmV2BulkFrame): BulkMessage {
  if (frame.type === 'piece_bytes') {
    return {
      kind: 'piece_bytes',
      req_id: frame.req_id,
      piece_site: frame.piece_site,
      content_hash: frame.content_hash,
      events_msgpack: frame.events_msgpack,
    };
  }
  return {
    kind: 'tail_bytes',
    req_id: frame.req_id,
    tail_site: frame.tail_site,
    from_seq: frame.from_seq,
    events_msgpack: frame.events_msgpack,
  };
}

function toFoldInput(event: EoEvent): EoEventInput {
  // The fold assigns `seq` itself; drop the placeholder.
  const { seq, ...rest } = event;
  void seq;
  return rest as EoEventInput;
}
