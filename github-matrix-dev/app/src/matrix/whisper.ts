/**
 * Whisper — ephemeral P2P messaging over WebRTC DataChannel.
 *
 * Matrix is used ONLY for WebRTC signaling (SDP offer/answer + ICE candidates).
 * All message content flows directly browser-to-browser over an encrypted
 * DataChannel. Nothing is stored on Matrix — no events, no metadata, no traces.
 *
 * This is pure SIG in EO terms: real-time, ephemeral, not logged.
 * When the tab closes, everything is gone.
 *
 * Security:
 * - SDP/ICE exchanged via Matrix to-device messages (Megolm E2EE)
 * - DataChannel uses DTLS 1.2+ (browser-enforced)
 * - Application-layer AES-256-GCM encryption on every message (optional, requires keyring)
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { LocalKeyring } from '../db/crypto-types';
import { whisperEventTypes } from '../lib/matrix-domain';
import { toDeviceContent, buildIceConfig, type IceConfig } from './webrtc-peer';
import { getKeyById, resolveSnapshotKeyId } from '../crypto/segment-keys';
import { encryptPeerPayload, decryptPeerPayload } from '../crypto/snapshot-crypto';

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const DC_LABEL = 'whisper';
const PING_INTERVAL_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 15_000;
const TYPING_DEBOUNCE_MS = 3_000;

const _types = whisperEventTypes();
const WHISPER_INVITE = _types.invite;
const WHISPER_ACCEPT = _types.accept;
const WHISPER_DECLINE = _types.decline;
const WHISPER_ICE = _types.ice;

// ──────────────────────────────────────────────────────────────
// Message types (DataChannel only — never touches Matrix)
// ──────────────────────────────────────────────────────────────

export interface WhisperMessage {
  type: 'msg';
  id: string;
  text: string;
  ts: number;
  sender: string;
}

interface WhisperTyping {
  type: 'typing';
  active: boolean;
}

interface WhisperRead {
  type: 'read';
  upTo: string; // id of last read message
}

interface WhisperPing {
  type: 'ping';
  ts: number;
}

interface WhisperPong {
  type: 'pong';
  ts: number;
}

type WhisperDCMessage =
  | WhisperMessage
  | WhisperTyping
  | WhisperRead
  | WhisperPing
  | WhisperPong;

// ──────────────────────────────────────────────────────────────
// Channel state
// ──────────────────────────────────────────────────────────────

export type WhisperState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface WhisperEventHandlers {
  onMessage: (msg: WhisperMessage) => void;
  onTyping: (active: boolean) => void;
  onRead: (upTo: string) => void;
  onStateChange: (state: WhisperState) => void;
}

// ──────────────────────────────────────────────────────────────
// WhisperChannel class
// ──────────────────────────────────────────────────────────────

export class WhisperChannel {
  private client: MatrixClient;
  private peerUserId: string;
  private peerDeviceId: string;
  private handlers: WhisperEventHandlers;
  private keyring: LocalKeyring;
  private iceConfig: RTCConfiguration;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private toDeviceHandler: ((event: MatrixEvent) => void) | null = null;
  private _state: WhisperState = 'idle';
  private destroyed = false;

  constructor(
    client: MatrixClient,
    peerUserId: string,
    peerDeviceId: string,
    handlers: WhisperEventHandlers,
    keyring?: LocalKeyring,
    iceConfig?: IceConfig,
  ) {
    this.client = client;
    this.peerUserId = peerUserId;
    this.peerDeviceId = peerDeviceId;
    this.handlers = handlers;
    this.keyring = keyring || { keys: new Map() };
    this.iceConfig = buildIceConfig(iceConfig);
  }

  get state(): WhisperState {
    return this._state;
  }

  private setState(s: WhisperState): void {
    if (this._state === s) return;
    this._state = s;
    this.handlers.onStateChange(s);
  }

  // ────────────────────────────────────────────────────────────
  // Initiate a whisper session (caller side)
  // ────────────────────────────────────────────────────────────

  async invite(): Promise<void> {
    if (this.destroyed) return;
    this.setState('connecting');
    this.attachSignalingListener();

    this.pc = new RTCPeerConnection(this.iceConfig);
    this.setupPeerConnectionEvents(this.pc);

    // Create the DataChannel BEFORE creating the offer
    this.dc = this.pc.createDataChannel(DC_LABEL, { ordered: true });
    this.attachDataChannelEvents(this.dc);

    // Create and send SDP offer via Matrix to-device
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    await this.client.sendToDevice(WHISPER_INVITE, toDeviceContent(
      this.peerUserId, this.peerDeviceId, {
        sdp: offer.sdp,
        type: offer.type,
        device: this.client.getDeviceId(),
        room_id: '', // whisper is not room-scoped
      },
    ));

    // Timeout if connection doesn't establish
    this.connectionTimer = setTimeout(() => {
      if (this._state === 'connecting') {
        console.warn('[EO-DB] Whisper connection timeout');
        this.close();
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  // ────────────────────────────────────────────────────────────
  // Accept an incoming whisper invitation (callee side)
  // ────────────────────────────────────────────────────────────

  async accept(sdpOffer: RTCSessionDescriptionInit): Promise<void> {
    if (this.destroyed) return;
    this.setState('connecting');
    this.attachSignalingListener();

    this.pc = new RTCPeerConnection(this.iceConfig);
    this.setupPeerConnectionEvents(this.pc);

    // Callee receives DataChannel via ondatachannel event
    this.pc.ondatachannel = (ev) => {
      this.dc = ev.channel;
      this.attachDataChannelEvents(this.dc);
    };

    await this.pc.setRemoteDescription(sdpOffer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    await this.client.sendToDevice(WHISPER_ACCEPT, toDeviceContent(
      this.peerUserId, this.peerDeviceId, {
        sdp: answer.sdp,
        type: answer.type,
        device: this.client.getDeviceId(),
      },
    ));

    this.connectionTimer = setTimeout(() => {
      if (this._state === 'connecting') {
        console.warn('[EO-DB] Whisper connection timeout (callee)');
        this.close();
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  // ────────────────────────────────────────────────────────────
  // Send a text message
  // ────────────────────────────────────────────────────────────

  async send(text: string): Promise<WhisperMessage | null> {
    if (!this.dc || this.dc.readyState !== 'open') return null;

    const msg: WhisperMessage = {
      type: 'msg',
      id: crypto.randomUUID(),
      text,
      ts: Date.now(),
      sender: this.client.getUserId()!,
    };

    await this.sendDC(msg);
    return msg;
  }

  /** Send a typing indicator. */
  async sendTyping(active: boolean): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') return;
    await this.sendDC({ type: 'typing', active });
  }

  /** Send a read receipt up to a message ID. */
  async sendRead(upTo: string): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') return;
    await this.sendDC({ type: 'read', upTo });
  }

  // ────────────────────────────────────────────────────────────
  // Close the whisper session
  // ────────────────────────────────────────────────────────────

  close(): void {
    this.destroyed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
    if (this.dc) {
      try { this.dc.close(); } catch { /* ignore */ }
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = null;
    }
    this.setState('disconnected');
  }

  // ────────────────────────────────────────────────────────────
  // Private: DataChannel I/O
  // ────────────────────────────────────────────────────────────

  private async sendDC(msg: WhisperDCMessage): Promise<void> {
    if (!this.dc || this.dc.readyState !== 'open') return;

    const raw = pack(msg);
    const keyId = resolveSnapshotKeyId(this.keyring);
    const keyEntry = keyId ? getKeyById(this.keyring, keyId) : null;

    if (keyEntry) {
      const encrypted = await encryptPeerPayload(keyEntry.key, keyId!, new Uint8Array(raw));
      this.dc.send(new Uint8Array(pack(encrypted)));
    } else {
      this.dc.send(new Uint8Array(raw));
    }
  }

  private async handleDCMessage(data: ArrayBuffer | Uint8Array): Promise<void> {
    try {
      let decoded = unpack(new Uint8Array(data));

      // Decrypt if encrypted
      if (decoded && decoded.encrypted) {
        const entry = getKeyById(this.keyring, decoded.key_id);
        if (!entry) {
          console.warn('[EO-DB] Whisper: cannot decrypt — missing key', decoded.key_id);
          return;
        }
        const plaintext = await decryptPeerPayload(entry.key, decoded);
        decoded = unpack(plaintext);
      }

      const msg = decoded as WhisperDCMessage;
      switch (msg.type) {
        case 'msg':
          this.handlers.onMessage(msg as WhisperMessage);
          break;
        case 'typing':
          this.handlers.onTyping(msg.active);
          break;
        case 'read':
          this.handlers.onRead(msg.upTo);
          break;
        case 'pong':
          // Keepalive acknowledged — connection is alive
          break;
        case 'ping':
          // Respond to keepalive
          this.sendDC({ type: 'pong', ts: Date.now() });
          break;
      }
    } catch (e) {
      console.warn('[EO-DB] Whisper: failed to decode message:', e);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Private: WebRTC setup
  // ────────────────────────────────────────────────────────────

  private setupPeerConnectionEvents(pc: RTCPeerConnection): void {
    pc.onicecandidate = (ev) => {
      if (ev.candidate && !this.destroyed) {
        this.client.sendToDevice(WHISPER_ICE, toDeviceContent(
          this.peerUserId, this.peerDeviceId, {
            candidate: ev.candidate.toJSON(),
            device: this.client.getDeviceId(),
          },
        )).catch(e => console.warn('[EO-DB] Whisper ICE send failed:', e));
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.destroyed) return;
      const s = pc.connectionState;
      if (s === 'connected') {
        if (this.connectionTimer) {
          clearTimeout(this.connectionTimer);
          this.connectionTimer = null;
        }
        this.setState('connected');
      } else if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this.close();
      }
    };
  }

  private attachDataChannelEvents(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      if (this.destroyed) return;
      if (this.connectionTimer) {
        clearTimeout(this.connectionTimer);
        this.connectionTimer = null;
      }
      this.setState('connected');
      // Start keepalive pings
      this.pingTimer = setInterval(() => {
        this.sendDC({ type: 'ping', ts: Date.now() });
      }, PING_INTERVAL_MS);
    };

    dc.onmessage = (ev) => {
      if (this.destroyed) return;
      this.handleDCMessage(ev.data);
    };

    dc.onclose = () => {
      if (!this.destroyed) this.close();
    };

    dc.onerror = (ev) => {
      console.warn('[EO-DB] Whisper DataChannel error:', ev);
      if (!this.destroyed) this.close();
    };
  }

  // ────────────────────────────────────────────────────────────
  // Private: Matrix signaling listener (for SDP answer + ICE)
  // ────────────────────────────────────────────────────────────

  private attachSignalingListener(): void {
    if (this.toDeviceHandler) return; // already attached

    this.toDeviceHandler = (event: MatrixEvent) => {
      if (this.destroyed) return;
      const type = event.getType();
      const content = event.getContent();
      const sender = event.getSender();
      if (sender !== this.peerUserId) return;

      if (type === WHISPER_ACCEPT && this.pc) {
        this.pc.setRemoteDescription({
          type: content.type,
          sdp: content.sdp,
        }).catch(e => console.warn('[EO-DB] Whisper: failed to set remote SDP:', e));
      } else if (type === WHISPER_ICE && this.pc && content.candidate) {
        this.pc.addIceCandidate(new RTCIceCandidate(content.candidate))
          .catch(e => console.warn('[EO-DB] Whisper: failed to add ICE candidate:', e));
      } else if (type === WHISPER_DECLINE) {
        console.log('[EO-DB] Whisper declined by', sender);
        this.close();
      }
    };

    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);
  }
}

