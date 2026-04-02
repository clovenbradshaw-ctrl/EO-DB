/**
 * Peer sync — device-to-device gap filling via Matrix to-device messaging.
 *
 * Protocol (4 message types, all via sendToDevice):
 *
 *   hello   → Announce { my_seq, my_fingerprint, my_device, room_id }
 *               Sent to all joined members except self
 *
 *   offer   ← Respond { my_seq, my_fingerprint, has_events_you_need,
 *                        needs_events_from_you, fingerprint_match }
 *               Evaluates whether gap exists
 *
 *   request → Ask peer { need_from, from_device }
 *               If fingerprints diverge: need_from = 0 (full exchange)
 *               If fingerprints match:   need_from = mySeq
 *
 *   events  ← Batch of EoEvents (max 50 per message)
 *               Batched with batch_index / total_batches metadata
 *
 * Store fingerprint is a hash of all projected state entries
 * (target + last_seq + hash). Detects divergence even when two devices
 * have the same seq but different event histories (e.g., both created
 * events offline and neither has seen the other's yet).
 *
 * When fingerprints diverge, the requesting device asks for events from
 * seq 0 (full history). The fold engine deduplicates via content-addressable
 * hashing, so receiving redundant events is harmless.
 */

import type { EoDb } from '../db/level.js';
import { getCurrentSeq, decode } from '../db/level.js';
import type { EoEventInput, EoState } from '../db/types.js';
import { processEvent } from '../db/fold.js';
import type { Feed } from '../db/feed.js';
import { readLogSince } from '../db/log.js';
import { storeFingerprint } from '../db/hash.js';
import { peerSyncEventTypes } from '../config/matrix-domain.js';
import type { IMatrixClient, IMatrixEvent } from './types.js';

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
  private client: IMatrixClient;
  private roomId: string;
  private db: EoDb;
  private feed?: Feed;
  private toDeviceHandler?: (event: IMatrixEvent) => void;

  constructor(
    client: IMatrixClient,
    roomId: string,
    db: EoDb,
    feed?: Feed,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.db = db;
    this.feed = feed;
  }

  /**
   * Start peer sync — announce presence and listen for messages.
   */
  async start(): Promise<void> {
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent', this.toDeviceHandler);
    }

    await this.announceToPeers();

    this.toDeviceHandler = (event: IMatrixEvent) => {
      this.handleToDeviceEvent(event);
    };
    this.client.on('toDeviceEvent', this.toDeviceHandler);
  }

  /**
   * Stop peer sync — remove the event listener.
   */
  stop(): void {
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent', this.toDeviceHandler);
      this.toDeviceHandler = undefined;
    }
  }

  /**
   * Compute the store fingerprint for comparison with peers.
   *
   * Iterates all projected state entries and hashes them. Two stores with
   * identical projected state produce the same fingerprint.
   */
  private async computeFingerprint(): Promise<string> {
    const entries: Array<{ target: string; last_seq: number; hash?: string }> = [];

    for await (const [key, value] of this.db.iterator({
      gte: 'state:',
      lte: 'state:\xff',
    })) {
      const state = decode(value) as EoState;
      entries.push({
        target: key.slice(6), // remove 'state:' prefix
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
    const mySeq = await getCurrentSeq(this.db);
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
  private async handleToDeviceEvent(event: IMatrixEvent): Promise<void> {
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

  /**
   * Handle a hello from a peer — compare seq + fingerprint, respond with offer.
   */
  private async handleHello(
    senderUserId: string,
    senderDeviceId: string,
    theirSeq: number,
    theirFingerprint?: string,
  ): Promise<void> {
    const mySeq = await getCurrentSeq(this.db);
    const myFingerprint = await this.computeFingerprint();

    const fingerprintMatch = theirFingerprint
      ? myFingerprint === theirFingerprint
      : null;

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

  /**
   * Handle an offer from a peer — request missing events if they have them.
   */
  private async handleOffer(
    senderUserId: string,
    content: Record<string, any>,
  ): Promise<void> {
    if (content.has_events_you_need) {
      const mySeq = await getCurrentSeq(this.db);
      // If fingerprints diverge, request full history (fold deduplicates)
      const needFrom = content.fingerprint_match === false ? 0 : mySeq;

      await this.client.sendToDevice(SYNC_REQUEST, toDeviceContent(
        senderUserId, content.my_device, {
          need_from: needFrom,
          from_device: this.client.getDeviceId(),
        },
      ));
    }
  }

  /**
   * Send events to a requesting peer, batched at 50 per message.
   */
  private async sendEventsToPeer(
    peerUserId: string,
    peerDeviceId: string,
    fromSeq: number,
  ): Promise<void> {
    const events = await readLogSince(this.db, fromSeq);

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
      await processEvent(this.db, event, this.feed);
    }
  }
}
