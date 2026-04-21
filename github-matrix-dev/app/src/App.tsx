import { useState, useEffect, useRef } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreSession, type MatrixSession } from './matrix/client';
import { useEoStore } from './store/eo-store';
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
    setLoading(false);
  }, []);

  function handleLogin(s: MatrixSession) {
    setSession(s);
    localStorage.removeItem('eo-local-mode');
    setLocalMode(false);
    // Restore the deep-link the user originally landed on — but only if it
    // looks like a genuine in-app hash route, to avoid open-redirect or
    // javascript:-scheme attacks via the URL fragment.
    const pending = pendingRedirect.current;
    if (pending && pending !== '#/' && /^#\/[A-Za-z0-9/_\-.?=&]*$/.test(pending)) {
      window.location.hash = pending;
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
    return (
      <div
        role="status"
        aria-live="polite"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 12,
          color: theme.textSecondary,
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <span
          style={{
            width: 24,
            height: 24,
            border: `2px solid ${theme.border}`,
            borderTopColor: theme.accent,
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
            display: 'inline-block',
          }}
        />
        <div style={{ fontSize: 13 }}>Loading data…</div>
      </div>
    );
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
