import { useState, useEffect } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreSession, type MatrixSession } from './matrix/client';
import { useEoStore } from './store/eo-store';

export function App() {
  const [session, setSession] = useState<MatrixSession | null>(null);
  const [loading, setLoading] = useState(true);
  const teardown = useEoStore((s) => s.teardown);

  useEffect(() => {
    const saved = restoreSession();
    if (saved) {
      setSession(saved);
    }
    setLoading(false);
  }, []);

  function handleLogout() {
    teardown();
    setSession(null);
  }

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#7a756d' }}>Loading...</div>;
  }

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return (
    <ErrorBoundary>
      <Layout session={session} onLogout={handleLogout} />
    </ErrorBoundary>
  );
}
