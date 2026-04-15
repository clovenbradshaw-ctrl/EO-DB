/**
 * PressureMonitor — Phase 1 of cloud-tiered .eodb (read-only).
 *
 * Fuses browser + app signals into a single "pressure score" (0..1) that
 * indicates how much the local machine is struggling. When we later wire up
 * cloud-backed cold frames, this score will drive `localRetentionBudget` —
 * how much payload we keep resident vs. fetch on demand.
 *
 * Phase 1 is observation-only: the monitor computes a score and exposes it;
 * nothing in the app changes behavior based on it yet.
 *
 * Signals (weights sum to 1.0):
 *   - longtask  (30%) : main-thread tasks > 50 ms (PerformanceObserver)
 *   - heap      (25%) : performance.memory.usedJSHeapSize / jsHeapSizeLimit (Chrome)
 *   - storage   (20%) : navigator.storage.estimate() usage / quota
 *   - foldCost  (15%) : rolling avg microseconds per event (pushed by fold worker)
 *   - syncLag   (10%) : SyncPair.lag magnitude (pushed by sync store)
 *
 * Device hints (navigator.deviceMemory, hardwareConcurrency,
 * connection.effectiveType) are captured as static context and can be used to
 * bias the final score downstream.
 */

type Unsub = () => void;

export interface PressureSample {
  /** Unix millis when the score was computed. */
  timestamp: number;
  /** Fused score in [0, 1]. Higher = more pressure. */
  score: number;
  /** Individual component scores (each in [0, 1]). */
  components: {
    longtask: number;
    heap: number;
    storage: number;
    foldCost: number;
    syncLag: number;
  };
  /** Raw values used for the components, for diagnostics. */
  raw: {
    /** Long tasks observed in the last window. */
    longtaskCountPerMinute: number;
    /** Heap usage fraction, or null on non-Chrome. */
    heapUsedFraction: number | null;
    /** Storage usage fraction, or null if estimate() unavailable. */
    storageUsedFraction: number | null;
    /** Rolling avg microseconds per event, or null if not reported. */
    avgFoldMicrosPerEvent: number | null;
    /** Max |lag| across sync pairs, or null if not reported. */
    maxSyncLag: number | null;
  };
  /** Static device context captured at monitor startup. */
  device: DeviceContext;
}

export interface DeviceContext {
  /** navigator.deviceMemory in GB (coarse buckets), or null. */
  deviceMemoryGb: number | null;
  /** navigator.hardwareConcurrency, or null. */
  hardwareConcurrency: number | null;
  /** navigator.connection.effectiveType ('slow-2g'|'2g'|'3g'|'4g'), or null. */
  effectiveConnectionType: string | null;
  /** navigator.connection.saveData, or null. */
  saveData: boolean | null;
}

const WEIGHTS = {
  longtask: 0.30,
  heap: 0.25,
  storage: 0.20,
  foldCost: 0.15,
  syncLag: 0.10,
} as const;

/** Long-task count/minute at which that component maxes out. */
const LONGTASK_SATURATION_PER_MIN = 30;
/** Heap fraction at which that component maxes out. */
const HEAP_SATURATION = 0.9;
/** Storage fraction at which that component maxes out. */
const STORAGE_SATURATION = 0.9;
/** Fold microseconds/event at which that component maxes out. */
const FOLD_MICROS_SATURATION = 50;
/** Sync lag (events) at which that component maxes out. */
const SYNC_LAG_SATURATION = 500;

const SAMPLE_INTERVAL_MS = 2000;
const LONGTASK_WINDOW_MS = 60_000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function readDeviceContext(): DeviceContext {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as Record<string, unknown>) : {};
  const connection = nav.connection as { effectiveType?: string; saveData?: boolean } | undefined;
  return {
    deviceMemoryGb: typeof nav.deviceMemory === 'number' ? (nav.deviceMemory as number) : null,
    hardwareConcurrency:
      typeof nav.hardwareConcurrency === 'number' ? (nav.hardwareConcurrency as number) : null,
    effectiveConnectionType: connection?.effectiveType ?? null,
    saveData: typeof connection?.saveData === 'boolean' ? connection.saveData : null,
  };
}

function readHeapUsedFraction(): number | null {
  const perf = typeof performance !== 'undefined' ? (performance as unknown as Record<string, unknown>) : {};
  const memory = perf.memory as { usedJSHeapSize?: number; jsHeapSizeLimit?: number } | undefined;
  if (!memory || !memory.usedJSHeapSize || !memory.jsHeapSizeLimit) return null;
  return memory.usedJSHeapSize / memory.jsHeapSizeLimit;
}

/**
 * The PressureMonitor singleton. Start it once at app boot; subscribe for
 * samples, push `foldMicros` / `syncLag` updates from their producers.
 */
class PressureMonitor {
  private started = false;
  private device: DeviceContext = readDeviceContext();
  private longtaskObserver: PerformanceObserver | null = null;
  /** Timestamps (ms) of recent long tasks; older than LONGTASK_WINDOW_MS are evicted. */
  private longtaskEvents: number[] = [];
  private storageUsedFraction: number | null = null;
  private storageTimer: ReturnType<typeof setInterval> | null = null;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  private lastSample: PressureSample | null = null;
  private subscribers = new Set<(s: PressureSample) => void>();
  /** Pushed by fold worker (via main-thread relay). */
  private avgFoldMicrosPerEvent: number | null = null;
  /** Pushed by sync store on each syncPairs update. */
  private maxSyncLag: number | null = null;

