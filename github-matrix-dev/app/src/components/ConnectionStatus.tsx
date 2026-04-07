/**
 * Connection status indicator — shows online/offline/syncing state.
 */

import { useState, useEffect } from 'react';
import { useTheme, type Theme } from '../theme';

export type ConnectionState = 'online' | 'offline' | 'syncing' | 'local' | 'error';

interface ConnectionStatusProps {
  state: ConnectionState;
  onRetry?: () => void;
  errorMessage?: string;
  /** Label for the action button (default: "Retry") */
  retryLabel?: string;
}

export function ConnectionStatus({ state, onRetry, errorMessage, retryLabel }: ConnectionStatusProps) {
  const { theme } = useTheme();

  const stateConfig: Record<ConnectionState, { color: string; bg: string; borderColor: string; label: string }> = {
    online: { color: theme.success, bg: theme.successBg, borderColor: theme.successBorder, label: 'Connected' },
    offline: { color: theme.danger, bg: theme.dangerBg, borderColor: theme.dangerBorder, label: 'Offline' },
    syncing: { color: theme.warning, bg: theme.warningBg, borderColor: theme.warningBorder, label: 'Syncing...' },
    local: { color: theme.accent, bg: theme.accentBg, borderColor: theme.accentBorder, label: 'Local' },
    error: { color: theme.danger, bg: theme.dangerBg, borderColor: theme.dangerBorder, label: 'Error' },
  };

  const config = stateConfig[state];

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 10px',
      borderRadius: 12,
      border: `1px solid ${config.borderColor}`,
      background: config.bg,
      fontSize: 10,
      fontWeight: 500,
      flexShrink: 0,
      whiteSpace: 'nowrap' as const,
    }} title={errorMessage || undefined}>
      <div style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: config.color,
      }} />
      <span style={{
        fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: 0.3,
      }}>
        {config.label}
      </span>
      {state === 'error' && onRetry && (
        <button
          onClick={onRetry}
          style={{
            background: 'none',
            border: `1px solid ${config.borderColor}`,
            borderRadius: 8,
            color: config.color,
            cursor: 'pointer',
            fontSize: 9,
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            padding: '1px 6px',
            marginLeft: 2,
          }}
        >
          {retryLabel || 'Retry'}
        </button>
      )}
    </div>
  );
}

/**
 * Hook to track browser online/offline status.
 */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(
    navigator.onLine ? 'online' : 'offline',
  );

  useEffect(() => {
    function handleOnline() { setState('online'); }
    function handleOffline() { setState('offline'); }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return state;
}
