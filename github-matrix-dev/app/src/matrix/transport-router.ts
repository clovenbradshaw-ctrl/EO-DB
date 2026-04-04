/**
 * Transport router — adaptive selection of sync transport based on gap size,
 * peer availability, and connection quality.
 *
 * Three transport tiers, one signaling layer (Matrix):
 *
 * 1. Matrix to-device — small gaps (< GAP_THRESHOLD events), always available
 * 2. WebRTC DataChannel — large gaps, both peers online, direct browser-to-browser
 * 3. Filen dead-drop — async transfer, peers not online simultaneously
 *
 * Fallback chain: WebRTC → Matrix to-device → Filen dead-drop
 */

import type { WebRTCPeer } from './webrtc-peer';
import type { FilenShareService } from '../filen/filen-share';

// ──────────────────────────────────────────────────────────────
// Transport types
// ──────────────────────────────────────────────────────────────

export type Transport = 'matrix-todevice' | 'webrtc' | 'filen';

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

/** Above this estimated byte size, prefer Filen for async transfer. */
const FILEN_SIZE_THRESHOLD = 1_000_000; // 1 MB

/** Estimated bytes per event (msgpack-encoded average). */
const BYTES_PER_EVENT = 500;

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
  filenAvailable: boolean,
): TransportDecision {
  const estimatedBytes = gapSize * BYTES_PER_EVENT;

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

  // Large data, peer offline or WebRTC unavailable: use Filen dead-drop
  if (filenAvailable && estimatedBytes > FILEN_SIZE_THRESHOLD) {
    return {
      transport: 'filen',
      reason: `Large payload (~${Math.round(estimatedBytes / 1024)}KB), Filen dead-drop for async transfer`,
    };
  }

  // Fallback: Matrix to-device with batching (slower but always works)
  return {
    transport: 'matrix-todevice',
    reason: `Fallback — no WebRTC or Filen available for ${gapSize} events`,
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
  /** Filen share service (may be null if not configured). */
  filenShare: FilenShareService | null;
}

/**
 * Execute a sync using the selected transport with automatic fallback.
 *
 * Tries the selected transport first. On failure, falls through the
 * fallback chain: WebRTC → Matrix to-device → Filen dead-drop.
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
    deps.filenShare !== null,
  );

  // Try selected transport
  try {
    switch (decision.transport) {
      case 'webrtc': {
        if (!deps.webrtcPeer) throw new Error('WebRTC not available');
        await deps.webrtcPeer.connect(peer.userId, peer.deviceId, needFrom);
        return { transport: 'webrtc', success: true };
      }
      case 'filen': {
        if (!deps.filenShare) throw new Error('Filen not available');
        await deps.filenShare.shareCurrentState(needFrom);
        return { transport: 'filen', success: true };
      }
      case 'matrix-todevice': {
        await deps.sendViaMatrix(peer.userId, peer.deviceId, needFrom);
        return { transport: 'matrix-todevice', success: true };
      }
    }
  } catch (primaryErr) {
    console.warn(`[EO-DB] Primary transport (${decision.transport}) failed:`, primaryErr);
  }

  // Fallback chain
  if (decision.transport === 'webrtc') {
    // WebRTC failed → try Matrix to-device
    try {
      await deps.sendViaMatrix(peer.userId, peer.deviceId, needFrom);
      return { transport: 'matrix-todevice', success: true };
    } catch (matrixErr) {
      console.warn('[EO-DB] Matrix to-device fallback failed:', matrixErr);
    }

    // Matrix failed → try Filen dead-drop
    if (deps.filenShare) {
      try {
        await deps.filenShare.shareCurrentState(needFrom);
        return { transport: 'filen', success: true };
      } catch {
        // All transports failed
      }
    }
  }

  if (decision.transport === 'filen') {
    // Filen failed → try Matrix to-device
    try {
      await deps.sendViaMatrix(peer.userId, peer.deviceId, needFrom);
      return { transport: 'matrix-todevice', success: true };
    } catch {
      // All transports failed
    }
  }

  console.error('[EO-DB] All sync transports failed for peer', peer.userId);
  return { transport: decision.transport, success: false };
}
