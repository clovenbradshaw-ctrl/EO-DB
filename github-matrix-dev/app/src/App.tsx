import { useState, useEffect, useRef } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreSession, type MatrixSession } from './matrix/client';
import { useEoStore } from './store/eo-store';
import { useFilenStore } from './filen/filen-store';
import { ThemeProvider, useTheme } from './theme';

/** Synthetic session used for local-only mode (no Matrix server). */
const LOCAL_SESSION: MatrixSession = {
  userId: '@local:localhost',
  deviceId: 'local-device',
  accessToken: '',
  homeserver: 'http://localhost',
};

function AppInner() {
  return <AppMain />;
}

function AppMain() {
  const [session, setSession] = useState<MatrixSession | null>(null);
  const [localMode, setLocalMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const teardown = useEoStore((s) => s.teardown);
  const initLocal = useEoStore((s) => s.initLocal);
  const { theme } = useTheme();

  // Capture deep-link hash before login so we can restore it after auth
  const pendingRedirect = useRef(window.location.hash || '');

  useEffect(() => {
    const saved = restoreSession();
    if (saved) {
      setSession(saved);
    }
    // Check if we were previously in local mode
    if (localStorage.getItem('eo-local-mode') === '1') {
      setLocalMode(true);
      setSession(LOCAL_SESSION);
    }
    // Restore Filen session from localStorage (no-op if not previously logged in)
    useFilenStore.getState().restore();
    setLoading(false);
  }, []);

  function handleLogin(s: MatrixSession) {
    setSession(s);
    localStorage.removeItem('eo-local-mode');
    setLocalMode(false);
    // Restore the deep-link the user originally landed on
    if (pendingRedirect.current && pendingRedirect.current !== '#/') {
      window.location.hash = pendingRedirect.current;
    }
  }

  function handleLocalMode() {
    localStorage.setItem('eo-local-mode', '1');
    setLocalMode(true);
    setSession(LOCAL_SESSION);
    // Bootstrap the local store immediately
    initLocal('local').catch((e) => console.warn('[EO-DB] Local store init failed:', e));
  }

  function handleLogout() {
    teardown();
    setSession(null);
    setLocalMode(false);
    localStorage.removeItem('eo-local-mode');
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: theme.textSecondary }}>Loading...</div>;
  }

  if (!session) {
    return <Login onLogin={handleLogin} onLocalMode={handleLocalMode} />;
  }

  return (
    <ErrorBoundary>
      <Layout session={session} onLogout={handleLogout} localMode={localMode} />
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
