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

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput, EoState } from '../db/types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { storeFingerprint } from '../db/hash';
import { peerSyncEventTypes } from '../lib/matrix-domain';

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

export class PeerSync {
  private client: MatrixClient;
  private roomId: string;
  private store: EoStore;
  private onEvent?: (event: any) => void;
  private toDeviceHandler?: (event: MatrixEvent) => void;

  constructor(
    client: MatrixClient,
    roomId: string,
    store: EoStore,
    onEvent?: (event: any) => void,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.store = store;
    this.onEvent = onEvent;
  }

  /**
   * Start peer sync — announce presence and listen for messages.
   */
  async start(): Promise<void> {
    // Remove previous listener if start() is called again
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
    }

    await this.announceToPeers();

    this.toDeviceHandler = (event: MatrixEvent) => {
      this.handleToDeviceEvent(event);
    };
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);
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
        await this.handleHello(sender, content.my_device, content.my_seq, content.my_fingerprint);
        break;
      case SYNC_OFFER:
        await this.handleOffer(sender, content);
        break;
      case SYNC_REQUEST:
        await this.sendEventsToPeer(sender, content.from_device, content.need_from);
        break;
      case SYNC_EVENTS:
        await this.processIncomingPeerEvents(content.events);
        break;
    }
  }

  private async handleHello(
    senderUserId: string,
    senderDeviceId: string,
    theirSeq: number,
    theirFingerprint?: string,
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

    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      await this.client.sendToDevice(SYNC_EVENTS, toDeviceContent(
        peerUserId, peerDeviceId, {
          events: batch,
          batch_index: Math.floor(i / BATCH_SIZE),
          total_batches: Math.ceil(events.length / BATCH_SIZE),
        },
      ));
    }
  }

  /**
   * Process incoming peer events through the fold engine.
   *
   * The fold engine handles deduplication via content-addressable hashing:
   * if we already have an event (either from local creation or Matrix room),
   * processEvent returns the cached seq without re-applying.
   */
  private async processIncomingPeerEvents(events: EoEventInput[]): Promise<void> {
    for (const event of events) {
      await processEvent(this.store, event, this.onEvent);
    }
  }
}
