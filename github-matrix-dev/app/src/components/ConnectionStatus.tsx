/**
 * Connection status indicator — shows online/offline/syncing state.
 */

import { useState, useEffect } from 'react';

export type ConnectionState = 'online' | 'offline' | 'syncing';

interface ConnectionStatusProps {
  state: ConnectionState;
}

export function ConnectionStatus({ state }: ConnectionStatusProps) {
  return (
    <div style={{ ...styles.container, ...stateStyles[state] }}>
      <div style={{ ...styles.dot, background: stateColors[state] }} />
      <span style={styles.label}>{stateLabels[state]}</span>
    </div>
  );
}

const stateLabels: Record<ConnectionState, string> = {
  online: 'Connected',
  offline: 'Offline',
  syncing: 'Syncing...',
};

const stateColors: Record<ConnectionState, string> = {
  online: '#16a34a',
  offline: '#d9487a',
  syncing: '#c2700a',
};

const stateStyles: Record<ConnectionState, React.CSSProperties> = {
  online: { borderColor: '#b8e4ca', background: '#f0faf4' },
  offline: { borderColor: '#f0b8c8', background: '#fdf2f5' },
  syncing: { borderColor: '#f0d9b8', background: '#fef6ed' },
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 10px',
    borderRadius: 12,
    border: '1px solid',
    fontSize: 10,
    fontWeight: 500,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
  },
  label: {
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: 0.3,
  },
};

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
