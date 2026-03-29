/**
 * Connection status indicator — shows online/offline/syncing state.
 */

import { useState, useEffect } from 'react';
import { useTheme, type Theme } from '../theme';

export type ConnectionState = 'online' | 'offline' | 'syncing';

interface ConnectionStatusProps {
  state: ConnectionState;
}

export function ConnectionStatus({ state }: ConnectionStatusProps) {
  const { theme } = useTheme();

  const stateConfig: Record<ConnectionState, { color: string; bg: string; borderColor: string; label: string }> = {
    online: { color: theme.success, bg: theme.successBg, borderColor: theme.successBorder, label: 'Connected' },
    offline: { color: theme.danger, bg: theme.dangerBg, borderColor: theme.dangerBorder, label: 'Offline' },
    syncing: { color: theme.warning, bg: theme.warningBg, borderColor: theme.warningBorder, label: 'Syncing...' },
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
    }}>
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
