import { useState, useEffect } from 'react';
import { logout, type MatrixSession } from '../matrix/client';
import { useEoStore } from '../store/eo-store';
import { createIdb } from '../db/idb';
import { createStore } from '../db/encrypted-store';
import { deriveKey } from '../lib/crypto';
import { HolonNav } from './HolonNav';
import { TableView } from './TableView';
import { RecordDetailDrawer } from './RecordDetailDrawer';
import { ConnectionStatus, useConnectionState } from './ConnectionStatus';
import { ErrorBoundary } from './ErrorBoundary';
import { SyncProgress } from './SyncProgress';
import { AirtableSettings } from './AirtableSettings';

interface LayoutProps {
  session: MatrixSession;
  onLogout: () => void;
}

export function Layout({ session, onLogout }: LayoutProps) {
  const init = useEoStore((s) => s.init);
  const teardown = useEoStore((s) => s.teardown);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [selectedScope, setSelectedScope] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const connectionState = useConnectionState();

  // Initialize encrypted store on mount
  useEffect(() => {
    let mounted = true;

    async function setup() {
      const idb = await createIdb();
      const key = await deriveKey(session.userId, session.deviceId, session.accessToken);
      const store = createStore(idb, key);
      if (mounted) {
        await init(store);
      }
    }

    setup();

    return () => {
      mounted = false;
    };
  }, [session, init]);

  function handleLogout() {
    teardown();
    logout();
    onLogout();
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <span style={styles.logo}>Amino Immigration</span>
          <div style={styles.divider} />
          <span style={styles.section}>Case Management</span>
        </div>
        <div style={styles.headerRight}>
          <ConnectionStatus state={connectionState} />
          <div style={styles.seqBadge}>seq: {lastSeq}</div>
          <button
            onClick={() => setShowSettings(true)}
            style={styles.settingsBtn}
            title="Airtable Settings"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="2.5" />
              <path d="M8 1.5v1.2M8 13.3v1.2M3.4 3.4l.85.85M11.75 11.75l.85.85M1.5 8h1.2M13.3 8h1.2M3.4 12.6l.85-.85M11.75 4.25l.85-.85" />
            </svg>
          </button>
          <span style={styles.user}>{session.userId}</span>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      <div style={styles.body}>
        <aside style={styles.sidebar}>
          {ready ? (
            <HolonNav
              selectedScope={selectedScope}
              onSelectScope={(scope) => { setSelectedScope(scope); setSelectedRecord(null); }}
              onSelectSegment={(_scope, _seg) => { setSelectedScope(_scope); }}
            />
          ) : (
            <SyncProgress message="Initializing store..." detail="Deriving encryption key" />
          )}
        </aside>
        <main style={styles.main}>
          <ErrorBoundary>
            {selectedScope ? (
              <TableView
                scope={selectedScope}
                onSelectRecord={setSelectedRecord}
                activeRecord={selectedRecord}
                session={{ userId: session.userId }}
              />
            ) : (
              <div style={styles.empty}>
                <div style={styles.emptyText}>Select an object type to view its records</div>
                <div style={styles.emptySub}>
                  Choose from the hierarchy on the left to see records as a table
                </div>
              </div>
            )}
          </ErrorBoundary>
        </main>
        {selectedRecord && (
          <RecordDetailDrawer
            target={selectedRecord}
            onClose={() => setSelectedRecord(null)}
            onNavigate={(t) => setSelectedRecord(t)}
          />
        )}
      </div>
      {showSettings && (
        <AirtableSettings session={session} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    background: '#faf9f7',
    color: '#2c2a26',
    fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0 24px',
    height: 52,
    background: '#fff',
    borderBottom: '1px solid #e5e2dd',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  logo: {
    fontFamily: "'Source Serif 4', Georgia, serif",
    fontSize: 17,
    fontWeight: 600,
    color: '#1a1816',
  },
  divider: { width: 1, height: 20, background: '#d4d0ca' },
  section: { fontSize: 13, color: '#7a756d', fontWeight: 400 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 16 },
  seqBadge: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10,
    color: '#aba69e',
    padding: '2px 8px',
    borderRadius: 4,
    background: '#f4f3f0',
    border: '1px solid #e5e2dd',
  },
  settingsBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: 'transparent',
    color: '#7a756d',
    cursor: 'pointer',
  },
  user: { fontSize: 12, color: '#7a756d' },
  logoutBtn: {
    padding: '6px 14px',
    fontSize: 12,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: 'transparent',
    color: '#7a756d',
    cursor: 'pointer',
  },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: {
    width: 280,
    borderRight: '1px solid #e5e2dd',
    background: '#fff',
  },
  main: { flex: 1, overflowY: 'auto', background: '#faf9f7' },
  loading: { padding: 18, fontSize: 13, color: '#aba69e' },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 8,
  },
  emptyText: { fontSize: 14, color: '#7a756d', fontWeight: 300 },
  emptySub: { fontSize: 12, color: '#aba69e' },
};
