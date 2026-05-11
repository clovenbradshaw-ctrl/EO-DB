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
import type { EoEvent, EoEventInput, EoState } from '../db/types';
import type { LocalKeyring } from '../db/crypto-types';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { storeFingerprint } from '../db/hash';
import { peerSyncEventTypes, PERMISSIONS_UPDATED } from '../lib/matrix-domain';
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
export function buildToDeviceContent(userId: string, deviceId: string, content: Record<string, any>) {
  const inner = new Map<string, Record<string, any>>();
  inner.set(deviceId, content);
  const outer = new Map<string, Map<string, Record<string, any>>>();
  outer.set(userId, inner);
  return outer;
}

/** @internal Alias for internal callers within this file. */
const toDeviceContent = buildToDeviceContent;

/** Gap size threshold for upgrading to WebRTC or Filen transport. */
const GAP_THRESHOLD = 100;

/** How often to re-announce presence to peers (ms). Handles late-join timing issues. */
const HEARTBEAT_INTERVAL_MS = 30_000;

export class PeerSync {
  private client: MatrixClient;
  private roomId: string;
  private store: EoStore;
  private onEvent?: (event: any) => void;
  private keyring: LocalKeyring;
  private toDeviceHandler?: (event: MatrixEvent) => void;

  /** Optional WebRTC peer for direct browser-to-browser transfers. */
  private webrtcPeer: WebRTCPeer | null = null;

  /** Periodic heartbeat timer — re-announces presence so late-joining peers can sync. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Serialization chain for to-device handler invocations.
   *
   * Every incoming to-device message is appended to this chain so that two
   * SYNC_EVENTS batches can never race through processIncomingPeerEvents
   * (which writes the client_event_id idem cache inside a non-locked
   * for-loop). Without this, a second batch can enter before the first has
   * finished writing its idem keys, and both wind up calling processEvent
   * on the same target — producing duplicate folds and divergent state.
   */
  private handlerChain: Promise<void> = Promise.resolve();

  /**
   * Called when the server signals that this user's permissions have changed.
   * Wire this to re-fetch the space manifest and call
   * useEoStore.getState().setUserManifest() in the app shell.
   */
  onPermissionsUpdated?: () => void;

  /**
   * Optional bulk-apply hook for incoming peer event batches. When wired
   * (typically `useEoStore.getState().batchImport`) the chunked,
   * worker-pooled fold path absorbs the batch in one call. Without it,
   * `processIncomingPeerEvents` falls back to a per-event loop that
   * yields between chunks so a 50-event batch can't pin the main thread.
   */
  private bulkApply?: (events: EoEventInput[]) => Promise<unknown>;

  /**
   * Optional chain-SEG callback fired from `start()` before peer
   * announce. The host wires this to `hydrateBlocksIfStale` so a SEG
   * always runs once per space mount — regardless of whether the UI
   * shell remembered to fire it. (V8 of HELIX-AUDIT-2026-05-11.md.)
   *
   * Awaited; SEG runs to completion before peers are told about us.
   * Failures are caught and logged so a homeserver outage doesn't
   * block peer announce.
   */
  private chainSeg?: () => Promise<unknown>;

  constructor(
    client: MatrixClient,
    roomId: string,
    store: EoStore,
    onEvent?: (event: any) => void,
    keyring?: LocalKeyring,
    bulkApply?: (events: EoEventInput[]) => Promise<unknown>,
    chainSeg?: () => Promise<unknown>,
  ) {
    this.client = client;
    this.roomId = roomId;
    this.store = store;
    this.onEvent = onEvent;
    this.keyring = keyring || { keys: new Map() };
    this.bulkApply = bulkApply;
    this.chainSeg = chainSeg;
  }

  /** Allow swapping the bulk-apply hook after construction. */
  setBulkApply(bulkApply: (events: EoEventInput[]) => Promise<unknown>): void {
    this.bulkApply = bulkApply;
  }

