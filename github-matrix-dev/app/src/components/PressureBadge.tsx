/**
 * PressureBadge — dev-only HUD for the PressureMonitor.
 *
 * Renders a small fixed-position badge showing the current pressure score
 * and a breakdown of its component signals. Intended for development &
 * validating the signal set before Phase 2 (range fetches) and Phase 3
 * (eviction) start acting on the score.
 *
 * Shown only when the URL contains `?pressure=1` or localStorage has
 * `eodb.pressureBadge === '1'`, so it's invisible to normal users.
 */

import { useMemo } from 'react';
import { usePressure } from '../perf/use-pressure';

function isEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('pressure') === '1') return true;
    if (window.localStorage?.getItem('eodb.pressureBadge') === '1') return true;
  } catch {
    // ignore — private mode etc.
  }
  return false;
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  return `${Math.round(n * 100)}%`;
}

export function PressureBadge(): React.ReactElement | null {
  const enabled = useMemo(isEnabled, []);
  const sample = usePressure();
  if (!enabled) return null;
  if (!sample) return (
    <div style={styles.badge}>
      <div style={styles.header}>pressure: —</div>
    </div>
  );
  const { score, components, raw, device } = sample;
  const bar = Math.round(score * 100);
  const color = score > 0.66 ? '#e74c3c' : score > 0.33 ? '#f1c40f' : '#2ecc71';
  return (
    <div style={styles.badge}>
      <div style={styles.header}>
        <span style={{ color }}>●</span>&nbsp;pressure {bar}%
      </div>
      <div style={styles.row}>
        <span>longtask</span><span>{fmtPct(components.longtask)} ({raw.longtaskCountPerMinute}/min)</span>
      </div>
      <div style={styles.row}>
        <span>heap</span><span>{fmtPct(components.heap)} ({fmtPct(raw.heapUsedFraction)})</span>
      </div>
      <div style={styles.row}>
        <span>storage</span><span>{fmtPct(components.storage)} ({fmtPct(raw.storageUsedFraction)})</span>
      </div>
      <div style={styles.row}>
        <span>fold</span><span>{fmtPct(components.foldCost)} ({raw.avgFoldMicrosPerEvent?.toFixed(1) ?? '—'} µs/ev)</span>
      </div>
      <div style={styles.row}>
        <span>syncLag</span><span>{fmtPct(components.syncLag)} ({raw.maxSyncLag ?? '—'})</span>
      </div>
      <div style={styles.device}>
        {device.deviceMemoryGb ?? '?'}GB · {device.hardwareConcurrency ?? '?'}c · {device.effectiveConnectionType ?? '?'}
        {device.saveData ? ' · saveData' : ''}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  badge: {
    position: 'fixed',
    bottom: 8,
    right: 8,
    zIndex: 999999,
    background: 'rgba(20, 20, 24, 0.92)',
    color: '#eee',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    lineHeight: 1.4,
    padding: '6px 10px',
    borderRadius: 6,
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
    pointerEvents: 'none',
    minWidth: 220,
  },
  header: {
    fontWeight: 600,
    marginBottom: 4,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 8,
  },
  device: {
    marginTop: 4,
    paddingTop: 4,
    borderTop: '1px solid rgba(255,255,255,0.12)',
    opacity: 0.7,
  },
};
