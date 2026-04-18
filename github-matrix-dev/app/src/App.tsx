import { useState, useEffect, useRef } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreSession, type MatrixSession } from './matrix/client';
import { useEoStore } from './store/eo-store';
import { ThemeProvider, useTheme } from './theme';
import { initGoogleOAuth, handleOAuthCallback } from './google-drive/gdrive-oauth';
import { startWriteBackListener } from './google-calendar/gcalendar-sync';

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
  // Tracks the OAuth callback state when rendering inside the popup window.
  // 'completing' → callback in-flight, 'done' → tokens stored successfully,
  // 'error' → exchange failed. Used to render a reliable close-hint in the
  // popup placeholder even if window.close() is blocked by COOP.
  const [oauthPopupStatus, setOauthPopupStatus] =
    useState<'completing' | 'done' | 'error'>('completing');
  const teardown = useEoStore((s) => s.teardown);
  const initLocal = useEoStore((s) => s.initLocal);
  const { theme } = useTheme();

  // Capture deep-link hash before login so we can restore it after auth
  const pendingRedirect = useRef(window.location.hash || '');

  useEffect(() => {
    // Initialise Google OAuth module
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || '871214509438-ei206mo0835gr0n47d2lg4ujv7hnn2in.apps.googleusercontent.com';
    const redirectUri = window.location.origin + window.location.pathname;
    initGoogleOAuth(clientId, redirectUri);

    // Handle OAuth2 PKCE callback — exchanges ?code= for tokens
    if (window.location.search.includes('code=')) {
      handleOAuthCallback()
        .then((ok) => setOauthPopupStatus(ok ? 'done' : 'error'))
        .catch((e) => {
          console.warn('[EO-DB] Google OAuth callback failed:', e);
          setOauthPopupStatus('error');
        });
      // handleOAuthCallback clears the query string and closes the popup or
      // restores the pending route. We still continue with normal app startup.
    }

    // Install the Google Calendar write-back listener. Idempotent — claims
    // the single onDispatch slot on useEoStore so cell edits under
    // google_calendar.* scopes debounce-PATCH to Google.
    startWriteBackListener();

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

  // Guard: if this is the OAuth popup callback, show a minimal placeholder
  // until handleOAuthCallback() (running in useEffect) closes the popup.
  // Without this guard the popup renders the full app, including another
  // "Connect Google Drive" button, which re-triggers the OAuth flow (loop).
  //
  // Under Chrome's COOP enforcement, `window.close()` in the popup can
  // silently fail after the round-trip through accounts.google.com. When
  // that happens the popup stays visible — so once the callback resolves we
  // render an explicit "you may close this window" message with a Close
  // button so the user always has a way to dismiss the popup.
  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.get('state') === 'popup' && searchParams.has('code')) {
    const baseStyle: React.CSSProperties = {
      padding: 40,
      textAlign: 'center',
      color: theme.textSecondary,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 16,
    };
    if (oauthPopupStatus === 'completing') {
      return <div style={baseStyle}>Completing Google sign-in…</div>;
    }
    const message = oauthPopupStatus === 'done'
      ? 'Sign-in complete. You may close this window.'
      : 'Sign-in failed. Please close this window and try again.';
    return (
      <div style={baseStyle}>
        <div>{message}</div>
        <button
          type="button"
          onClick={() => { try { window.close(); } catch { /* ignore */ } }}
          style={{
            padding: '10px 20px',
            fontSize: 14,
            fontWeight: 600,
            border: 'none',
            borderRadius: 8,
            background: '#2563eb',
            color: '#fff',
            cursor: 'pointer',
          }}
        >
          Close window
        </button>
      </div>
    );
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