  /** Allow swapping the chain-SEG hook after construction. */
  setChainSeg(chainSeg: () => Promise<unknown>): void {
    this.chainSeg = chainSeg;
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
   *
   * Safe to call multiple times (e.g. on space re-mount): replaces any
   * previous listener and restarts the heartbeat.
   */
  async start(): Promise<void> {
    // Remove previous listener if start() is called again
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
    }

    // Clear any existing heartbeat before restarting
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Attach listener BEFORE announcing — if announceToPeers() fails,
    // we can still receive peer messages (they may hello us first).
    this.toDeviceHandler = (event: MatrixEvent) => {
      // Chain onto handlerChain so concurrent to-device deliveries serialize.
      // `.catch(() => {})` keeps the chain alive after a prior rejection,
      // and the trailing `.catch` stops unhandled-rejection noise without
      // affecting the next enqueue.
      const prev = this.handlerChain;
      const next = prev
        .catch(() => {})
        .then(() => this.handleToDeviceEvent(event));
      this.handlerChain = next;
      next.catch(() => {});
    };
    this.client.on('toDeviceEvent' as any, this.toDeviceHandler);

    // Run the host-provided chain SEG (typically hydrateBlocksIfStale)
    // before peer announce. This guarantees a SEG against the homeserver
    // chain head on every start() — even if the UI shell forgets to
    // trigger it. (V8 of HELIX-AUDIT-2026-05-11.md.)
    if (this.chainSeg) {
      try {
        await this.chainSeg();
      } catch (e) {
        // Non-fatal — peer sync still proceeds; the next mount or
        // listenForChainUpdates wake-up will re-attempt the SEG.
        console.warn('[EO-DB] PeerSync chain SEG failed:', e);
      }
    }

    try {
      await this.announceToPeers();
    } catch (e) {
      // Non-fatal — listener is active, peers can still reach us.
      console.warn('[EO-DB] PeerSync announce failed:', e);
    }

    // Periodic heartbeat: re-announce every 30 s so peers that joined late
    // (or whose initial HELLO was lost during a room-state race) get a chance
    // to sync. Each heartbeat triggers the normal HELLO→OFFER→REQUEST→EVENTS
    // exchange for any peer whose seq differs from ours.
    this.heartbeatTimer = setInterval(() => {
      this.announceToPeers().catch((e) => {
        console.warn('[EO-DB] PeerSync heartbeat failed:', e);
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stop peer sync — remove the event listener and cancel the heartbeat.
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.toDeviceHandler) {
      this.client.removeListener('toDeviceEvent' as any, this.toDeviceHandler);
      this.toDeviceHandler = undefined;
    }
  }

  /**
   * Await any in-flight to-device handler work. Used by tests and by clean
   * shutdown so the store isn't closed mid-fold.
   */
  async drainHandlers(): Promise<void> {
    await this.handlerChain.catch(() => {});
  }

  /** Alias for stop() — satisfies the SyncManager.destroy() call site in Layout. */
  destroy(): void {
    this.stop();
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
   * Wait for the room to appear in the Matrix SDK's local store.
   *
   * After a fresh joinRoom() call the SDK needs one sync cycle to deliver
   * room state. Poll with exponential backoff (~6 s max) so announceToPeers
   * doesn't silently no-op when called immediately after joining.
   */
  private async waitForRoom(maxAttempts = 5): Promise<any | null> {
    let delay = 200;
    for (let i = 0; i < maxAttempts; i++) {
      const room = this.client.getRoom(this.roomId);
      if (room) return room;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
    return this.client.getRoom(this.roomId); // final attempt after full backoff
  }

  /**
   * Announce our current seq + fingerprint to all devices in the room.
   *
   * Waits for the room to be available in the SDK before sending — this
   * handles the race condition where announceToPeers is called immediately
   * after joinRoom(), before the Matrix sync cycle has delivered room state.
   */
  private async announceToPeers(): Promise<void> {
    const mySeq = await this.store.getCurrentSeq();
    const fingerprint = await this.computeFingerprint();
    const room = await this.waitForRoom();
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

    // Ignore messages that belong to a different space's room.
    // room_id may be absent in legacy messages — accept those for backward compat.
    if (content.room_id && content.room_id !== this.roomId) return;

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
      case PERMISSIONS_UPDATED:
        // The admin updated this user's permissions — re-fetch the manifest.
        this.onPermissionsUpdated?.();
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
        room_id: this.roomId,
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
        room_id: this.roomId,
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
          room_id: this.roomId,
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

    if (events.length === 0) return;
    if (this.bulkApply) {
      await this.bulkApply(events);
      return;
    }
    // Fallback: yield every 50 events so a batch can't pin the main thread.
    // BATCH_SIZE is 50 already so this is once per typical batch boundary.
    for (let i = 0; i < events.length; i++) {
      await processEvent(this.store, events[i], this.onEvent);
      if ((i + 1) % 50 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  }

  /**
   * Push a newly-created local event to all room members immediately.
   * Uses the same SYNC_EVENTS + encryptPeerPayload path as sendEventsToPeer.
   * Fire-and-forget — peers can still gap-fill via the hello/offer/request
   * handshake if this message is lost.
   */
  async broadcastLocalEvent(event: EoEvent): Promise<void> {
    const room = this.client.getRoom(this.roomId);
    if (!room) return;
    const myUserId = this.client.getUserId();
    const members = room.getJoinedMembers().filter(m => m.userId !== myUserId);
    if (members.length === 0) return;

    const keyId = resolveSnapshotKeyId(this.keyring);
    const keyEntry = keyId ? getKeyById(this.keyring, keyId) : null;

    const payload = keyEntry
      ? await encryptPeerPayload(keyEntry.key, keyId!, pack([event]))
      : { events: [event] };

    for (const member of members) {
      try {
        await this.client.sendToDevice(
          SYNC_EVENTS,
          toDeviceContent(member.userId, '*', {
            ...payload,
            room_id: this.roomId,
            batch_index: 0,
            total_batches: 1,
          }),
        );
      } catch { /* best-effort — gap-fill is the safety net */ }
    }
  }

}
