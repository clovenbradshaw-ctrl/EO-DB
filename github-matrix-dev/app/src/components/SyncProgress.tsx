/**
 * Loading skeleton — shown during initial sync or snapshot hydration.
 */

interface SyncProgressProps {
  message: string;
  detail?: string;
}

export function SyncProgress({ message, detail }: SyncProgressProps) {
  return (
    <div style={styles.container}>
      <div style={styles.spinner} />
      <div style={styles.message}>{message}</div>
      {detail && <div style={styles.detail}>{detail}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
    padding: 48,
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #e5e2dd',
    borderTopColor: '#1a6dd4',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  message: {
    fontSize: 15,
    fontWeight: 500,
    color: '#2c2a26',
  },
  detail: {
    fontSize: 12,
    color: '#7a756d',
    fontFamily: "'JetBrains Mono', monospace",
  },
};
