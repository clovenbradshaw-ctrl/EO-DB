/**
 * WebRTC peer — Matrix-signaled DataChannel for bulk P2P data transfer.
 *
 * Uses Matrix to-device messages for SDP offer/answer and ICE candidate
 * exchange. Once a DataChannel is established, binary event batches are
 * streamed directly browser-to-browser without relaying through the
 * homeserver.
 *
 * The chunked transfer protocol sends msgpack-encoded event batches over
 * an ordered, reliable DataChannel with header/chunk/footer framing.
 *
 * Security:
 * - SDP/ICE exchanged over Megolm E2EE (Matrix to-device)
 * - DataChannel uses DTLS 1.2+ (browser-enforced)
 * - Application-layer encryption via segment keys (optional, for keyring spaces)
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { peerRtcEventTypes } from '../lib/matrix-domain';
import { getKeyById, resolveSnapshotKeyId } from '../crypto/segment-keys';
import { encryptPeerPayload, decryptPeerPayload } from '../crypto/snapshot-crypto';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const CHUNK_SIZE = 50;              // events per chunk
const DC_LABEL = 'eo-sync';
const PING_INTERVAL_MS = 30_000;    // keepalive every 30s
const CONNECTION_TIMEOUT_MS = 15_000;

const _rtcTypes = peerRtcEventTypes();
const RTC_OFFER = _rtcTypes.offer;
const RTC_ANSWER = _rtcTypes.answer;
const RTC_ICE = _rtcTypes.ice;
const RTC_HANGUP = _rtcTypes.hangup;

/**
 * Split a `${userId}:${deviceId}` peer key back into its components.
 * The userId may itself contain colons (Matrix user IDs are
 * `@name:server.tld`), so we split on the last colon.
 */
function splitPeerKey(peerKey: string): [string, string] {
  const idx = peerKey.lastIndexOf(':');
  if (idx <= 0) return [peerKey, ''];
  return [peerKey.slice(0, idx), peerKey.slice(idx + 1)];
}

/** Build the Map<userId, Map<deviceId, content>> structure for sendToDevice. */
export function toDeviceContent(userId: string, deviceId: string, content: Record<string, any>) {
  const inner = new Map<string, Record<string, any>>();
  inner.set(deviceId, content);
  const outer = new Map<string, Map<string, Record<string, any>>>();
  outer.set(userId, inner);
  return outer;
}

// ──────────────────────────────────────────────────────────────
// Chunked transfer protocol messages
// ──────────────────────────────────────────────────────────────

interface SyncStartMessage {
  type: 'sync-start';
  transfer_id: string;
  total_events: number;
  total_chunks: number;
  from_seq: number;
  to_seq: number;
}

interface ChunkMessage {
  type: 'chunk';
  transfer_id: string;
  index: number;
  data: Uint8Array;
}

interface SyncCompleteMessage {
  type: 'sync-complete';
  transfer_id: string;
  final_seq: number;
  checksum: string;
}

interface PingMessage {
  type: 'ping';
  ts: number;
}

interface PongMessage {
  type: 'pong';
  ts: number;
}

interface ResumeRequestMessage {
  type: 'resume';
  transfer_id: string;
  received_chunks: number[];
}

/**
 * Sync-layer v2 bulk frames (sync.md §4.3). These are single-DC-message
 * self-contained blobs — the receiver hash-verifies `content_hash`
 * against the canonical msgpack encoding before handing off to the fold.
 */
interface PieceBytesMessage {
  type: 'piece_bytes';
  req_id: string;
  piece_site: string;
  content_hash: string;
  events_msgpack: Uint8Array;
}

interface TailBytesMessage {
  type: 'tail_bytes';
  req_id: string;
  tail_site: string;
  from_seq: number;
  events_msgpack: Uint8Array;
}

export type SwarmV2BulkFrame = PieceBytesMessage | TailBytesMessage;

