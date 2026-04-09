/**
 * Transport router — adaptive selection of sync transport based on gap size,
 * peer availability, and connection quality.
 *
 * Two transport tiers, one signaling layer (Matrix):
 *
 * 1. Matrix to-device — small gaps (< GAP_THRESHOLD events), always available
 * 2. WebRTC DataChannel — large gaps, both peers online, direct browser-to-browser
 *
 * Fallback chain: WebRTC → Matrix to-device
 */

import type { WebRTCPeer } from './webrtc-peer';

// ──────────────────────────────────────────────────────────────
// Transport types
// ──────────────────────────────────────────────────────────────

export type Transport = 'matrix-todevice' | 'webrtc';

export interface PeerInfo {
  userId: string;
  deviceId: string;
  seq: number;
  fingerprint?: string;
  rtcCapable: boolean;
  online: boolean;
}

export interface TransportDecision {
  transport: Transport;
  reason: string;
}

// ──────────────────────────────────────────────────────────────
// Thresholds
// ──────────────────────────────────────────────────────────────

/** Below this gap, always use Matrix to-device (simplest, most reliable). */
const SMALL_GAP_THRESHOLD = 100;

// ──────────────────────────────────────────────────────────────
// Transport selection
// ──────────────────────────────────────────────────────────────

/**
 * Select the best transport for syncing a gap with a peer.
 */
export function selectTransport(
  gapSize: number,
  peer: PeerInfo,
  webrtcAvailable: boolean,
): TransportDecision {
  // Tiny gap: always use Matrix to-device (zero setup cost)
  if (gapSize <= SMALL_GAP_THRESHOLD) {
    return {
      transport: 'matrix-todevice',
      reason: `Small gap (${gapSize} events) — Matrix to-device is simplest`,
    };
  }

  // Peer is online and WebRTC-capable: try direct connection
  if (peer.online && peer.rtcCapable && webrtcAvailable) {
    return {
      transport: 'webrtc',
      reason: `Large gap (${gapSize} events), peer online + RTC capable — direct transfer`,
    };
  }

  // Fallback: Matrix to-device with batching (slower but always works)
  return {
    transport: 'matrix-todevice',
    reason: `Fallback — no WebRTC available for ${gapSize} events`,
  };
}

// ──────────────────────────────────────────────────────────────
// Transport executor
// ──────────────────────────────────────────────────────────────

export interface TransportRouterDeps {
  /** Send events via existing Matrix to-device path (PeerSync.requestEvents). */
  sendViaMatrix: (peerUserId: string, peerDeviceId: string, needFrom: number) => Promise<void>;
  /** WebRTC peer instance (may be null if not initialized). */
  webrtcPeer: WebRTCPeer | null;
}

/**
 * Execute a sync using the selected transport with automatic fallback.
 *
 * Tries the selected transport first. On failure, falls through to Matrix to-device.
 */
export async function executeSync(
  peer: PeerInfo,
  needFrom: number,
  gapSize: number,
  deps: TransportRouterDeps,
): Promise<{ transport: Transport; success: boolean }> {
  const decision = selectTransport(
    gapSize,
    peer,
    deps.webrtcPeer !== null,
  );

  // Try selected transport
  try {
    switch (decision.transport) {
      case 'webrtc': {
        if (!deps.webrtcPeer) throw new Error('WebRTC not available');
        await deps.webrtcPeer.connect(peer.userId, peer.deviceId, needFrom);
        return { transport: 'webrtc', success: true };
      }
      case 'matrix-todevice': {
        await deps.sendViaMatrix(peer.userId, peer.deviceId, needFrom);
        return { transport: 'matrix-todevice', success: true };
      }
    }
  } catch (primaryErr) {
    console.warn(`[EO-DB] Primary transport (${decision.transport}) failed:`, primaryErr);
  }

  // Fallback: WebRTC failed → try Matrix to-device
  if (decision.transport === 'webrtc') {
    try {
      await deps.sendViaMatrix(peer.userId, peer.deviceId, needFrom);
      return { transport: 'matrix-todevice', success: true };
    } catch (matrixErr) {
      console.warn('[EO-DB] Matrix to-device fallback failed:', matrixErr);
    }
  }

  console.error('[EO-DB] All sync transports failed for peer', peer.userId);
  return { transport: decision.transport, success: false };
}
