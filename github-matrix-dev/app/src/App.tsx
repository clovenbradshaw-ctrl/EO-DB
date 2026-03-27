import { useState, useEffect } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { restoreSession, type MatrixSession } from './matrix/client';

export function App() {
  const [session, setSession] = useState<MatrixSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = restoreSession();
    if (saved) {
      setSession(saved);
    }
    setLoading(false);
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>;
  }

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return <Layout session={session} onLogout={() => setSession(null)} />;
}