type DCMessage =
  | SyncStartMessage
  | ChunkMessage
  | SyncCompleteMessage
  | PingMessage
  | PongMessage
  | ResumeRequestMessage
  | PieceBytesMessage
  | TailBytesMessage;

// ──────────────────────────────────────────────────────────────
// ICE server configuration
// ──────────────────────────────────────────────────────────────

export interface IceConfig {
  stunServers?: string[];
  turnServers?: Array<{
    urls: string;
    username: string;
    credential: string;
  }>;
}

const DEFAULT_ICE: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function buildIceConfig(custom?: IceConfig): RTCConfiguration {
  if (!custom) return DEFAULT_ICE;
  const servers: RTCIceServer[] = [];
  if (custom.stunServers) {
    servers.push(...custom.stunServers.map(urls => ({ urls })));
  }
  if (custom.turnServers) {
    servers.push(...custom.turnServers.map(t => ({
      urls: t.urls,
      username: t.username,
      credential: t.credential,
    })));
  }
  return { iceServers: servers.length > 0 ? servers : DEFAULT_ICE.iceServers };
}

// ──────────────────────────────────────────────────────────────
// Transfer state (for resumability)
// ──────────────────────────────────────────────────────────────

export interface TransferState {
  transfer_id: string;
  total_chunks: number;
  received_chunks: Set<number>;
  events: EoEventInput[];
  from_seq: number;
  to_seq: number;
}

// ──────────────────────────────────────────────────────────────
// WebRTCPeer class
// ──────────────────────────────────────────────────────────────

export class WebRTCPeer {
  private client: MatrixClient;
  private roomId: string;
  private store: EoStore;
  private onEvent?: (event: any) => void;
  private keyring: LocalKeyring;
  private iceConfig: RTCConfiguration;

  /** Active peer connections keyed by `${userId}:${deviceId}`. */
  private connections = new Map<string, RTCPeerConnection>();
  /** Active data channels keyed by peer key. */
  private channels = new Map<string, RTCDataChannel>();
  /** Keepalive timers keyed by peer key. */
  private pingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Incoming transfer state for resumability. */
  private incomingTransfers = new Map<string, TransferState>();
  /** Buffered ICE candidates waiting for remote description, keyed by peer key. */
  private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  /** Matrix to-device event handler. */
  private toDeviceHandler?: (event: MatrixEvent) => void;
  /**
   * Callback invoked when a sync-layer v2 bulk frame arrives over a DC.
   * Wired up by the `network-sync-bridge` when the operator-native sync
   * mode is active. Left unset in the legacy peer-sync path.
   */
  private bulkFrameHandler?: (
    msg: SwarmV2BulkFrame,
    peerUserId: string,
    peerDeviceId: string,
  ) => void;
  /** Whether this peer has been destroyed. */
  private destroyed = false;

  constructor(
    client: MatrixClient,
    roomId: string,
    store: EoStore,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
    iceConfig?: IceConfig,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.store = store;
    this.onEvent = onEvent;
    this.keyring = keyring || { keys: new Map() };
    this.iceConfig = buildIceConfig(iceConfig);
  }

  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  // ────────────────────────────────────────────────────────────
  // Lifecycle
  // ────────────────────────────────────────────────────────────

