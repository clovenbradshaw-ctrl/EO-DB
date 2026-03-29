/**
 * Peer sync — device-to-device gap filling via Matrix to-device messaging.
 *
 * Protocol:
 * 1. hello  — announce own seq to all room members
 * 2. offer  — respond with own seq + gap detection
 * 3. request — ask peer for missing events
 * 4. events — batch of EO events (max 50 per message)
 */

import type { MatrixClient, MatrixEvent } from 'matrix-js-sdk';
import type { EoStore } from '../db/encrypted-store';
import type { EoEventInput } from '../db/types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
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
    await this.announceToPeers();

    this.client.on('toDeviceEvent' as any, (event: MatrixEvent) => {
      this.handleToDeviceEvent(event);
    });
  }

  /**
   * Announce our current seq to all devices in the room.
   */
  private async announceToPeers(): Promise<void> {
    const mySeq = await this.store.getCurrentSeq();
    const room = this.client.getRoom(this.roomId);
    if (!room) return;

    const members = room.getJoinedMembers();
    const myUserId = this.client.getUserId()!;

    for (const member of members) {
      if (member.userId === myUserId) continue;

      await this.client.sendToDevice(SYNC_HELLO, toDeviceContent(
        member.userId, '*', {
          my_seq: mySeq,
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
        await this.handleHello(sender, content.my_device, content.my_seq);
        break;
      case SYNC_OFFER:
        if (content.has_events_you_need) {
          await this.requestEvents(sender, content.my_device, await this.store.getCurrentSeq());
        }
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
  ): Promise<void> {
    const mySeq = await this.store.getCurrentSeq();

    await this.client.sendToDevice(SYNC_OFFER, toDeviceContent(
      senderUserId, senderDeviceId, {
        my_seq: mySeq,
        my_device: this.client.getDeviceId(),
        has_events_you_need: mySeq > theirSeq,
        needs_events_from_you: theirSeq > mySeq,
      },
    ));
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

  private async processIncomingPeerEvents(events: EoEventInput[]): Promise<void> {
    for (const event of events) {
      // Dedup by client_event_id
      if (event.client_event_id) {
        const existing = await this.store.get(`idem:${event.client_event_id}`);
        if (existing != null) continue;
      }

      await processEvent(this.store, event, this.onEvent);
    }
  }
}
