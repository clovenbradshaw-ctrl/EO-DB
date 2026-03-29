import { useState, type FormEvent } from 'react';
import { login, type MatrixSession } from '../matrix/client';
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
  const { theme, toggleTheme } = useTheme();
  const s = makeStyles(theme);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const session = await login(homeserver, username, password);
      onLogin(session);
    } catch (err: any) {
      setError(err.data?.error || err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.container}>
      <button
        onClick={toggleTheme}
        style={s.themeToggle}
        title={theme.mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      >
        {theme.mode === 'light' ? (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8.5a5.5 5.5 0 0 1-7-7 5.5 5.5 0 1 0 7 7z" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
          </svg>
        )}
      </button>
      <div style={s.card}>
        <h1 style={s.title}>EO///DB</h1>
        <p style={s.subtitle}>Decentralized Database</p>
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
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <p style={s.server}>Direct Matrix connection</p>
      </div>
    </div>
  );
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
      position: 'relative' as const,
    },
    themeToggle: {
      position: 'absolute' as const,
      top: 20,
      right: 20,
      width: 40,
      height: 40,
      borderRadius: 8,
      border: `1px solid ${t.loginBorder}`,
      background: 'transparent',
      color: t.loginTextDim,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
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
  };
}
