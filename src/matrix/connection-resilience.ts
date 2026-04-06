/**
 * Connection resilience — health monitoring, retry with exponential backoff,
 * and automatic reconnection for Matrix homeserver connections.
 *
 * Provides:
 *   - fetchWithRetry: wraps fetch() with configurable retry + backoff
 *   - MatrixConnectionMonitor: periodic health checks with status events
 *   - Connection state machine: online → degraded → offline transitions
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'online' | 'degraded' | 'offline';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Timestamp of last successful homeserver contact. */
  lastSeen: number;
  /** Number of consecutive failures. */
  consecutiveFailures: number;
  /** Human-readable reason for current status. */
  reason: string;
}

export interface RetryOptions {
  /** Max number of retry attempts (default: 4). */
  maxRetries?: number;
  /** Initial backoff delay in ms (default: 1000). */
  baseDelay?: number;
  /** Backoff multiplier (default: 2). */
  multiplier?: number;
  /** Max delay cap in ms (default: 30000). */
  maxDelay?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export type ConnectionListener = (state: ConnectionState) => void;

// ─── Retry-aware fetch ──────────────────────────────────────────────────────

/**
 * Fetch with exponential backoff retry.
 *
 * Retries on network errors and 5xx/429 responses. Returns immediately
 * on 4xx (client errors) since retrying won't help.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts?: RetryOptions,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 4;
  const baseDelay = opts?.baseDelay ?? 1000;
  const multiplier = opts?.multiplier ?? 2;
  const maxDelay = opts?.maxDelay ?? 30_000;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      opts?.signal?.throwIfAborted();

      const response = await fetch(url, { ...init, signal: opts?.signal });

      // Success or redirect — return
      if (response.ok || (response.status >= 200 && response.status < 400)) {
        return response;
      }

      // Don't retry client errors (4xx except 429)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response;
      }

      // Only retry 429 and 5xx — anything else (including missing status) returns as-is
      if (response.status !== 429 && !(response.status >= 500)) {
        return response;
      }

      // 429 or 5xx — extract retry-after and retry
      if (attempt < maxRetries) {
        let delay = Math.min(baseDelay * Math.pow(multiplier, attempt), maxDelay);

        if (response.status === 429) {
          // Try to extract Retry-After or retry_after_ms from body
          try {
            const body = await response.clone().json() as Record<string, unknown>;
            const retryMs = body.retry_after_ms as number | undefined;
            if (typeof retryMs === 'number' && retryMs > 0) {
              delay = retryMs + 100;
            }
          } catch {
            // Use computed backoff
          }
        }

        await sleep(delay, opts?.signal);
        continue;
      }

      return response;
    } catch (err: any) {
      if (err.name === 'AbortError') throw err;
      lastError = err;

      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(multiplier, attempt), maxDelay);
        await sleep(delay, opts?.signal);
      }
    }
  }

  throw lastError || new Error('fetchWithRetry: all attempts exhausted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

// ─── Connection Monitor ─────────────────────────────────────────────────────

const DEFAULT_HEALTH_INTERVAL = 30_000; // 30s
const DEGRADED_THRESHOLD = 2;           // failures before "degraded"
const OFFLINE_THRESHOLD = 4;            // failures before "offline"

export class MatrixConnectionMonitor {
  private homeserver: string;
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<ConnectionListener> = new Set();
  private abortController: AbortController | null = null;

  private state: ConnectionState = {
    status: 'online',
    lastSeen: Date.now(),
    consecutiveFailures: 0,
    reason: 'initial',
  };

  constructor(homeserver: string, intervalMs?: number) {
    this.homeserver = homeserver.replace(/\/+$/, '');
    this.interval = intervalMs ?? DEFAULT_HEALTH_INTERVAL;
  }

  /** Current connection state (read-only snapshot). */
  getState(): Readonly<ConnectionState> {
    return { ...this.state };
  }

  /** Register a listener for state changes. Returns unsubscribe function. */
  onStateChange(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.timer) return;
    this.abortController = new AbortController();
    // Run first check immediately
    this.check();
    this.timer = setInterval(() => this.check(), this.interval);
  }

  /** Stop health checks and clean up. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abortController?.abort();
    this.abortController = null;
  }

  /** Run a single health check against the homeserver. */
  async check(): Promise<ConnectionStatus> {
    try {
      const response = await fetch(
        `${this.homeserver}/_matrix/client/versions`,
        {
          signal: this.abortController?.signal ?? AbortSignal.timeout(10_000),
          headers: { 'Accept': 'application/json' },
        },
      );

      if (response.ok) {
        this.updateState('online', 'health check passed');
      } else {
        this.recordFailure(`health check returned ${response.status}`);
      }
    } catch (err: any) {
      if (err.name === 'AbortError' && !this.timer) return this.state.status;
      this.recordFailure(`health check failed: ${err.message}`);
    }
    return this.state.status;
  }

  /** Notify the monitor of a successful Matrix request (resets failure count). */
  recordSuccess(): void {
    if (this.state.consecutiveFailures > 0 || this.state.status !== 'online') {
      this.updateState('online', 'request succeeded');
    }
  }

  /** Notify the monitor of a failed Matrix request. */
  recordFailure(reason: string): void {
    const failures = this.state.consecutiveFailures + 1;
    let status: ConnectionStatus = 'online';
    if (failures >= OFFLINE_THRESHOLD) {
      status = 'offline';
    } else if (failures >= DEGRADED_THRESHOLD) {
      status = 'degraded';
    }
    this.setState({ status, consecutiveFailures: failures, reason, lastSeen: this.state.lastSeen });
  }

  private updateState(status: ConnectionStatus, reason: string): void {
    this.setState({
      status,
      lastSeen: Date.now(),
      consecutiveFailures: 0,
      reason,
    });
  }

  private setState(next: ConnectionState): void {
    const prev = this.state;
    this.state = next;
    if (prev.status !== next.status || prev.consecutiveFailures !== next.consecutiveFailures) {
      for (const listener of this.listeners) {
        try { listener(next); } catch { /* listener errors are non-fatal */ }
      }
    }
  }
}
