import { useState, useEffect, type FormEvent } from 'react';
import { login, normalizeHomeserver, toMatrixUserId, type MatrixSession } from '../matrix/client';
import { saveOfflineCredentials, verifyOfflineCredentials, listOfflineAccounts } from '../lib/offline-auth';
import { useTheme, type Theme } from '../theme';

interface LoginProps {
  onLogin: (session: MatrixSession) => void;
}

export function Login({ onLogin }: LoginProps) {
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const baseUrl = normalizeHomeserver(homeserver);
    const userId = toMatrixUserId(username, homeserver);

    try {
      if (isOffline) {
        // Offline-only path
        const session = await verifyOfflineCredentials(baseUrl, userId, password);
        if (session) {
          onLogin(session);
        } else {
          setError('Offline login failed — wrong password or no saved credentials');
        }
      } else {
        // Online path — try Matrix login, then save offline credentials
        try {
          const session = await login(homeserver, username, password);
          await saveOfflineCredentials(session, password);
          onLogin(session);
        } catch (err: any) {
          // If online login fails due to network error, try offline fallback
          if (isNetworkError(err)) {
            setIsOffline(true);
            const session = await verifyOfflineCredentials(baseUrl, userId, password);
            if (session) {
              onLogin(session);
            } else {
              setError('Network unavailable and no offline credentials found');
            }
          } else {
            setError(err.data?.error || err.message || 'Login failed');
          }
        }
      }
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
            placeholder="Homeserver (e.g. matrix.org)"
            value={homeserver}
            onChange={(e) => setHomeserver(e.target.value)}
            disabled={loading}
            style={{ ...s.input, fontSize: 13, color: theme.loginTextDim }}
          />
          <input
            type="text"
            placeholder="Matrix username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            style={s.input}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            style={s.input}
            autoComplete="current-password"
          />
          {error && <div style={s.error}>{error}</div>}
          <button type="submit" disabled={loading || !homeserver || !username || !password} style={s.button}>
            {loading ? 'Signing in...' : isOffline ? 'Sign in offline' : 'Sign in'}
          </button>
        </form>
        <p style={s.server}>
          {isOffline ? 'Offline — using saved credentials' : 'Direct Matrix connection'}
        </p>
      </div>
    </div>
  );
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
      background: t.loginBg,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    },
    card: {
      background: t.loginCard,
      borderRadius: 12,
      padding: '48px 40px',
      width: 360,
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
      color: '#f44',
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
