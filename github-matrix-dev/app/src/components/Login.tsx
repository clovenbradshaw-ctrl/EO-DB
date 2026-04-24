import { useState, useEffect, type FormEvent } from 'react';
import { login, normalizeHomeserver, toMatrixUserId, type MatrixSession } from '../matrix/client';
import { saveOfflineCredentials, verifyOfflineCredentials, listOfflineAccounts } from '../lib/offline-auth';
import { useTheme, type Theme } from '../theme';

interface LoginProps {
  onLogin: (session: MatrixSession) => void;
  onLocalMode?: () => void;
}

export function Login({ onLogin, onLocalMode }: LoginProps) {
  const [homeserver, setHomeserver] = useState('app.aminoimmigration.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [hasOfflineAccounts, setHasOfflineAccounts] = useState(false);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  useEffect(() => {
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    listOfflineAccounts().then((accounts) => {
      setHasOfflineAccounts(accounts.length > 0);
    });
  }, []);

  const parsed = parseUserInput(username);
  const usernameHasServer = parsed.server !== null;
  const effectiveHomeserver = usernameHasServer ? parsed.server! : homeserver;
  const loginUsername = usernameHasServer ? `@${parsed.user}:${parsed.server}` : username;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const baseUrl = normalizeHomeserver(effectiveHomeserver);
    const userId = toMatrixUserId(loginUsername, effectiveHomeserver);

    try {
      let session: MatrixSession | null = null;

      if (isOffline) {
        session = await verifyOfflineCredentials(baseUrl, userId, password);
        if (!session) {
          setError('Offline login failed — wrong password or no saved credentials');
          setLoading(false);
          return;
        }
      } else {
        try {
          session = await login(effectiveHomeserver, loginUsername, password);
          await saveOfflineCredentials(session, password);
        } catch (err: any) {
          if (isNetworkError(err)) {
            setIsOffline(true);
            session = await verifyOfflineCredentials(baseUrl, userId, password);
            if (!session) {
              setError('Network unavailable and no offline credentials found');
              setLoading(false);
              return;
            }
          } else {
            setError(err.data?.error || err.message || 'Login failed');
            setLoading(false);
            return;
          }
        }
      }

      onLogin(session);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.container}>
      <div style={s.card}>
        <h1 style={s.title}>EO///DB</h1>
        <p style={s.subtitle}>Decentralized Database</p>
        {isOffline && hasOfflineAccounts && (
          <div style={s.offlineBadge}>Offline Mode</div>
        )}
        <form onSubmit={handleSubmit} style={s.form}>
          <input
            type="text"
            placeholder="Matrix username"
            aria-label="Matrix username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            style={s.input}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            style={s.input}
            autoComplete="current-password"
          />
          {!usernameHasServer && (
            <input
              type="text"
              placeholder="Homeserver (e.g. matrix.org)"
              aria-label="Homeserver"
              value={homeserver}
              onChange={(e) => setHomeserver(e.target.value)}
              disabled={loading}
              style={{ ...s.input, fontSize: 13, color: theme.loginTextDim }}
            />
          )}
          {error && <div style={s.error} role="alert">{error}</div>}
          <button
            type="submit"
            disabled={loading || !effectiveHomeserver || !username || !password}
            style={{
              ...s.button,
              ...((loading || !effectiveHomeserver || !username || !password) ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
            }}
          >
            {loading ? 'Signing in...' : isOffline ? 'Sign in offline' : 'Sign in'}
          </button>
          {onLocalMode && (
            <button
              type="button"
              onClick={onLocalMode}
              style={s.localButton}
            >
              Use Locally
            </button>
          )}
        </form>
        <p style={s.server}>
          {isOffline ? 'Offline — using saved credentials' : 'Direct Matrix connection'}
        </p>
      </div>
    </div>
  );
}

function parseUserInput(username: string): { user: string; server: string | null } {
  const trimmed = username.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  const colonIdx = bare.indexOf(':');
  if (colonIdx === -1) return { user: bare, server: null };
  const user = bare.slice(0, colonIdx);
  const server = bare.slice(colonIdx + 1);
  return { user, server: server || null };
}

function isNetworkError(err: any): boolean {
  if (err.name === 'ConnectionError' || err.name === 'TypeError') return true;
  if (typeof err.message === 'string' && /fetch|network|failed to fetch|econnrefused|timeout/i.test(err.message)) return true;
  if (err.errcode === 'M_UNKNOWN' && err.httpStatus === undefined) return true;
  return false;
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: '100vh',
      padding: '16px',
      background: t.loginBg,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    card: {
      background: t.loginCard,
      borderRadius: 12,
      padding: 'clamp(24px, 5vw, 48px) clamp(20px, 4vw, 40px)',
      maxWidth: 360,
      width: '100%',
      boxShadow: `0 8px 32px ${t.shadow}`,
    },
    title: {
      margin: 0,
      fontSize: 28,
      fontWeight: 700,
      color: t.loginText,
      letterSpacing: '0.02em',
    },
    subtitle: {
      margin: '4px 0 32px',
      fontSize: 14,
      color: t.loginTextDim,
    },
    hint: {
      margin: '4px 0 0',
      fontSize: 13,
      color: t.loginTextDim,
      lineHeight: 1.5,
    },
    form: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    },
    input: {
      padding: '12px 16px',
      fontSize: 15,
      border: `1px solid ${t.loginBorder}`,
      borderRadius: 8,
      background: t.loginInput,
      color: t.loginText,
      outline: 'none',
    },
    error: {
      color: t.danger,
      fontSize: 13,
      padding: '4px 0',
    },
    button: {
      marginTop: 8,
      padding: '12px 0',
      fontSize: 15,
      fontWeight: 600,
      border: 'none',
      borderRadius: 8,
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
    },
    server: {
      marginTop: 24,
      fontSize: 12,
      color: t.loginTextDim,
      textAlign: 'center',
    },
    localButton: {
      padding: '12px 0',
      fontSize: 15,
      fontWeight: 600,
      border: `1px solid ${t.loginBorder}`,
      borderRadius: 8,
      background: 'transparent',
      color: t.loginTextDim,
      cursor: 'pointer',
    },
    offlineBadge: {
      display: 'inline-block',
      padding: '4px 12px',
      fontSize: 12,
      fontWeight: 600,
      borderRadius: 12,
      background: '#f59e0b22',
      color: '#d97706',
      marginBottom: 16,
      border: '1px solid #f59e0b44',
    },
  };
}
