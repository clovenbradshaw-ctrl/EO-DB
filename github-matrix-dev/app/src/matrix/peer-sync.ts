/**
 * Peer sync — device-to-device gap filling via Matrix to-device messaging.
 *
 * Protocol:
 * 1. hello   — announce own seq + store fingerprint to all room members
 * 2. offer   — respond with own seq + fingerprint + gap detection
 * 3. request — ask peer for missing events (by seq range or full exchange)
 * 4. events  — batch of EO events (max 50 per message)
 *
 * Key improvement over naive seq comparison: the store fingerprint (a hash
 * of all projected state) detects divergence even when two devices have the
 * same seq number but different event histories (e.g., both created events
 * offline). When fingerprints diverge, we fall back to a full event exchange
 * where the receiver deduplicates via content-addressable event hashes.
 */

import { pack, unpack } from 'msgpackr';
import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput, EoState } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { storeFingerprint } from '../db/hash';
import { peerSyncEventTypes } from '../lib/matrix-domain';
import { getKeyById, resolveSnapshotKeyId } from '../crypto/segment-keys';
import { encryptPeerPayload, decryptPeerPayload } from '../crypto/snapshot-crypto';
import { selectTransport, executeSync, type TransportRouterDeps, type PeerInfo } from './transport-router';
import type { WebRTCPeer } from './webrtc-peer';

const _syncTypes = peerSyncEventTypes();
const SYNC_HELLO = _syncTypes.hello;
const SYNC_OFFER = _syncTypes.offer;
const SYNC_REQUEST = _syncTypes.request;
const SYNC_EVENTS = _syncTypes.events;

const BATCH_SIZE = 50;

/** Build the Map<userId, Map<deviceId, content>> structure for sendToDevice. */
function toDeviceContent(userId: string, deviceId: string, content: Record<string, any>) {
  const inner = new Map<string, Record<string, any>>();
  inner.set(deviceId, content);
  const outer = new Map<string, Map<string, Record<string, any>>>();
  outer.set(userId, inner);
  return outer;
}

/** Gap size threshold for upgrading to WebRTC or Filen transport. */
const GAP_THRESHOLD = 100;

export class PeerSync {
  private client: MatrixClient;
  private roomId: string;
  private store: EoStore;
  private onEvent?: (event: any) => void;
  private keyring: LocalKeyring;
  private toDeviceHandler?: (event: MatrixEvent) => void;

  /** Optional WebRTC peer for direct browser-to-browser transfers. */
  private webrtcPeer: WebRTCPeer | null = null;

  constructor(
    client: MatrixClient,
    roomId: string,
    store: EoStore,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.store = store;
    this.onEvent = onEvent;
    this.keyring = keyring || { keys: new Map() };
  }

  /** Allow updating keyring after construction. */
  setKeyring(keyring: LocalKeyring): void {
    this.keyring = keyring;
  }

  /** Attach a WebRTC peer instance for transport upgrades. */
  setWebRTCPeer(peer: WebRTCPeer): void {
    this.webrtcPeer = peer;
  }

  /**
   * Start peer sync — announce presence and listen for messages.
   */
  async start(): Promise<void> {
    // Remove previous listener if start() is called again
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
    }

