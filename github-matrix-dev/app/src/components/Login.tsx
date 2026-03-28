import { useState, type FormEvent } from 'react';
import { login, type MatrixSession } from '../matrix/client';

interface LoginProps {
  onLogin: (session: MatrixSession) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [homeserver, setHomeserver] = useState('app.aminoimmigration.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>EO///DB</h1>
        <p style={styles.subtitle}>Decentralized Database</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <input
            type="text"
            placeholder="Homeserver (e.g. matrix.org)"
            value={homeserver}
            onChange={(e) => setHomeserver(e.target.value)}
            disabled={loading}
            style={{ ...styles.input, fontSize: 13, color: '#aaa' }}
          />
          <input
            type="text"
            placeholder="Matrix username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            style={styles.input}
            autoComplete="username"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            style={styles.input}
            autoComplete="current-password"
          />
          {error && <div style={styles.error}>{error}</div>}
          <button type="submit" disabled={loading || !homeserver || !username || !password} style={styles.button}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
        <p style={styles.server}>Direct Matrix connection</p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: '#0a0a0a',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  card: {
    background: '#1a1a1a',
    borderRadius: 12,
    padding: '48px 40px',
    width: 360,
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  },
  title: {
    margin: 0,
    fontSize: 28,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '0.02em',
  },
  subtitle: {
    margin: '4px 0 32px',
    fontSize: 14,
    color: '#888',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  input: {
    padding: '12px 16px',
    fontSize: 15,
    border: '1px solid #333',
    borderRadius: 8,
    background: '#111',
    color: '#fff',
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
    color: '#555',
    textAlign: 'center',
  },
};
