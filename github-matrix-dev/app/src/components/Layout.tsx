import { logout, type MatrixSession } from '../matrix/client';

interface LayoutProps {
  session: MatrixSession;
  onLogout: () => void;
}

export function Layout({ session, onLogout }: LayoutProps) {
  function handleLogout() {
    logout();
    onLogout();
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <span style={styles.logo}>EO///DB</span>
        <div style={styles.headerRight}>
          <span style={styles.user}>{session.userId}</span>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      <div style={styles.body}>
        <aside style={styles.sidebar}>
          <p style={styles.sidebarText}>Records will appear here</p>
        </aside>
        <main style={styles.main}>
          <p style={styles.placeholder}>Select a record to view its Horizon</p>
        </main>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#0a0a0a',
    color: '#ddd',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 24px',
    borderBottom: '1px solid #222',
    background: '#111',
  },
  logo: {
    fontSize: 18,
    fontWeight: 700,
    color: '#fff',
    letterSpacing: '0.02em',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  user: {
    fontSize: 13,
    color: '#888',
  },
  logoutBtn: {
    padding: '6px 14px',
    fontSize: 13,
    border: '1px solid #333',
    borderRadius: 6,
    background: 'transparent',
    color: '#aaa',
    cursor: 'pointer',
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: 280,
    borderRight: '1px solid #222',
    padding: 16,
    overflowY: 'auto',
  },
  sidebarText: {
    fontSize: 13,
    color: '#555',
  },
  main: {
    flex: 1,
    padding: 32,
    overflowY: 'auto',
  },
  placeholder: {
    fontSize: 15,
    color: '#555',
    textAlign: 'center',
    marginTop: 120,
  },
};