  start(): void {
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
    }
    this.toDeviceHandler = (event: MatrixEvent) => this.handleSignalingEvent(event);
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);
  }

  stop(): void {
    this.destroyed = true;
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = undefined;
    }
    for (const timer of this.pingTimers.values()) clearInterval(timer);
    this.pingTimers.clear();
    for (const dc of this.channels.values()) dc.close();
    this.channels.clear();
    for (const pc of this.connections.values()) pc.close();
    this.connections.clear();
    this.incomingTransfers.clear();
  }

  /** Check if we have an active DataChannel to a peer. */
  hasChannel(userId: string, deviceId: string): boolean {
    const key = `${userId}:${deviceId}`;
    const dc = this.channels.get(key);
    return dc?.readyState === 'open';
  }

  /**
   * Register a handler for incoming sync-layer v2 bulk frames. The bridge
   * uses this to receive `piece_bytes` / `tail_bytes` messages.
   */
  setBulkFrameHandler(
    handler: (msg: SwarmV2BulkFrame, peerUserId: string, peerDeviceId: string) => void,
  ): void {
    this.bulkFrameHandler = handler;
  }

  /**
   * Send a sync-layer v2 bulk frame over an open DataChannel.
   *
   * Returns `false` if no DC is currently open — callers (bridge) fall
   * back to Matrix to-device in that case. Throws only on unexpected
   * send failures.
   */
  async sendBulkFrame(
    peerUserId: string,
    peerDeviceId: string,
    msg: SwarmV2BulkFrame,
  ): Promise<boolean> {
    const peerKey = `${peerUserId}:${peerDeviceId}`;
    const dc = this.channels.get(peerKey);
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(new Uint8Array(pack(msg)));
    return true;
  }

  // ────────────────────────────────────────────────────────────
  // Initiate a WebRTC connection (caller side)
  // ────────────────────────────────────────────────────────────

  /**
   * Initiate a WebRTC DataChannel connection to a peer for syncing events.
   * Sends an SDP offer via Matrix to-device messaging.
   */
  async connect(
    peerUserId: string,
    peerDeviceId: string,
    needFrom: number,
  ): Promise<void> {
    if (this.destroyed) return;
    const peerKey = `${peerUserId}:${peerDeviceId}`;

    // Tear down any existing connection to this peer
    this.teardown(peerKey);

    const pc = new RTCPeerConnection(this.iceConfig);
    this.connections.set(peerKey, pc);

    // Create DataChannel before creating offer (caller creates channel)
    const dc = pc.createDataChannel(DC_LABEL, {
      ordered: true,
    });
    this.setupDataChannel(dc, peerKey);

    // Gather ICE candidates and send via Matrix
    pc.onicecandidate = (e) => {
      if (e.candidate && !this.destroyed) {
        this.client.sendToDevice(RTC_ICE, toDeviceContent(
          peerUserId, peerDeviceId, {
            candidate: e.candidate.toJSON(),
            room_id: this.roomId,
          },
        )).catch((err: unknown) => console.warn('[EO-DB] Failed to send ICE candidate:', err));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.warn(`[EO-DB] WebRTC connection ${pc.connectionState} for ${peerKey}`);
        this.teardown(peerKey);
      }
    };

    // Create and send SDP offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.client.sendToDevice(RTC_OFFER, toDeviceContent(
      peerUserId, peerDeviceId, {
        sdp: offer.sdp,
        type: offer.type,
        need_from: needFrom,
        room_id: this.roomId,
        my_device: this.client.getDeviceId(),
      },
    ));

    // Timeout: if connection doesn't establish in time, clean up
    setTimeout(() => {
      if (pc.connectionState !== 'connected' && !this.destroyed) {
        console.warn('[EO-DB] WebRTC connection timed out for', peerKey);
        this.teardown(peerKey);
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  // ────────────────────────────────────────────────────────────
  // Send events over an established DataChannel
  // ────────────────────────────────────────────────────────────

  /**
   * Send events to a peer over an open DataChannel.
   * Uses the chunked transfer protocol with header/chunk/footer framing.
   */
  async sendEvents(
    peerUserId: string,
    peerDeviceId: string,
    fromSeq: number,
  ): Promise<void> {
    const peerKey = `${peerUserId}:${peerDeviceId}`;
    const dc = this.channels.get(peerKey);
    if (!dc || dc.readyState !== 'open') {
      throw new Error(`No open DataChannel to ${peerKey}`);
    }

    const events = await readLogSince(this.store, fromSeq);
    if (events.length === 0) return;

    const keyId = resolveSnapshotKeyId(this.keyring);
    const keyEntry = keyId ? getKeyById(this.keyring, keyId) : null;
    const totalChunks = Math.ceil(events.length / CHUNK_SIZE);
    const transferId = crypto.randomUUID();
    const currentSeq = await this.store.getCurrentSeq();

    // Send header
    const header: SyncStartMessage = {
      type: 'sync-start',
      transfer_id: transferId,
      total_events: events.length,
      total_chunks: totalChunks,
      from_seq: fromSeq,
      to_seq: currentSeq,
    };
    dc.send(new Uint8Array(pack(header)));

    // Send chunks
    for (let i = 0; i < events.length; i += CHUNK_SIZE) {
      const batch = events.slice(i, i + CHUNK_SIZE);
      const binaryBatch = pack(batch);

      // Encrypt if keyring has keys
      const payload = keyEntry
        ? pack(await encryptPeerPayload(keyEntry.key, keyId!, new Uint8Array(binaryBatch)))
        : binaryBatch;

      const chunk: ChunkMessage = {
        type: 'chunk',
        transfer_id: transferId,
        index: Math.floor(i / CHUNK_SIZE),
        data: payload,
      };
      dc.send(new Uint8Array(pack(chunk)));

      // Yield to avoid blocking the main thread on large transfers
      if (i % (CHUNK_SIZE * 10) === 0 && i > 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Send footer with checksum
    const allBinary = new Uint8Array(pack(events));
    const hashBuf = await crypto.subtle.digest('SHA-256', allBinary);
    const checksum = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const footer: SyncCompleteMessage = {
      type: 'sync-complete',
      transfer_id: transferId,
      final_seq: currentSeq,
      checksum,
    };
    dc.send(new Uint8Array(pack(footer)));
  }

  // ────────────────────────────────────────────────────────────
  // Handle incoming signaling messages
  // ────────────────────────────────────────────────────────────

  private async handleSignalingEvent(event: MatrixEvent): Promise<void> {
    const type = event.getType();
    const content = event.getContent();
    const sender = event.getSender()!;

    switch (type) {
      case RTC_OFFER:
        await this.handleOffer(sender, content);
        break;
      case RTC_ANSWER:
        await this.handleAnswer(sender, content);
        break;
      case RTC_ICE:
        await this.handleIce(sender, content);
        break;
      case RTC_HANGUP:
        this.handleHangup(sender, content);
        break;
    }
  }

  private async handleOffer(sender: string, content: Record<string, any>): Promise<void> {
    if (this.destroyed) return;
    const peerDeviceId = content.my_device;
    const peerKey = `${sender}:${peerDeviceId}`;

    // Tear down existing connection
    this.teardown(peerKey);

    const pc = new RTCPeerConnection(this.iceConfig);
    this.connections.set(peerKey, pc);

    // Handle incoming DataChannel (callee receives channel)
    pc.ondatachannel = (e) => {
      this.setupDataChannel(e.channel, peerKey);
      // If we have events the caller needs, send them once channel opens
      e.channel.onopen = () => {
        if (content.need_from !== undefined) {
          this.sendEvents(sender, peerDeviceId, content.need_from)
            .catch((err: unknown) => console.warn('[EO-DB] Failed to send events over WebRTC:', err));
        }
      };
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.destroyed) {
        this.client.sendToDevice(RTC_ICE, toDeviceContent(
          sender, peerDeviceId, {
            candidate: e.candidate.toJSON(),
            room_id: this.roomId,
          },
        )).catch(err => console.warn('[EO-DB] Failed to send ICE candidate:', err));
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.teardown(peerKey);
      }
    };

    // Set remote description and create answer
    await pc.setRemoteDescription(new RTCSessionDescription({
      type: content.type,
      sdp: content.sdp,
    }));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.drainPendingCandidates(peerKey, pc);

    await this.client.sendToDevice(RTC_ANSWER, toDeviceContent(
      sender, peerDeviceId, {
        sdp: answer.sdp,
        type: answer.type,
        room_id: this.roomId,
        my_device: this.client.getDeviceId(),
      },
    ));
  }

  private async handleAnswer(sender: string, content: Record<string, any>): Promise<void> {
    const peerKey = `${sender}:${content.my_device}`;
    const pc = this.connections.get(peerKey);
    if (!pc) return;

    await pc.setRemoteDescription(new RTCSessionDescription({
      type: content.type,
      sdp: content.sdp,
    }));
    await this.drainPendingCandidates(peerKey, pc);
  }

  private async handleIce(sender: string, content: Record<string, any>): Promise<void> {
    // Find the connection for this sender (try all known device IDs)
    for (const [key, pc] of this.connections) {
      if (key.startsWith(`${sender}:`)) {
        if (!pc.remoteDescription) {
          // Remote description not yet set — buffer until handleOffer/handleAnswer drains it
          const pending = this.pendingCandidates.get(key) ?? [];
          pending.push(content.candidate);
          this.pendingCandidates.set(key, pending);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(content.candidate));
          } catch (err) {
            console.warn('[EO-DB] Failed to add ICE candidate:', err);
          }
        }
        return;
      }
    }
  }

  private handleHangup(sender: string, content: Record<string, any>): void {
    const peerKey = content.my_device
      ? `${sender}:${content.my_device}`
      : undefined;
    if (peerKey) {
      this.teardown(peerKey);
    }
  }

  // ────────────────────────────────────────────────────────────
  // DataChannel setup and message handling
  // ────────────────────────────────────────────────────────────

  private setupDataChannel(dc: RTCDataChannel, peerKey: string): void {
    dc.binaryType = 'arraybuffer';
    this.channels.set(peerKey, dc);

    dc.onopen = () => {
      console.log(`[EO-DB] WebRTC DataChannel open: ${peerKey}`);
      // Start keepalive
      const timer = setInterval(() => {
        if (dc.readyState === 'open') {
          dc.send(new Uint8Array(pack({ type: 'ping', ts: Date.now() } as PingMessage)));
        }
      }, PING_INTERVAL_MS);
      this.pingTimers.set(peerKey, timer);
    };

    dc.onclose = () => {
      console.log(`[EO-DB] WebRTC DataChannel closed: ${peerKey}`);
      const timer = this.pingTimers.get(peerKey);
      if (timer) {
        clearInterval(timer);
        this.pingTimers.delete(peerKey);
      }
      this.channels.delete(peerKey);
    };

    dc.onmessage = (e) => {
      this.handleDCMessage(e.data, peerKey);
    };

    dc.onerror = (e) => {
      console.warn(`[EO-DB] WebRTC DataChannel error: ${peerKey}`, e);
    };
  }

  private async handleDCMessage(data: ArrayBuffer, peerKey: string): Promise<void> {
    let msg: DCMessage;
    try {
      msg = unpack(new Uint8Array(data)) as DCMessage;
    } catch {
      console.warn('[EO-DB] Failed to decode DataChannel message');
      return;
    }

    switch (msg.type) {
      case 'sync-start':
        this.handleSyncStart(msg);
        break;
      case 'chunk':
        await this.handleChunk(msg);
        break;
      case 'sync-complete':
        await this.handleSyncComplete(msg);
        break;
      case 'ping': {
        const dc = this.channels.get(peerKey);
        if (dc?.readyState === 'open') {
          dc.send(new Uint8Array(pack({ type: 'pong', ts: msg.ts } as PongMessage)));
        }
        break;
      }
      case 'pong':
        // Keepalive acknowledged — connection is alive
        break;
      case 'resume':
        // Peer is requesting we re-send missing chunks (future enhancement)
        break;
      case 'piece_bytes':
      case 'tail_bytes':
        if (this.bulkFrameHandler) {
          const [userId, deviceId] = splitPeerKey(peerKey);
          this.bulkFrameHandler(msg, userId, deviceId);
        }
        break;
    }
  }

  private handleSyncStart(msg: SyncStartMessage): void {
    this.incomingTransfers.set(msg.transfer_id, {
      transfer_id: msg.transfer_id,
      total_chunks: msg.total_chunks,
      received_chunks: new Set(),
      events: [],
      from_seq: msg.from_seq,
      to_seq: msg.to_seq,
    });
  }

  private async handleChunk(msg: ChunkMessage): Promise<void> {
    const transfer = this.incomingTransfers.get(msg.transfer_id);
    if (!transfer) return;

    transfer.received_chunks.add(msg.index);

    // Decode events from chunk data
    let events: EoEventInput[];
    try {
      const decoded = unpack(msg.data);
      if (decoded && decoded.encrypted) {
        // Encrypted payload — decrypt
        const entry = decoded.key_id ? getKeyById(this.keyring, decoded.key_id) : null;
        if (!entry) {
          console.warn('[EO-DB] Cannot decrypt WebRTC chunk — missing key', decoded.key_id);
          return;
        }
        const plaintext = await decryptPeerPayload(entry.key, decoded);
        events = unpack(plaintext) as EoEventInput[];
      } else if (Array.isArray(decoded)) {
        events = decoded;
      } else {
        events = unpack(decoded) as EoEventInput[];
      }
    } catch (err) {
      console.warn('[EO-DB] Failed to decode chunk:', err);
      return;
    }

    transfer.events.push(...events);
  }

  private async handleSyncComplete(msg: SyncCompleteMessage): Promise<void> {
    const transfer = this.incomingTransfers.get(msg.transfer_id);
    if (!transfer) return;

    // Check if all chunks were received
    if (transfer.received_chunks.size < transfer.total_chunks) {
      console.warn(
        `[EO-DB] WebRTC transfer incomplete: ${transfer.received_chunks.size}/${transfer.total_chunks} chunks`,
      );
      // Could request missing chunks via resume protocol in future
    }

    // Fold all received events
    for (const event of transfer.events) {
      await processEvent(this.store, event, this.onEvent);
    }

    console.log(
      `[EO-DB] WebRTC sync complete: ${transfer.events.length} events, ` +
      `seq ${transfer.from_seq}→${msg.final_seq}`,
    );

    this.incomingTransfers.delete(msg.transfer_id);
  }

  private async drainPendingCandidates(peerKey: string, pc: RTCPeerConnection): Promise<void> {
    const pending = this.pendingCandidates.get(peerKey);
    if (!pending?.length) return;
    this.pendingCandidates.delete(peerKey);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('[EO-DB] Failed to add buffered ICE candidate:', err);
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Teardown
  // ────────────────────────────────────────────────────────────

  private teardown(peerKey: string): void {
    const dc = this.channels.get(peerKey);
    if (dc) {
      dc.close();
      this.channels.delete(peerKey);
    }
    const pc = this.connections.get(peerKey);
    if (pc) {
      pc.close();
      this.connections.delete(peerKey);
    }
    const timer = this.pingTimers.get(peerKey);
    if (timer) {
      clearInterval(timer);
      this.pingTimers.delete(peerKey);
    }
    this.pendingCandidates.delete(peerKey);
  }

  /**
   * Gracefully close a connection and notify the peer via Matrix.
   */
  async disconnect(peerUserId: string, peerDeviceId: string): Promise<void> {
    const peerKey = `${peerUserId}:${peerDeviceId}`;
    this.teardown(peerKey);

    try {
      await this.client.sendToDevice(RTC_HANGUP, toDeviceContent(
        peerUserId, peerDeviceId, {
          room_id: this.roomId,
          my_device: this.client.getDeviceId(),
        },
      ));
    } catch {
      // Best-effort hangup signal
    }
  }
}
