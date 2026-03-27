/**
 * Error boundary — catches fold/sync errors and shows a recovery UI.
 */

import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div style={styles.container}>
          <div style={styles.icon}>!</div>
          <div style={styles.title}>Something went wrong</div>
          <div style={styles.message}>{this.state.error.message}</div>
          <button
            style={styles.button}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 48,
    gap: 12,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: '#fdf2f5',
    border: '2px solid #d9487a',
    color: '#d9487a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 18,
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    color: '#1a1816',
  },
  message: {
    fontSize: 12,
    color: '#7a756d',
    fontFamily: "'JetBrains Mono', monospace",
    maxWidth: 400,
    textAlign: 'center' as const,
    wordBreak: 'break-word' as const,
  },
  button: {
    marginTop: 8,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 500,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: '#fff',
    color: '#2c2a26',
    cursor: 'pointer',
  },
};
