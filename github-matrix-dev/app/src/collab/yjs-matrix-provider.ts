/**
 * Yjs Matrix Provider — bridges Yjs update/awareness protocol to Matrix transports.
 *
 * Three transport tiers:
 * 1. WebRTC DataChannel (P2P, sub-50ms) — Matrix signals the connection
 * 2. Matrix to-device messages (fallback, 100-300ms) — relayed through homeserver
 * 3. Matrix room events (persistence only) — handled by yjs-persistence.ts
 *
 * This provider handles tiers 1 and 2. Tier 3 is managed externally via
 * the debounced save in yjs-persistence.ts.
 *
 * Each richtext field gets its own provider + Y.Doc. Two users editing
 * different fields don't share a provider.
 */

import * as Y from 'yjs';
import { Observable } from 'lib0/observable';
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { writeUpdate, readUpdate } from 'y-protocols/sync';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import { collabEventTypes } from '../lib/matrix-domain';
import { toDeviceContent, buildIceConfig, type IceConfig } from '../matrix/webrtc-peer';
import { MSG_DOC_UPDATE, MSG_AWARENESS, type CollabTransport } from './types';

const _types = collabEventTypes();
const COLLAB_ANNOUNCE = _types.announce;
const COLLAB_UPDATE = _types.update;
const COLLAB_AWARENESS = _types.awareness;
const COLLAB_RTC_OFFER = _types.rtcOffer;
const COLLAB_RTC_ANSWER = _types.rtcAnswer;
const COLLAB_RTC_ICE = _types.rtcIce;
const COLLAB_LEAVE = _types.leave;

const DC_LABEL_PREFIX = 'yjs-collab-';
const WEBRTC_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Prefix a Yjs binary message with a 1-byte type tag. */
function tagMessage(tag: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.length);
  out[0] = tag;
  out.set(data, 1);
  return out;
}

/** Convert Uint8Array to ArrayBuffer for DataChannel.send(). */
function toBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

// --------------------------------------------------------------------------
// Peer connection state
// --------------------------------------------------------------------------

interface PeerConnection {
  userId: string;
  deviceId: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  pingTimer: ReturnType<typeof setInterval> | null;
}

// --------------------------------------------------------------------------
// YjsMatrixProvider
// --------------------------------------------------------------------------

export class YjsMatrixProvider extends Observable<string> {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly documentId: string;

  private client: MatrixClient;
  private roomId: string;
  private iceConfig: RTCConfiguration;
  private destroyed = false;
  private connected = false;

  /** Active WebRTC peer connections keyed by `userId:deviceId`. */
  private peers = new Map<string, PeerConnection>();
  /** Current dominant transport. */
  private _transport: CollabTransport = 'offline';
  /** Matrix to-device event handler reference. */
  private toDeviceHandler: ((event: MatrixEvent) => void) | null = null;
  /** Yjs doc update handler reference. */
  private docUpdateHandler: ((update: Uint8Array, origin: any) => void) | null = null;
  /** Awareness update handler reference. */
  private awarenessUpdateHandler: ((changed: { added: number[]; updated: number[]; removed: number[] }, origin: any) => void) | null = null;

  constructor(
    client: MatrixClient,
    roomId: string,
    documentId: string,
    doc: Y.Doc,
    iceConfig?: IceConfig,
  ) {
    super();
    this.client = client;
    this.roomId = roomId;
    this.documentId = documentId;
    this.doc = doc;
    this.awareness = new Awareness(doc);
    this.iceConfig = buildIceConfig(iceConfig);
  }

