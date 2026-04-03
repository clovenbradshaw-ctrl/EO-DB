import { useState, useEffect, useRef } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreSession, type MatrixSession } from './matrix/client';
import { useEoStore } from './store/eo-store';
import { useFilenStore } from './filen/filen-store';
import { ThemeProvider, useTheme } from './theme';

function AppInner() {
  const [session, setSession] = useState<MatrixSession | null>(null);
  const [loading, setLoading] = useState(true);
  const teardown = useEoStore((s) => s.teardown);
  const { theme } = useTheme();

  // Capture deep-link hash before login so we can restore it after auth
  const pendingRedirect = useRef(window.location.hash || '');

  useEffect(() => {
    const saved = restoreSession();
    if (saved) {
      setSession(saved);
    }
    // Restore Filen session from localStorage (no-op if not previously logged in)
    useFilenStore.getState().restore();
    setLoading(false);
  }, []);

  function handleLogin(s: MatrixSession) {
    setSession(s);
    // Restore the deep-link the user originally landed on
    if (pendingRedirect.current && pendingRedirect.current !== '#/') {
      window.location.hash = pendingRedirect.current;
    }
  }

  function handleLogout() {
    teardown();
    setSession(null);
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: theme.textSecondary }}>Loading...</div>;
  }

  if (!session) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <ErrorBoundary>
      <Layout session={session} onLogout={handleLogout} />
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