  start(): void {
    if (this.started) return;
    if (typeof window === 'undefined') return;
    this.started = true;

    this.installLongtaskObserver();
    this.scheduleStorageProbe();
    this.sampleTimer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.longtaskObserver) {
      try {
        this.longtaskObserver.disconnect();
      } catch {
        // ignore
      }
      this.longtaskObserver = null;
    }
    if (this.storageTimer) {
      clearInterval(this.storageTimer);
      this.storageTimer = null;
    }
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.longtaskEvents = [];
    this.subscribers.clear();
  }

  /** Push rolling fold cost (microseconds/event). Called from main-thread relay of the fold worker. */
  reportFoldMicros(micros: number): void {
    if (Number.isFinite(micros) && micros >= 0) {
      this.avgFoldMicrosPerEvent = micros;
    }
  }

  /** Push max |lag| across sync pairs. Called from sync store. */
  reportSyncLag(lag: number): void {
    if (Number.isFinite(lag) && lag >= 0) {
      this.maxSyncLag = lag;
    }
  }

  /** Subscribe to samples; returns an unsubscribe function. */
  subscribe(cb: (s: PressureSample) => void): Unsub {
    this.subscribers.add(cb);
    if (this.lastSample) cb(this.lastSample);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Latest sample, or null if none yet. */
  getLastSample(): PressureSample | null {
    return this.lastSample;
  }

  /** Device context captured at startup. */
  getDeviceContext(): DeviceContext {
    return this.device;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private installLongtaskObserver(): void {
    // Feature-detect PerformanceObserver + 'longtask' entry type.
    const PO = typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null;
    if (!PO) return;
    const supported = (PO as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return;
    try {
      this.longtaskObserver = new PO((list) => {
        const now = performance.now();
        for (const _entry of list.getEntries()) {
          void _entry;
          this.longtaskEvents.push(now);
        }
        // Trim old events.
        const cutoff = now - LONGTASK_WINDOW_MS;
        while (this.longtaskEvents.length && this.longtaskEvents[0] < cutoff) {
          this.longtaskEvents.shift();
        }
      });
      this.longtaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      this.longtaskObserver = null;
    }
  }

  private scheduleStorageProbe(): void {
    const probe = async () => {
      const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
      if (!storage || typeof storage.estimate !== 'function') {
        this.storageUsedFraction = null;
        return;
      }
      try {
        const est = await storage.estimate();
        if (est && typeof est.usage === 'number' && typeof est.quota === 'number' && est.quota > 0) {
          this.storageUsedFraction = est.usage / est.quota;
        }
      } catch {
        // ignore
      }
    };
    void probe();
    this.storageTimer = setInterval(probe, 30_000);
  }

  private computeLongtaskPerMinute(): number {
    const now = performance.now();
    const cutoff = now - LONGTASK_WINDOW_MS;
    while (this.longtaskEvents.length && this.longtaskEvents[0] < cutoff) {
      this.longtaskEvents.shift();
    }
    return this.longtaskEvents.length; // window is 60s → already per-minute
  }

  private sample(): void {
    const longtaskPerMin = this.computeLongtaskPerMinute();
    const heapFrac = readHeapUsedFraction();
    const storageFrac = this.storageUsedFraction;
    const foldMicros = this.avgFoldMicrosPerEvent;
    const syncLag = this.maxSyncLag;

    const components = {
      longtask: clamp01(longtaskPerMin / LONGTASK_SATURATION_PER_MIN),
      heap: heapFrac == null ? 0 : clamp01(heapFrac / HEAP_SATURATION),
      storage: storageFrac == null ? 0 : clamp01(storageFrac / STORAGE_SATURATION),
      foldCost: foldMicros == null ? 0 : clamp01(foldMicros / FOLD_MICROS_SATURATION),
      syncLag: syncLag == null ? 0 : clamp01(syncLag / SYNC_LAG_SATURATION),
    };

    const score = clamp01(
      components.longtask * WEIGHTS.longtask +
        components.heap * WEIGHTS.heap +
        components.storage * WEIGHTS.storage +
        components.foldCost * WEIGHTS.foldCost +
        components.syncLag * WEIGHTS.syncLag,
    );

    const sample: PressureSample = {
      timestamp: Date.now(),
      score,
      components,
      raw: {
        longtaskCountPerMinute: longtaskPerMin,
        heapUsedFraction: heapFrac,
        storageUsedFraction: storageFrac,
        avgFoldMicrosPerEvent: foldMicros,
        maxSyncLag: syncLag,
      },
      device: this.device,
    };
    this.lastSample = sample;
    for (const cb of this.subscribers) {
      try {
        cb(sample);
      } catch {
        // subscriber errors must not break the monitor
      }
    }
  }
}

export const pressureMonitor = new PressureMonitor();
