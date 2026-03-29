/**
 * Settings page — full-view settings with sectioned navigation.
 *
 * Sections:
 *   - Session — current user info, device ID, homeserver
 *   - Airtable Integration — API key management and sync triggers
 *   - Snapshots — snapshot configuration and manual trigger
 *   - Storage — IndexedDB usage and data management
 */

import { useState, useEffect } from 'react';
import { useEoStore } from '../store/eo-store';
import { AirtableSettingsSection } from './AirtableSettings';
import type { MatrixSession } from '../matrix/client';

interface SettingsPageProps {
  session: MatrixSession;
}

type SettingsSection = 'session' | 'airtable' | 'snapshots' | 'storage';

const SECTIONS: { key: SettingsSection; label: string; icon: string }[] = [
  { key: 'session', label: 'Session', icon: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 14s-1 0-1-1 1-4 7-4 7 3 7 4c0 1-1 1-1 1H2Z' },
  { key: 'airtable', label: 'Airtable Integration', icon: 'M4 1h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Zm1 3v2h6V4H5Zm0 3v2h3V7H5Zm0 3v2h6v-2H5Z' },
  { key: 'snapshots', label: 'Snapshots', icon: 'M8 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1A.5.5 0 0 1 8 1Zm0 11a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-1 0v-1A.5.5 0 0 1 8 12Zm7-4a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h1a.5.5 0 0 1 .5.5ZM3 8a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h1A.5.5 0 0 1 3 8Zm5-5a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z' },
  { key: 'storage', label: 'Storage', icon: 'M1 3.5A1.5 1.5 0 0 1 2.5 2h11A1.5 1.5 0 0 1 15 3.5v2A1.5 1.5 0 0 1 13.5 7h-11A1.5 1.5 0 0 1 1 5.5v-2Zm0 7A1.5 1.5 0 0 1 2.5 9h11a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-2ZM12 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm0 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z' },
];

export function SettingsPage({ session }: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>('airtable');

  return (
    <div style={styles.container}>
      {/* Left nav */}
      <nav style={styles.nav}>
        <div style={styles.navTitle}>Settings</div>
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            onClick={() => setActiveSection(s.key)}
            style={{
              ...styles.navItem,
              ...(activeSection === s.key ? styles.navItemActive : {}),
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }}>
              <path d={s.icon} />
            </svg>
            {s.label}
          </button>
        ))}
      </nav>

      {/* Content area */}
      <div style={styles.content}>
        {activeSection === 'session' && <SessionSection session={session} />}
        {activeSection === 'airtable' && <AirtableSection session={session} />}
        {activeSection === 'snapshots' && <SnapshotSection session={session} />}
        {activeSection === 'storage' && <StorageSection />}
      </div>
    </div>
  );
}

// ─── Session Section ───────────────────────────────────────────────────────