  get transport(): CollabTransport {
    return this._transport;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  // ────────────────────────────────────��─────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected || this.destroyed) return;
    this.connected = true;

    // Listen for Yjs doc updates — broadcast to all peers
    this.docUpdateHandler = (update: Uint8Array, origin: any) => {
      if (origin === this) return; // don't echo our own remote applies
      this.broadcastDocUpdate(update);
    };
    this.doc.on('update', this.docUpdateHandler);

    // Listen for awareness changes — broadcast to all peers
    this.awarenessUpdateHandler = (changed, origin) => {
      if (origin === 'remote') return;
      const changedClients = [...changed.added, ...changed.updated, ...changed.removed];
      const update = encodeAwarenessUpdate(this.awareness, changedClients);
      this.broadcastAwareness(update);
    };
    this.awareness.on('update', this.awarenessUpdateHandler);

    // Listen for Matrix to-device messages
    this.toDeviceHandler = (event: MatrixEvent) => this.handleToDeviceEvent(event);
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);

    // Set initial awareness state
    const myUserId = this.client.getUserId();
    const room = this.client.getRoom(this.roomId);
    const member = room && myUserId ? room.getMember(myUserId) : null;
    this.awareness.setLocalStateField('user', {
      name: member?.name || myUserId || 'Anonymous',
      userId: myUserId,
      deviceId: this.client.getDeviceId(),
    });

    // Announce to peers
    await this.announceEditing();
    this.setTransport('todevice');
    this.emit('status', [{ connected: true, transport: this._transport }]);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;

    // Announce departure
    this.announceDeparture().catch(() => {});

    // Clean up doc listener
    if (this.docUpdateHandler) {
      this.doc.off('update', this.docUpdateHandler);
      this.docUpdateHandler = null;
    }

    // Clean up awareness
    if (this.awarenessUpdateHandler) {
      this.awareness.off('update', this.awarenessUpdateHandler);
      this.awarenessUpdateHandler = null;
    }
    removeAwarenessStates(this.awareness, [this.doc.clientID], this);