// ──────────────────────────────────────────────────────────────
// WhisperManager — manages incoming invitations + active channels
// ──────────────────────────────────────────────────────────────

export interface WhisperInvitation {
  fromUserId: string;
  fromDeviceId: string;
  sdp: RTCSessionDescriptionInit;
}

export class WhisperManager {
  private client: MatrixClient;
  private keyring: LocalKeyring;
  private channels = new Map<string, WhisperChannel>();
  private toDeviceHandler: ((event: MatrixEvent) => void) | null = null;
  private onInvitation: ((invitation: WhisperInvitation) => void) | null = null;
  private destroyed = false;

  constructor(client: MatrixClient, keyring?: LocalKeyring) {
    this.client = client;
    this.keyring = keyring || { keys: new Map() };
  }

  /** Start listening for incoming whisper invitations. */
  start(onInvitation: (invitation: WhisperInvitation) => void): void {
    this.onInvitation = onInvitation;
    this.toDeviceHandler = (event: MatrixEvent) => {
      if (this.destroyed) return;
      const type = event.getType();
      if (type !== WHISPER_INVITE) return;

      const content = event.getContent();
      const sender = event.getSender();
      if (!sender) return;

      this.onInvitation?.({
        fromUserId: sender,
        fromDeviceId: content.device || '*',
        sdp: { type: content.type, sdp: content.sdp },
      });
    };
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);
  }

  /** Accept an invitation and create a channel. */
  async acceptInvitation(
    invitation: WhisperInvitation,
    handlers: WhisperEventHandlers,
  ): Promise<WhisperChannel> {
    const channel = new WhisperChannel(
      this.client,
      invitation.fromUserId,
      invitation.fromDeviceId,
      handlers,
      this.keyring,
    );
    await channel.accept(invitation.sdp);
    const key = `${invitation.fromUserId}:${invitation.fromDeviceId}`;
    this.channels.set(key, channel);
    return channel;
  }

  /** Decline an invitation. */
  async declineInvitation(invitation: WhisperInvitation): Promise<void> {
    await this.client.sendToDevice(WHISPER_DECLINE, toDeviceContent(
      invitation.fromUserId, invitation.fromDeviceId, {
        device: this.client.getDeviceId(),
      },
    ));
  }

  /** Initiate a whisper to a peer. */
  async invite(
    peerUserId: string,
    peerDeviceId: string,
    handlers: WhisperEventHandlers,
  ): Promise<WhisperChannel> {
    const channel = new WhisperChannel(
      this.client,
      peerUserId,
      peerDeviceId,
      handlers,
      this.keyring,
    );
    await channel.invite();
    const key = `${peerUserId}:${peerDeviceId}`;
    this.channels.set(key, channel);
    return channel;
  }

  /** Get an active channel by peer key. */
  getChannel(peerUserId: string, peerDeviceId: string): WhisperChannel | undefined {
    return this.channels.get(`${peerUserId}:${peerDeviceId}`);
  }

  /** Close a specific channel. */
  closeChannel(peerUserId: string, peerDeviceId: string): void {
    const key = `${peerUserId}:${peerDeviceId}`;
    const channel = this.channels.get(key);
    if (channel) {
      channel.close();
      this.channels.delete(key);
    }
  }

  /** Stop listening and close all channels. */
  destroy(): void {
    this.destroyed = true;
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = null;
    }
    for (const channel of this.channels.values()) {
      channel.close();
    }
    this.channels.clear();
  }
}
