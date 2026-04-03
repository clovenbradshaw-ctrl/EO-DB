/**
 * SyncToast — brief confirmation when events sync to Matrix (or fail to).
 *
 * Shows a small, auto-dismissing pill at the bottom of the screen.
 * Driven by the SyncManager.onSyncStatus callback.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../theme';

export type SyncToastStatus = 'confirmed' | 'queued' | 'rate-limited' | null;

interface SyncToastProps {
  /** The latest sync status. Changes (including same-value) re-trigger the toast. */
  status: SyncToastStatus;
  /** Incrementing key to re-trigger even when status stays the same. */
  seq: number;
}

const DISPLAY_MS = 2500;

export function SyncToast({ status, seq }: SyncToastProps) {
  const { theme } = useTheme();
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<SyncToastStatus>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!status) return;
    setCurrent(status);
    setVisible(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), DISPLAY_MS);
    return () => clearTimeout(timerRef.current);
  }, [status, seq]);

  if (!visible || !current) return null;

  const config = {
    confirmed: {
      bg: theme.successBg,
      border: theme.successBorder,
      color: theme.successText ?? theme.success,
      label: 'Synced to Matrix',
    },
    queued: {
      bg: theme.warningBg,
      border: theme.warningBorder,
      color: theme.warningText ?? theme.warning,
      label: 'Queued locally (offline)',
    },
    'rate-limited': {
      bg: theme.dangerBg,
      border: theme.dangerBorder,
      color: theme.dangerText ?? theme.danger,
      label: 'Rate limited — retrying...',
    },
  }[current];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 20,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '8px 16px',
        borderRadius: 8,
        border: `1px solid ${config.border}`,
        background: config.bg,
        color: config.color,
        fontSize: 12,
        fontWeight: 500,
        fontFamily: "'JetBrains Mono', monospace",
        zIndex: 9999,
        pointerEvents: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
      }}
    >
      {config.label}
    </div>
  );
}

/**
 * Hook to track the latest sync status for use with SyncToast.
 * Returns [status, seq, onSyncStatus].
 *
 * Pass `onSyncStatus` to SyncManager.onSyncStatus.
 * Pass `status` and `seq` to <SyncToast>.
 */
export function useSyncToast(): [SyncToastStatus, number, (status: 'confirmed' | 'queued' | 'rate-limited') => void] {
  const [entry, setEntry] = useState<{ status: SyncToastStatus; seq: number }>({ status: null, seq: 0 });

  const onStatus = useCallback((s: 'confirmed' | 'queued' | 'rate-limited') => {
    setEntry((prev) => ({ status: s, seq: prev.seq + 1 }));
  }, []);

  return [entry.status, entry.seq, onStatus];
}
