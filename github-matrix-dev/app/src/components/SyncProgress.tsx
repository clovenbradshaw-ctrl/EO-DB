/**
 * Loading skeleton — shown during initial sync or snapshot hydration.
 */

import { useTheme } from '../theme';

interface SyncProgressProps {
  message: string;
  detail?: string;
}

export function SyncProgress({ message, detail }: SyncProgressProps) {
  const { theme } = useTheme();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 16,
      padding: 48,
    }}>
      <div style={{
        width: 32,
        height: 32,
        border: `3px solid ${theme.border}`,
        borderTopColor: theme.accent,
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <div style={{ fontSize: 15, fontWeight: 500, color: theme.text }}>{message}</div>
      {detail && (
        <div style={{
          fontSize: 12,
          color: theme.textSecondary,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          {detail}
        </div>
      )}
    </div>
  );
}
