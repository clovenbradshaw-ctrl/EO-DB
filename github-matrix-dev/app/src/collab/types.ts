/**
 * Collab module types — collaborative real-time editing via Yjs + Matrix.
 */

export interface CollabPeer {
  userId: string;
  deviceId: string;
  documentId: string;
  color: string;
  name: string;
}

export type CollabTransport = 'webrtc' | 'todevice' | 'offline';

export interface CollabStatus {
  connected: boolean;
  peers: CollabPeer[];
  transport: CollabTransport;
}

/** Message type tags for multiplexing doc updates and awareness on one DataChannel. */
export const MSG_DOC_UPDATE = 0x01;
export const MSG_AWARENESS = 0x02;
export const MSG_SYNC_STEP1 = 0x03;
export const MSG_SYNC_STEP2 = 0x04;

