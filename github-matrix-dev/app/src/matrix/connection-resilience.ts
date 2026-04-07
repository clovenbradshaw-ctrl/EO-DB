/**
 * Connection resilience — retry helpers for the browser Matrix client.
 *
 * Mirrors the server-side src/matrix/connection-resilience.ts API but uses
 * only browser-compatible primitives (no Node.js imports).
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  multiplier?: number;
  maxDelay?: number;
  signal?: AbortSignal;
}

/**
 * Extract retry delay from a Matrix 429 response error, or null if not
 * rate-limited. Works with matrix-js-sdk MatrixError and various wrappers.
 */
export function extractRateLimitDelay(error: unknown): number | null {
  if (!error) return null;
  const e = error as any;

  const isRateLimit =
    e.httpStatus === 429 ||
    e.statusCode === 429 ||
    e.errcode === 'M_LIMIT_EXCEEDED' ||
    e.data?.errcode === 'M_LIMIT_EXCEEDED' ||
    (e.message && /429|too many|rate.?limit|M_LIMIT_EXCEEDED/i.test(String(e.message))) ||
    (e.name && /MatrixError/i.test(String(e.name)) && /429|limit/i.test(String(e.message)));

  if (!isRateLimit) return null;

  const retryAfter = e.data?.retry_after_ms ?? e.retry_after_ms;
  return typeof retryAfter === 'number' && retryAfter > 0
    ? retryAfter + 100
    : 2000;
}

/**
 * Check whether an error represents a transient failure (worth retrying)
 * vs a permanent one (4xx client error, should not retry).
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  const e = error as any;

  if (extractRateLimitDelay(e) !== null) return true;

  // Network errors
  if (e.name === 'TypeError' || e.message?.includes('fetch failed') ||
      e.message?.includes('network') || e.message?.includes('Failed to fetch')) {
    return true;
  }

  // 5xx server errors
  const status = e.httpStatus ?? e.statusCode ?? e.status;
  if (typeof status === 'number' && status >= 500) return true;

  // 4xx (except 429) = permanent
  if (typeof status === 'number' && status >= 400 && status < 500) return false;

  // Unknown — assume transient
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Retry any async operation with exponential backoff.
 *
 * Retries on network errors, 5xx, and 429. No retry on 4xx.
 * Honors server-provided retry_after_ms on 429.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelay ?? 2000;
  const multiplier = opts?.multiplier ?? 2;
  const maxDelay = opts?.maxDelay ?? 30_000;

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      opts?.signal?.throwIfAborted();
      return await fn();
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      lastError = err;

      if (attempt >= maxRetries) break;
      if (!isTransientError(err)) throw err;

      const rateLimitDelay = extractRateLimitDelay(err);
      const computedDelay = Math.min(baseDelay * Math.pow(multiplier, attempt), maxDelay);
      const delay = rateLimitDelay ?? computedDelay;

      await sleep(delay, opts?.signal);
    }
  }

  throw lastError;
}
