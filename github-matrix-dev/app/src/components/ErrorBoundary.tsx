/**
 * Error boundary — catches fold/sync errors and shows a recovery UI.
 */

import { Component, type ReactNode } from 'react';
import { isChunkLoadError, clearChunkReloadGuard, forceFreshReload } from '../lib/chunk-reload';

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

      // If this is a dynamic-import / chunk load failure, clicking a soft
      // "Try again" will just re-attempt the same missing chunk and the
      // error will immediately come back. Offer a hard reload instead, and
      // clear the reload guard so the next navigation can retry cleanly.
      const isChunkError = isChunkLoadError(this.state.error);

      const handleRetry = () => {
        if (isChunkError) {
          // Clear the one-shot guard and force-revalidate index.html before
          // reloading — a plain location.reload() would re-use the cached
          // stale HTML and hit the same missing chunk immediately.
          clearChunkReloadGuard();
          void forceFreshReload();
          return;
        }
        this.setState({ error: null });
      };

      // ErrorBoundary is a class component that can't use hooks.
      // Use CSS variables set by the theme provider on <html data-theme>.
      // Fallback to light theme colors as defaults.
      return (
        <div style={styles.container}>
          <div style={styles.icon}>!</div>
          <div style={styles.title}>Something went wrong</div>
          <div style={styles.message}>{this.state.error.message}</div>
          <button
            style={styles.button}
            onClick={handleRetry}
          >
            {isChunkError ? 'Reload page' : 'Try again'}
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
    color: 'inherit',
  },
  message: {
    fontSize: 12,
    color: 'inherit',
    opacity: 0.7,
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
    border: '1px solid currentColor',
    borderRadius: 6,
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    opacity: 0.8,
  },
};
