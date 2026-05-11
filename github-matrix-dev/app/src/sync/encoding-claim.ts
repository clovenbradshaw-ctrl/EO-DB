/**
 * Encoding claim protocol — single-writer lease for the block sealer.
 *
 * Coordinates which client/device runs the block-sealing compactor at a
 * given moment. Claims are broadcast via a Matrix room state event with
 * a TTL + clientId tiebreaker: the lowest clientId wins on collision, and
 * a claim older than {@link CLAIM_TTL_MS} is considered stale and can be
 * taken over by any peer.
 *
 * Originally this module also drove a Filen-backed `.eodb` upload path;
 * that has been retired in favour of Matrix-native blocks (see
 * `./block-sealer.ts`). What remains here is the lease primitive.
 */

// ─── Constants ──────────────────────────────────────────────────────────

const CLAIM_TTL_MS = 5 * 60 * 1000;       // 5 minutes
const CLAIM_JITTER_MIN_MS = 1500;
const CLAIM_JITTER_MAX_MS = 2500;
const MIN_LOOSE_EVENTS = 500;
const MAX_ENCODING_GAP_MS = 24 * 60 * 60 * 1000;  // 24 hours

// ─── Types ──────────────────────────────────────────────────────────────

export interface EncodingClaim {
  type: 'encoding_claim';
  clientId: string;
  claimedThrough: number;
  timestamp: number;
  status: 'pending' | 'complete' | 'failed';
}

/** Dependency-injected Matrix client interface. */
export interface EncodingMatrixClient {
  getDeviceId(): string;
  /** Read the current encoding claim state event from the room. */
  getEncodingClaim(roomId: string): EncodingClaim | null;
  /** Write an encoding claim state event. */
  setEncodingClaim(roomId: string, claim: EncodingClaim): Promise<void>;
}

// ─── Decision Logic ─────────────────────────────────────────────────────

/**
 * Determine whether this device should attempt sealing.
 *
 * Triggers:
 *   - ≥{@link MIN_LOOSE_EVENTS} loose events since last seal
 *   - Session boundary (idle / logout) with any loose events
 *   - No seal in 24 hours
 */
export function shouldEncode(
  looseEventCount: number,
  lastEncodingTs: number,
  isIdle: boolean,
): boolean {
  if (looseEventCount >= MIN_LOOSE_EVENTS) return true;
  if (isIdle && looseEventCount > 0) return true;
  if (lastEncodingTs > 0 && Date.now() - lastEncodingTs > MAX_ENCODING_GAP_MS) return true;
  return false;
}

// ─── Claim Protocol ─────────────────────────────────────────────────────

function isClaimStale(claim: EncodingClaim, now: number = Date.now()): boolean {
  if (claim.status !== 'pending') return false;
  return now - claim.timestamp > CLAIM_TTL_MS;
}

export function isClaimableByUs(
  existing: EncodingClaim | null,
  myClientId: string,
  now: number = Date.now(),
): boolean {
  if (!existing) return true;
  if (existing.status === 'complete' || existing.status === 'failed') return true;
  if (isClaimStale(existing, now)) return true;
  return existing.clientId === myClientId;
}

/**
 * Attempt to claim the encoding job. Returns true if we successfully
 * acquired the claim.
 *
 * Protocol:
 *   1. Check for existing active claims (expire after 5 min).
 *   2. Send encoding_claim state event.
 *   3. Wait 1.5–2.5 s (jittered) for conflicting claims to land.
 *   4. Re-read claim. Lowest clientId wins ties.
 */
export async function claimEncoding(
  matrix: EncodingMatrixClient,
  roomId: string,
  clientId: string,
  throughSeq: number,
): Promise<boolean> {
  const existing = matrix.getEncodingClaim(roomId);
  if (!isClaimableByUs(existing, clientId)) return false;

  const claim: EncodingClaim = {
    type: 'encoding_claim',
    clientId,
    claimedThrough: throughSeq,
    timestamp: Date.now(),
    status: 'pending',
  };
  await matrix.setEncodingClaim(roomId, claim);

  const jitter = CLAIM_JITTER_MIN_MS +
    Math.random() * (CLAIM_JITTER_MAX_MS - CLAIM_JITTER_MIN_MS);
  await new Promise<void>(resolve => setTimeout(resolve, jitter));

  const afterWrite = matrix.getEncodingClaim(roomId);
  if (!afterWrite) return true;
  if (afterWrite.clientId !== clientId && afterWrite.status === 'pending') {
    if (afterWrite.clientId < clientId) return false;
  }
  return afterWrite.clientId === clientId;
}

/**
 * Mark the current claim as complete or failed. Caller is responsible
 * for only marking claims it itself acquired.
 */
export async function releaseClaim(
  matrix: EncodingMatrixClient,
  roomId: string,
  clientId: string,
  throughSeq: number,
  status: 'complete' | 'failed',
): Promise<void> {
  await matrix.setEncodingClaim(roomId, {
    type: 'encoding_claim',
    clientId,
    claimedThrough: throughSeq,
    timestamp: Date.now(),
    status,
  });
}