function SessionSection({ session }: { session: MatrixSession }) {
  return (
    <div>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Session</h2>
        <p style={styles.sectionSubtitle}>Current user and device information</p>
      </div>

      <div style={styles.card}>
        <div style={styles.fieldGroup}>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>User ID</span>
            <span style={styles.fieldValue}>{session.userId}</span>
          </div>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Device ID</span>
            <span style={styles.fieldValueMono}>{session.deviceId}</span>
          </div>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Homeserver</span>
            <span style={styles.fieldValueMono}>{session.homeserver}</span>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Encryption</div>
        <p style={styles.cardDescription}>
          All local data is encrypted with AES-GCM. The encryption key is derived
          from your session credentials via PBKDF2 and held in memory only.
        </p>
        <div style={styles.fieldGroup}>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Status</span>
            <span style={{ ...styles.badge, background: '#dcfce7', color: '#166534' }}>
              Active
            </span>
          </div>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Algorithm</span>
            <span style={styles.fieldValueMono}>AES-256-GCM + PBKDF2</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Airtable Section ──────────────────────────────────────────────────────

function AirtableSection({ session }: { session: MatrixSession }) {
  return (
    <div>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Airtable Integration</h2>
        <p style={styles.sectionSubtitle}>Connect and sync data from Airtable bases</p>
      </div>
      <AirtableSettingsSection session={session} />
    </div>
  );
}

// ─── Snapshot Section ──────────────────────────────────────────────────────

function SnapshotSection({ session }: { session: MatrixSession }) {
  const store = useEoStore((s) => s.store);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const syncManager = useEoStore((s) => s.syncManager);
  const [lastSnapshotSeq, setLastSnapshotSeq] = useState<number | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [snapshotMessage, setSnapshotMessage] = useState('');

  useEffect(() => {
    if (!store) return;
    (async () => {
      const seq = await store.get('meta:snapshot_seq');
      setLastSnapshotSeq(seq ?? null);
    })();
  }, [store, snapshotStatus]);

  async function handleCreateSnapshot() {
    if (!syncManager) {
      setSnapshotStatus('error');
      setSnapshotMessage('Sync manager not available');
      return;
    }
    setSnapshotStatus('saving');
    setSnapshotMessage('Creating snapshot...');
    try {
      await syncManager.saveSnapshot();
      setSnapshotStatus('done');
      setSnapshotMessage('Snapshot saved to Matrix media');
    } catch (e: any) {
      setSnapshotStatus('error');
      setSnapshotMessage(e.message || 'Snapshot failed');
    }
  }

  const unsnapshotted = lastSnapshotSeq != null ? lastSeq - lastSnapshotSeq : lastSeq;

  return (
    <div>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Snapshots</h2>
        <p style={styles.sectionSubtitle}>
          Binary state snapshots stored in Matrix media for fast device bootstrap
        </p>
      </div>

      <div style={styles.card}>
        <div style={styles.fieldGroup}>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Current Sequence</span>
            <span style={styles.fieldValueMono}>{lastSeq}</span>
          </div>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Last Snapshot At</span>
            <span style={styles.fieldValueMono}>
              {lastSnapshotSeq != null ? `seq ${lastSnapshotSeq}` : 'None'}
            </span>
          </div>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Unsnapshotted Events</span>
            <span style={{
              ...styles.fieldValueMono,
              color: unsnapshotted > 1000 ? '#dc3545' : unsnapshotted > 100 ? '#f59e0b' : '#166534',
            }}>
              {unsnapshotted}
            </span>
          </div>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Manual Snapshot</div>
        <p style={styles.cardDescription}>
          Create a snapshot of the current database state and upload it to Matrix media.
          New devices can hydrate from this snapshot instead of replaying the full event history.
        </p>
        <button
          onClick={handleCreateSnapshot}
          disabled={snapshotStatus === 'saving'}
          style={{
            ...styles.primaryBtn,
            opacity: snapshotStatus === 'saving' ? 0.5 : 1,
          }}
        >
          {snapshotStatus === 'saving' ? 'Saving...' : 'Create Snapshot'}
        </button>
        {snapshotMessage && (
          <div style={{
            marginTop: 10,
            fontSize: 12,
            color: snapshotStatus === 'error' ? '#dc3545' : snapshotStatus === 'done' ? '#28a745' : '#7a756d',
          }}>
            {snapshotMessage}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Storage Section ───────────────────────────────────────────────────────

function StorageSection() {
  const store = useEoStore((s) => s.store);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const ready = useEoStore((s) => s.ready);
  const [storageEstimate, setStorageEstimate] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      navigator.storage.estimate().then((est) => {
        setStorageEstimate({
          usage: est.usage ?? 0,
          quota: est.quota ?? 0,
        });
      });
    }
  }, [ready]);

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  const usagePct = storageEstimate
    ? ((storageEstimate.usage / storageEstimate.quota) * 100).toFixed(1)
    : null;

  return (
    <div>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Storage</h2>
        <p style={styles.sectionSubtitle}>IndexedDB usage and data management</p>
      </div>

      <div style={styles.card}>
        <div style={styles.fieldGroup}>
          <div style={styles.field}>
            <span style={styles.fieldLabel}>Total Events</span>
            <span style={styles.fieldValueMono}>{lastSeq}</span>
          </div>
          {storageEstimate && (
            <>
              <div style={styles.field}>
                <span style={styles.fieldLabel}>Storage Used</span>
                <span style={styles.fieldValueMono}>{formatBytes(storageEstimate.usage)}</span>
              </div>
              <div style={styles.field}>
                <span style={styles.fieldLabel}>Storage Quota</span>
                <span style={styles.fieldValueMono}>{formatBytes(storageEstimate.quota)}</span>
              </div>
              <div style={styles.field}>
                <span style={styles.fieldLabel}>Usage</span>
                <div style={styles.progressBarContainer}>
                  <div style={{
                    ...styles.progressBarFill,
                    width: `${Math.min(parseFloat(usagePct!), 100)}%`,
                    background: parseFloat(usagePct!) > 80 ? '#dc3545' : parseFloat(usagePct!) > 50 ? '#f59e0b' : '#2563eb',
                  }} />
                </div>
                <span style={styles.fieldValueMono}>{usagePct}%</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>Data Stores</div>
        <p style={styles.cardDescription}>
          Data is stored across six encrypted IndexedDB object stores: log, state,
          graph_fwd, graph_rev, eva, and meta.
        </p>
        <div style={styles.storeList}>
          {['log', 'state', 'graph_fwd', 'graph_rev', 'eva', 'meta'].map((name) => (
            <div key={name} style={styles.storeItem}>
              <span style={styles.storeName}>{name}</span>
              <span style={{ ...styles.badge, background: '#dbeafe', color: '#1d4ed8' }}>
                AES-GCM
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    height: '100%',
    background: '#faf9f7',
    fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
  },

  // Left nav
  nav: {
    width: 220,
    borderRight: '1px solid #e5e2dd',
    background: '#fff',
    padding: '20px 0',
    flexShrink: 0,
  },
  navTitle: {
    fontFamily: "'Source Serif 4', Georgia, serif",
    fontSize: 15,
    fontWeight: 600,
    color: '#1a1816',
    padding: '0 20px 16px',
    borderBottom: '1px solid #f0eeeb',
    marginBottom: 8,
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '9px 20px',
    border: 'none',
    background: 'transparent',
    color: '#7a756d',
    fontSize: 13,
    fontWeight: 400,
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
  },
  navItemActive: {
    background: '#f0eeeb',
    color: '#1a1816',
    fontWeight: 500,
  },

  // Content area
  content: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '28px 36px',
    maxWidth: 720,
  },

  // Section headers
  sectionHeader: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontFamily: "'Source Serif 4', Georgia, serif",
    fontSize: 20,
    fontWeight: 600,
    color: '#1a1816',
    margin: 0,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: '#7a756d',
    marginTop: 4,
  },

  // Cards
  card: {
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 20,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: '#1a1816',
    marginBottom: 6,
  },
  cardDescription: {
    fontSize: 12,
    color: '#7a756d',
    lineHeight: 1.5,
    marginBottom: 14,
    marginTop: 0,
  },

  // Fields
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 12,
  },
  field: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  fieldLabel: {
    fontSize: 12,
    color: '#7a756d',
    fontWeight: 500,
  },
  fieldValue: {
    fontSize: 13,
    color: '#1a1816',
  },
  fieldValueMono: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: '#1a1816',
  },

  // Badge
  badge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
  },

  // Progress bar
  progressBarContainer: {
    flex: 1,
    height: 6,
    background: '#f0eeeb',
    borderRadius: 3,
    overflow: 'hidden' as const,
    margin: '0 8px',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },

  // Store list
  storeList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 6,
  },
  storeItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '8px 12px',
    background: '#faf9f7',
    borderRadius: 6,
    border: '1px solid #f0eeeb',
  },
  storeName: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: '#2c2a26',
  },

  // Buttons
  primaryBtn: {
    padding: '10px 20px',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    borderRadius: 6,
    background: '#2563eb',
    color: '#fff',
    cursor: 'pointer',
    fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
  },
};