    // Clean up Matrix listener
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = null;
    }

    // Tear down all peer connections
    for (const [key] of this.peers) {
      this.teardownPeer(key);
    }

    this.setTransport('offline');
    this.emit('status', [{ connected: false, transport: 'offline' }]);
  }

  destroy(): void {
    this.disconnect();
    this.destroyed = true;
    this.awareness.destroy();
    super.destroy();
  }

  // ───────────────────────────────────────���──────────────────────
  // Announce / leave
  // ──────────────────────────────────────────────────────────────

  private async announceEditing(): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;
    const myUserId = this.client.getUserId()!;

    for (const member of room.getJoinedMembers()) {
      if (member.userId === myUserId) continue;
      try {
        await this.client.sendToDevice(COLLAB_ANNOUNCE, toDeviceContent(
          member.userId, '*', {
            document_id: this.documentId,
            room_id: this.roomId,
            device: this.client.getDeviceId(),
          },
        ));
      } catch {
        // Best-effort
      }
    }
  }

  private async announceDeparture(): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;
    const myUserId = this.client.getUserId()!;

    for (const member of room.getJoinedMembers()) {
      if (member.userId === myUserId) continue;
      try {
        await this.client.sendToDevice(COLLAB_LEAVE, toDeviceContent(
          member.userId, '*', {
            document_id: this.documentId,
            room_id: this.roomId,
            device: this.client.getDeviceId(),
          },
        ));
      } catch {
        // Best-effort
      }
    }
  }

  // ───────────────────────────���─────────────────────��────────────
  // Broadcast updates to all peers
  // ──────────────────────────────────────────────────────────────

  private broadcastDocUpdate(update: Uint8Array): void {
    const tagged = tagMessage(MSG_DOC_UPDATE, update);

    // Try WebRTC first for each peer
    let sentViaRtc = false;
    for (const [, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') {
        peer.dc.send(toBuffer(tagged));
        sentViaRtc = true;
      }
    }

    // Fallback: send via to-device to any peer without an open DataChannel
    for (const [, peer] of this.peers) {
      if (!peer.dc || peer.dc.readyState !== 'open') {
        this.sendUpdateViaToDevice(peer.userId, peer.deviceId, update).catch(() => {});
      }
    }

    if (sentViaRtc && this._transport !== 'webrtc') {
      this.setTransport('webrtc');
    }
  }

  private broadcastAwareness(update: Uint8Array): void {
    const tagged = tagMessage(MSG_AWARENESS, update);

    for (const [, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') {
        peer.dc.send(toBuffer(tagged));
      } else {
        this.sendAwarenessViaToDevice(peer.userId, peer.deviceId, update).catch(() => {});
      }
    }
  }

  // ────────────���────────────────────────────��────────────────────
  // To-device fallback
  // ────────��─────────────────────────────────────────────────��───

  private async sendUpdateViaToDevice(userId: string, deviceId: string, update: Uint8Array): Promise<void> {
    await this.client.sendToDevice(COLLAB_UPDATE, toDeviceContent(
      userId, deviceId, {
        document_id: this.documentId,
        data: uint8ToBase64(update),
      },
    ));
  }

  private async sendAwarenessViaToDevice(userId: string, deviceId: string, update: Uint8Array): Promise<void> {
    await this.client.sendToDevice(COLLAB_AWARENESS, toDeviceContent(
      userId, deviceId, {
        document_id: this.documentId,
        data: uint8ToBase64(update),
      },
    ));
  }

  // ────────────���─────────────────────────────��───────────────────
  // Handle incoming Matrix to-device messages
  // ──────────────────────────────���───────────────────────────────

  private handleToDeviceEvent(event: MatrixEvent): void {
    if (this.destroyed || !this.connected) return;

    const type = event.getType();
    const content = event.getContent();
    const sender = event.getSender();
    if (!sender) return;

    // Scope to our document
    if (content.document_id && content.document_id !== this.documentId) return;

    switch (type) {
      case COLLAB_ANNOUNCE:
        this.handleAnnounce(sender, content);
        break;
      case COLLAB_LEAVE:
        this.handleLeave(sender, content);
        break;
      case COLLAB_UPDATE:
        this.handleRemoteUpdate(content);
        break;
      case COLLAB_AWARENESS:
        this.handleRemoteAwareness(content);
        break;
      case COLLAB_RTC_OFFER:
        this.handleRtcOffer(sender, content);
        break;
      case COLLAB_RTC_ANSWER:
        this.handleRtcAnswer(sender, content);
        break;
      case COLLAB_RTC_ICE:
        this.handleRtcIce(sender, content);
        break;
    }
  }

  private handleAnnounce(sender: string, content: Record<string, any>): void {
    if (content.room_id && content.room_id !== this.roomId) return;
    const deviceId = content.device || '*';
    const peerKey = `${sender}:${deviceId}`;

    // Already connected to this peer
    if (this.peers.has(peerKey)) return;

    // Initiate WebRTC connection to the new peer
    this.initiateWebRTC(sender, deviceId);
  }

  private handleLeave(sender: string, content: Record<string, any>): void {
    const deviceId = content.device || '*';
    this.teardownPeer(`${sender}:${deviceId}`);
  }

  private handleRemoteUpdate(content: Record<string, any>): void {
    if (!content.data) return;
    const update = base64ToUint8(content.data);
    Y.applyUpdate(this.doc, update, this);
  }

  private handleRemoteAwareness(content: Record<string, any>): void {
    if (!content.data) return;
    const update = base64ToUint8(content.data);
    applyAwarenessUpdate(this.awareness, update, 'remote');
  }

  // ─────────────────────────────────────────────��────────────────
  // WebRTC — initiate connection (caller side)
  // ──────────────────────────────────────────────────────────────

  private async initiateWebRTC(peerUserId: string, peerDeviceId: string): Promise<void> {
    const peerKey = `${peerUserId}:${peerDeviceId}`;

    // If WebRTC is not available (e.g. Node.js test env), register peer for to-device only
    if (typeof RTCPeerConnection === 'undefined') {
      this.peers.set(peerKey, {
        userId: peerUserId,
        deviceId: peerDeviceId,
        pc: null as any,
        dc: null,
        pingTimer: null,
      });
      return;
    }

    // Register peer immediately (even before WebRTC connects)
    // so to-device fallback works
    const pc = new RTCPeerConnection(this.iceConfig);
    const peer: PeerConnection = {
      userId: peerUserId,
      deviceId: peerDeviceId,
      pc,
      dc: null,
      pingTimer: null,
    };
    this.peers.set(peerKey, peer);

    // Create DataChannel before offer
    const dc = pc.createDataChannel(DC_LABEL_PREFIX + this.documentId, { ordered: true });
    this.setupDataChannel(dc, peerKey);

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate && !this.destroyed) {
        this.client.sendToDevice(COLLAB_RTC_ICE, toDeviceContent(
          peerUserId, peerDeviceId, {
            document_id: this.documentId,
            candidate: e.candidate.toJSON(),
          },
        )).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // WebRTC failed — peer stays registered for to-device fallback
        const existing = this.peers.get(peerKey);
        if (existing) {
          if (existing.dc) existing.dc.close();
          existing.dc = null;
          existing.pc.close();
        }
      }
    };

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.client.sendToDevice(COLLAB_RTC_OFFER, toDeviceContent(
      peerUserId, peerDeviceId, {
        document_id: this.documentId,
        sdp: offer.sdp,
        type: offer.type,
        device: this.client.getDeviceId(),
        room_id: this.roomId,
      },
    ));

    // Timeout: if WebRTC doesn't connect, rely on to-device
    setTimeout(() => {
      const p = this.peers.get(peerKey);
      if (p && (!p.dc || p.dc.readyState !== 'open')) {
        // WebRTC didn't establish — to-device is the active transport
        if (this._transport === 'webrtc') this.recomputeTransport();
      }
    }, WEBRTC_TIMEOUT_MS);
  }

  // ──────────────────────────────────────���───────────────────────
  // WebRTC — handle incoming offer (callee side)
  // ───────────────────��──────────────────────────────────────────

  private async handleRtcOffer(sender: string, content: Record<string, any>): Promise<void> {
    if (this.destroyed) return;
    if (typeof RTCPeerConnection === 'undefined') return; // WebRTC not available

    const peerDeviceId = content.device || '*';
    const peerKey = `${sender}:${peerDeviceId}`;

    // Tear down existing connection to this peer if any
    this.teardownPeer(peerKey);

    const pc = new RTCPeerConnection(this.iceConfig);
    const peer: PeerConnection = {
      userId: sender,
      deviceId: peerDeviceId,
      pc,
      dc: null,
      pingTimer: null,
    };
    this.peers.set(peerKey, peer);

    // Handle incoming DataChannel
    pc.ondatachannel = (e) => {
      this.setupDataChannel(e.channel, peerKey);
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && !this.destroyed) {
        this.client.sendToDevice(COLLAB_RTC_ICE, toDeviceContent(
          sender, peerDeviceId, {
            document_id: this.documentId,
            candidate: e.candidate.toJSON(),
          },
        )).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        const existing = this.peers.get(peerKey);
        if (existing) {
          if (existing.dc) existing.dc.close();
          existing.dc = null;
          existing.pc.close();
        }
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription({
      type: content.type,
      sdp: content.sdp,
    }));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await this.client.sendToDevice(COLLAB_RTC_ANSWER, toDeviceContent(
      sender, peerDeviceId, {
        document_id: this.documentId,
        sdp: answer.sdp,
        type: answer.type,
        device: this.client.getDeviceId(),
        room_id: this.roomId,
      },
    ));
  }

  private async handleRtcAnswer(sender: string, content: Record<string, any>): Promise<void> {
    const peerDeviceId = content.device || '*';
    const peerKey = `${sender}:${peerDeviceId}`;
    const peer = this.peers.get(peerKey);
    if (!peer) return;

    await peer.pc.setRemoteDescription(new RTCSessionDescription({
      type: content.type,
      sdp: content.sdp,
    }));
  }

  private handleRtcIce(sender: string, content: Record<string, any>): void {
    if (!content.candidate) return;
    // Find peer connection for this sender
    for (const [key, peer] of this.peers) {
      if (key.startsWith(`${sender}:`)) {
        peer.pc.addIceCandidate(new RTCIceCandidate(content.candidate))
          .catch(() => {});
        return;
      }
    }
  }

  // ──────────────────────────────────────────────────────────────
  // DataChannel setup
  // ──────────────────────��─────────────────────────────────────��─

  private setupDataChannel(dc: RTCDataChannel, peerKey: string): void {
    const peer = this.peers.get(peerKey);
    if (!peer) return;

    dc.binaryType = 'arraybuffer';
    peer.dc = dc;

    dc.onopen = () => {
      this.setTransport('webrtc');
      this.emit('status', [{ connected: true, transport: 'webrtc' }]);

      // Send full state to new peer for initial sync
      const stateUpdate = Y.encodeStateAsUpdate(this.doc);
      dc.send(toBuffer(tagMessage(MSG_DOC_UPDATE, stateUpdate)));

      // Send current awareness
      const awarenessUpdate = encodeAwarenessUpdate(
        this.awareness,
        Array.from(this.awareness.getStates().keys()),
      );
      dc.send(toBuffer(tagMessage(MSG_AWARENESS, awarenessUpdate)));

      // Keepalive
      peer.pingTimer = setInterval(() => {
        if (dc.readyState === 'open') {
          dc.send(toBuffer(new Uint8Array([0xFF]))); // ping byte
        }
      }, PING_INTERVAL_MS);
    };

    dc.onmessage = (e) => {
      const data = new Uint8Array(e.data as ArrayBuffer);
      if (data.length === 0) return;

      const tag = data[0];
      if (tag === 0xFF) return; // ping/pong

      const payload = data.subarray(1);

      switch (tag) {
        case MSG_DOC_UPDATE:
          Y.applyUpdate(this.doc, payload, this);
          break;
        case MSG_AWARENESS:
          applyAwarenessUpdate(this.awareness, payload, 'remote');
          break;
      }
    };

    dc.onclose = () => {
      if (peer.pingTimer) {
        clearInterval(peer.pingTimer);
        peer.pingTimer = null;
      }
      peer.dc = null;
      this.recomputeTransport();
    };

    dc.onerror = () => {
      if (peer.pingTimer) {
        clearInterval(peer.pingTimer);
        peer.pingTimer = null;
      }
      peer.dc = null;
      this.recomputeTransport();
    };
  }

  // ────────────────────────────────��─────────────────────────────
  // Teardown
  // ──────────────���─────────────────────���──────────────────────��──

  private teardownPeer(peerKey: string): void {
    const peer = this.peers.get(peerKey);
    if (!peer) return;

    if (peer.pingTimer) {
      clearInterval(peer.pingTimer);
      peer.pingTimer = null;
    }
    if (peer.dc) {
      try { peer.dc.close(); } catch { /* ignore */ }
    }
    try { peer.pc.close(); } catch { /* ignore */ }
    this.peers.delete(peerKey);
    this.recomputeTransport();
  }

  // ──────────────────────────────────────────���───────────────────
  // Transport status
  // ─────────────��───────────────────────────────────────────────��

  private setTransport(t: CollabTransport): void {
    if (this._transport !== t) {
      this._transport = t;
      this.emit('transport', [t]);
    }
  }

  private recomputeTransport(): void {
    if (!this.connected) {
      this.setTransport('offline');
      return;
    }
    // If any peer has an open DataChannel, we're on WebRTC
    for (const [, peer] of this.peers) {
      if (peer.dc?.readyState === 'open') {
        this.setTransport('webrtc');
        return;
      }
    }
    // If we have peers but no WebRTC, we're on to-device
    if (this.peers.size > 0) {
      this.setTransport('todevice');
      return;
    }
    this.setTransport('todevice'); // still connected, just no peers yet
  }
}
