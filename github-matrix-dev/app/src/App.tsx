import { useState, useEffect } from 'react';
import { Login } from './components/Login';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreSession, type MatrixSession } from './matrix/client';
import { useEoStore } from './store/eo-store';
import { ThemeProvider, useTheme } from './theme';

function AppInner() {
  const [session, setSession] = useState<MatrixSession | null>(null);
  const [loading, setLoading] = useState(true);
  const teardown = useEoStore((s) => s.teardown);
  const { theme } = useTheme();

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
    return <div style={{ padding: 40, textAlign: 'center', color: theme.textSecondary }}>Loading...</div>;
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

export function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