    // Attach listener BEFORE announcing — if announceToPeers() fails,
    // we can still receive peer messages (they may hello us first).
    this.toDeviceHandler = (event: MatrixEvent) => {
      this.handleToDeviceEvent(event);
    };
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);

    try {
      await this.announceToPeers();
    } catch (e) {
      // Non-fatal — listener is active, peers can still reach us.
      console.warn('[EO-DB] PeerSync announce failed:', e);
    }
  }

  /**
   * Stop peer sync — remove the event listener.
   */
  stop(): void {
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = undefined;
    }
  }

  /**
   * Compute the store fingerprint for comparison with peers.
   */
  private async computeFingerprint(): Promise<string> {
    const stateEntries = await this.store.iterator('state:');
    const entries: Array<{ target: string; last_seq: number; hash?: string }> = [];
    for (const [key, value] of stateEntries) {
      const state = value as EoState;
      entries.push({
        target: key.slice(6), // remove 'state:'
        last_seq: state.last_seq,
        hash: state.hash,
      });
    }
    return storeFingerprint(entries);
  }

  /**
   * Announce our current seq + fingerprint to all devices in the room.
   */
  private async announceToPeers(): Promise<void> {
    const mySeq = await this.store.getCurrentSeq();
    const fingerprint = await this.computeFingerprint();
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    const members = room.getJoinedMembers();
    const myUserId = this.client.getUserId()!;

    for (const member of members) {
      if (member.userId === myUserId) continue;

      await this.client.sendToDevice(SYNC_HELLO, toDeviceContent(
        member.userId, '*', {
          my_seq: mySeq,
          my_fingerprint: fingerprint,
          my_device: this.client.getDeviceId(),
          room_id: this.roomId,
          rtc_capable: this.webrtcPeer !== null,
        },
      ));
    }
  }

  /**
   * Route incoming to-device messages.
   */
  private async handleToDeviceEvent(event: MatrixEvent): Promise<void> {
    const type = event.getType();
    const content = event.getContent();
    const sender = event.getSender()!;

    switch (type) {
      case SYNC_HELLO:
        await this.handleHello(sender, content.my_device, content.my_seq, content.my_fingerprint, content.rtc_capable);
        break;
      case SYNC_OFFER:
        await this.handleOffer(sender, content);
        break;
      case SYNC_REQUEST:
        await this.sendEventsToPeer(sender, content.from_device, content.need_from);
        break;
      case SYNC_EVENTS:
        await this.processIncomingPeerEvents(content);
        break;
    }
  }

  private async handleHello(
    senderUserId: string,
    senderDeviceId: string,
    theirSeq: number,
    theirFingerprint?: string,
    theirRtcCapable?: boolean,
  ): Promise<void> {
    const mySeq = await this.store.getCurrentSeq();
    const myFingerprint = await this.computeFingerprint();

    // Detect divergence: same or similar seq but different fingerprints
    // means the devices have different event histories.
    const fingerprintMatch = theirFingerprint
      ? myFingerprint === theirFingerprint
      : null; // legacy peer without fingerprint support

    const hasEventsTheyNeed = mySeq > theirSeq || (fingerprintMatch === false && mySeq > 0);
    const needsEventsFromThem = theirSeq > mySeq || (fingerprintMatch === false && theirSeq > 0);

    await this.client.sendToDevice(SYNC_OFFER, toDeviceContent(
      senderUserId, senderDeviceId, {
        my_seq: mySeq,
        my_fingerprint: myFingerprint,
        my_device: this.client.getDeviceId(),
        has_events_you_need: hasEventsTheyNeed,
        needs_events_from_you: needsEventsFromThem,
        fingerprint_match: fingerprintMatch,
        rtc_capable: this.webrtcPeer !== null,
      },
    ));
  }

  private async handleOffer(
    senderUserId: string,
    content: Record<string, any>,
  ): Promise<void> {
    if (content.has_events_you_need) {
      // If fingerprints diverge, request from seq 0 to get full history
      // (the fold engine deduplicates via content hash).
      // If fingerprints match or are unknown, request from our current seq.
      const mySeq = await this.store.getCurrentSeq();
      const needFrom = content.fingerprint_match === false ? 0 : mySeq;
      const gapSize = content.my_seq - mySeq;

      // For large gaps, use the transport router to select the best transport
      if (gapSize > GAP_THRESHOLD && this.webrtcPeer) {
        const peer: PeerInfo = {
          userId: senderUserId,
          deviceId: content.my_device,
          seq: content.my_seq,
          fingerprint: content.my_fingerprint,
          rtcCapable: content.rtc_capable ?? false,
          online: true,
        };
        const deps: TransportRouterDeps = {
          sendViaMatrix: (uid, did, from) => this.requestEvents(uid, did, from),
          webrtcPeer: this.webrtcPeer,
        };
        const result = await executeSync(peer, needFrom, gapSize, deps);
        if (result.success) return;
        // If all transports failed, fall through to Matrix to-device
      }

      await this.requestEvents(senderUserId, content.my_device, needFrom);
    }
  }

  private async requestEvents(
    peerUserId: string,
    peerDeviceId: string,
    needFrom: number,
  ): Promise<void> {
    await this.client.sendToDevice(SYNC_REQUEST, toDeviceContent(
      peerUserId, peerDeviceId, {
        need_from: needFrom,
        from_device: this.client.getDeviceId(),
      },
    ));
  }

  private async sendEventsToPeer(
    peerUserId: string,
    peerDeviceId: string,
    fromSeq: number,
  ): Promise<void> {
    const events = await readLogSince(this.store, fromSeq);
    const keyId = resolveSnapshotKeyId(this.keyring);
    const keyEntry = keyId ? getKeyById(this.keyring, keyId) : null;

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);

      // Encrypt batch if keyring has keys; otherwise send plaintext (unencrypted space)
      const payload = keyEntry
        ? await encryptPeerPayload(keyEntry.key, keyId!, pack(batch))
        : { events: batch };

      await this.client.sendToDevice(SYNC_EVENTS, toDeviceContent(
        peerUserId, peerDeviceId, {
          ...payload,
          batch_index: Math.floor(i / BATCH_SIZE),
          total_batches: Math.ceil(events.length / BATCH_SIZE),
        },
      ));
    }
  }

  /**
   * Process incoming peer events through the fold engine.
   *
   * Detects encrypted payloads via the `encrypted` flag and decrypts before
   * folding. The fold engine handles deduplication via content-addressable
   * hashing: if we already have an event (either from local creation or
   * Matrix room), processEvent returns the cached seq without re-applying.
   */
  private async processIncomingPeerEvents(content: Record<string, any>): Promise<void> {
    let events: EoEventInput[];

    if (content.encrypted) {
      // Encrypted peer payload — decrypt before processing
      const entry = content.key_id ? getKeyById(this.keyring, content.key_id) : null;
      if (!entry) {
        console.warn('[EO-DB] Cannot decrypt peer batch — missing key', content.key_id);
        return;
      }
      const plaintext = await decryptPeerPayload(entry.key, content as any);
      events = unpack(plaintext) as EoEventInput[];
    } else {
      // Legacy unencrypted payload
      events = content.events;
    }

    for (const event of events) {
      await processEvent(this.store, event, this.onEvent);
    }
  }
}
