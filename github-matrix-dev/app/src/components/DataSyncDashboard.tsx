/**
 * Data Sync Dashboard — shows storage locations, online peers, and sync status.
 *
 * Three panels:
 * 1. Storage Locations — where data lives (IndexedDB, Matrix room, snapshots)
 * 2. Online Peers — users/devices connected to the sync room
 * 3. Sync Status — pairwise sync state between all peers
 */

import { useEffect, useState, useCallback } from 'react';
import { useSyncStore, type PeerInfo, type StorageLocation, type SyncPair } from '../store/sync-store';
import { useEoStore } from '../store/eo-store';
import type { MatrixSession } from '../matrix/client';

interface DataSyncDashboardProps {
  session: MatrixSession;
}

export function DataSyncDashboard({ session }: DataSyncDashboardProps) {
  const {
    localPeer,
    peers,
    storageLocations,
    syncPairs,
    offlineQueueSize,
    lastSnapshotSeq,
    lastSnapshotMxc,
    initialize,
    updateLocalSeq,
    upsertPeer,
    updateSyncPair,
    setLastSnapshotSeq,
  } = useSyncStore();

  const lastSeq = useEoStore((s) => s.lastSeq);
  const store = useEoStore((s) => s.store);
  const ready = useEoStore((s) => s.ready);
  const manualSnapshot = useEoStore((s) => s.manualSnapshot);

  const [snapshotInProgress, setSnapshotInProgress] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  const handleSnapshot = useCallback(async () => {
    setSnapshotInProgress(true);
    setSnapshotError(null);
    try {
      const result = await manualSnapshot();
      setLastSnapshotSeq(result.seq, result.mxc);
    } catch (err: any) {
      setSnapshotError(err.message || 'Snapshot failed');
    } finally {
      setSnapshotInProgress(false);
    }
  }, [manualSnapshot, setLastSnapshotSeq]);

  // Initialize sync store once ready
  useEffect(() => {
    if (!ready || !store) return;

    (async () => {
      const offlineQueue: any[] = (await store.get('meta:offline_queue')) || [];
      const snapshotSeq: number = (await store.get('meta:snapshot_seq')) || 0;
      const snapshotMxc: string | null = (await store.get('meta:snapshot_mxc')) || null;

      initialize({
        userId: session.userId,
        deviceId: session.deviceId,
        homeserver: session.homeserver,
        localSeq: lastSeq,
        offlineQueueSize: offlineQueue.length,
        lastSnapshotSeq: snapshotSeq,
        lastSnapshotMxc: snapshotMxc,
        syncRoomId: null,
      });
    })();
  }, [ready, store, session]);

  // Keep local seq in sync
  useEffect(() => {
    if (localPeer) {
      updateLocalSeq(lastSeq);
    }
  }, [lastSeq]);

  // Simulate peer discovery from room membership
  useEffect(() => {
    if (!ready) return;

    // In a real deployment, these would come from Matrix room presence events.
    // For now we show the local peer and simulate awareness of the Matrix room.
    const localDevice = localPeer;
    if (!localDevice) return;

    // Build sync pairs between local and Matrix room (source of truth)
    const matrixSeq = lastSeq; // Room is authoritative; local tracks it
    updateSyncPair({
      sourceId: `${localDevice.userId}:${localDevice.deviceId}`,
      targetId: 'matrix-room',
      status: offlineQueueSize > 0 ? 'behind' : 'synced',
      sourceSeq: lastSeq,
      targetSeq: matrixSeq,
      lag: offlineQueueSize > 0 ? -offlineQueueSize : 0,
      lastSync: new Date().toISOString(),
    });

    if (lastSnapshotSeq > 0) {
      updateSyncPair({
        sourceId: 'matrix-room',
        targetId: 'matrix-snapshots',
        status: lastSeq - lastSnapshotSeq > 1000 ? 'behind' : 'synced',
        sourceSeq: lastSeq,
        targetSeq: lastSnapshotSeq,
        lag: lastSnapshotSeq - lastSeq,
        lastSync: new Date().toISOString(),
      });
    }
  }, [ready, lastSeq, offlineQueueSize, lastSnapshotSeq]);

  // Poll offline queue size
  useEffect(() => {
    if (!ready || !store) return;
    const interval = setInterval(async () => {
      const queue: any[] = (await store.get('meta:offline_queue')) || [];
      useSyncStore.getState().setOfflineQueueSize(queue.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [ready, store]);

  if (!ready) {
    return (
      <div style={styles.loading}>
        <div style={styles.spinner} />
        <span>Initializing sync dashboard...</span>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Data Sync Dashboard</h2>
        <div style={styles.headerMeta}>
          <span style={styles.seqBadge}>local seq: {lastSeq}</span>
          {offlineQueueSize > 0 && (
            <span style={styles.queueBadge}>{offlineQueueSize} queued</span>
          )}
        </div>
      </div>

      {/* Storage Locations */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <StorageIcon />
          Storage Locations
        </h3>
        <p style={styles.sectionDesc}>Where your data lives across the sync network</p>
        <div style={styles.cardGrid}>
          {storageLocations.map((loc) => (
            <StorageCard key={loc.id} location={loc} />
          ))}
        </div>
      </section>

      {/* Online Peers */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <PeersIcon />
          Connected Peers
        </h3>
        <p style={styles.sectionDesc}>Users and devices in the sync room</p>
        {peers.length === 0 ? (
          <div style={styles.emptyState}>No peers detected</div>
        ) : (
          <div style={styles.peerList}>
            {peers.map((peer) => (
              <PeerCard
                key={`${peer.userId}:${peer.deviceId}`}
                peer={peer}
                isLocal={peer.userId === localPeer?.userId && peer.deviceId === localPeer?.deviceId}
              />
            ))}
          </div>
        )}
      </section>

      {/* Sync Status */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <SyncIcon />
          Sync Status
        </h3>
        <p style={styles.sectionDesc}>Replication state between all storage tiers</p>
        {syncPairs.length === 0 ? (
          <div style={styles.emptyState}>No sync relationships established</div>
        ) : (
          <div style={styles.syncList}>
            {syncPairs.map((pair) => (
              <SyncPairRow key={`${pair.sourceId}->${pair.targetId}`} pair={pair} />
            ))}
          </div>
        )}
      </section>

      {/* Delta Snapshots */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <SnapshotIcon />
          Delta Snapshots
        </h3>
        <p style={styles.sectionDesc}>
          Capture events since the last snapshot as a delta blob in Matrix media.
          Each snapshot records its mxc URI in a NUL event, forming a reconstructable chain.
        </p>
        <div style={styles.snapshotPanel}>
          <div style={styles.snapshotInfo}>
            <div style={styles.snapshotRow}>
              <span style={styles.snapshotLabel}>Last Snapshot Seq</span>
              <span style={styles.snapshotValue}>
                {lastSnapshotSeq > 0 ? lastSnapshotSeq : 'None'}
              </span>
            </div>
            <div style={styles.snapshotRow}>
              <span style={styles.snapshotLabel}>Events Since Snapshot</span>
              <span style={styles.snapshotValue}>
                {lastSeq - lastSnapshotSeq}
              </span>
            </div>
            <div style={styles.snapshotRow}>
              <span style={styles.snapshotLabel}>Latest Delta URI</span>
              <span style={{ ...styles.snapshotValue, fontSize: 10, wordBreak: 'break-all' as const }}>
                {lastSnapshotMxc || 'None'}
              </span>
            </div>
          </div>
          <div style={styles.snapshotActions}>
            <button
              onClick={handleSnapshot}
              disabled={snapshotInProgress || lastSeq === lastSnapshotSeq}
              style={{
                ...styles.snapshotButton,
                ...(snapshotInProgress || lastSeq === lastSnapshotSeq
                  ? styles.snapshotButtonDisabled
                  : {}),
              }}
            >
              {snapshotInProgress ? 'Uploading...' : 'Take Snapshot'}
            </button>
            {snapshotError && (
              <div style={styles.snapshotError}>{snapshotError}</div>
            )}
            {lastSeq === lastSnapshotSeq && !snapshotError && (
              <div style={styles.snapshotUpToDate}>Up to date</div>
            )}
          </div>
        </div>
      </section>

      {/* Architecture Diagram */}
      <section style={styles.section}>
        <h3 style={styles.sectionTitle}>
          <DiagramIcon />
          Sync Architecture
        </h3>
        <SyncDiagram
          peers={peers}
          storageLocations={storageLocations}
          syncPairs={syncPairs}
          localPeer={localPeer}
        />
      </section>
    </div>
  );
}

/* ── Sub-components ────────────────────────────────────── */

function StorageCard({ location }: { location: StorageLocation }) {
  const typeColors: Record<string, string> = {
    indexeddb: '#1a6dd4',
    'matrix-media': '#7c3aed',
    leveldb: '#c2700a',
    backup: '#16a34a',
  };

  const typeLabels: Record<string, string> = {
    indexeddb: 'IndexedDB',
    'matrix-media': 'Matrix',
    leveldb: 'LevelDB',
    backup: 'Backup',
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader}>
        <div style={{ ...styles.typeBadge, background: typeColors[location.type] || '#7a756d' }}>
          {typeLabels[location.type] || location.type}
        </div>
        {location.encrypted && <span style={styles.encBadge}>E2EE</span>}
      </div>
      <div style={styles.cardLabel}>{location.label}</div>
      <div style={styles.cardPath}>{location.path}</div>
      {location.sizeEstimate && (
        <div style={styles.cardMeta}>{location.sizeEstimate}</div>
      )}
      {location.lastWrite && (
        <div style={styles.cardMeta}>
          Last write: {formatTime(location.lastWrite)}
        </div>
      )}
    </div>
  );
}

function PeerCard({ peer, isLocal }: { peer: PeerInfo; isLocal: boolean }) {
  const statusColors: Record<string, string> = {
    online: '#16a34a',
    offline: '#d9487a',
    syncing: '#c2700a',
  };

  return (
    <div style={{ ...styles.peerCard, ...(isLocal ? styles.peerCardLocal : {}) }}>
      <div style={styles.peerHeader}>
        <div style={{ ...styles.statusDot, background: statusColors[peer.status] }} />
        <span style={styles.peerUser}>{peer.userId}</span>
        {isLocal && <span style={styles.localBadge}>this device</span>}
      </div>
      <div style={styles.peerDetails}>
        <div style={styles.peerDetail}>
          <span style={styles.peerDetailLabel}>Device</span>
          <span style={styles.peerDetailValue}>{peer.deviceId.slice(0, 10)}...</span>
        </div>
        <div style={styles.peerDetail}>
          <span style={styles.peerDetailLabel}>Seq</span>
          <span style={styles.peerDetailValue}>{peer.lastSeq}</span>
        </div>
        <div style={styles.peerDetail}>
          <span style={styles.peerDetailLabel}>Storage</span>
          <span style={styles.peerDetailValue}>{peer.storageType}</span>
        </div>
        <div style={styles.peerDetail}>
          <span style={styles.peerDetailLabel}>Last Seen</span>
          <span style={styles.peerDetailValue}>{formatTime(peer.lastSeen)}</span>
        </div>
      </div>
      <div style={styles.peerHomeserver}>
        {peer.homeserver}
      </div>
    </div>
  );
}

function SyncPairRow({ pair }: { pair: SyncPair }) {
  const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
    synced:   { color: '#16a34a', bg: '#f0faf4', label: 'Synced' },
    behind:   { color: '#c2700a', bg: '#fef6ed', label: 'Behind' },
    ahead:    { color: '#1a6dd4', bg: '#eef5fd', label: 'Ahead' },
    conflict: { color: '#d9487a', bg: '#fdf2f5', label: 'Conflict' },
    offline:  { color: '#7a756d', bg: '#f4f3f0', label: 'Offline' },
  };

  const config = statusConfig[pair.status] || statusConfig.offline;

  return (
    <div style={styles.syncRow}>
      <div style={styles.syncEndpoints}>
        <span style={styles.syncEndpoint}>{formatEndpoint(pair.sourceId)}</span>
        <span style={styles.syncArrow}>
          {pair.status === 'synced' ? '⇄' : pair.lag < 0 ? '→' : '←'}
        </span>
        <span style={styles.syncEndpoint}>{formatEndpoint(pair.targetId)}</span>
      </div>
      <div style={styles.syncMeta}>
        <div style={styles.syncSeqs}>
          <span style={styles.syncSeqLabel}>src: {pair.sourceSeq}</span>
          <span style={styles.syncSeqLabel}>dst: {pair.targetSeq}</span>
          {pair.lag !== 0 && (
            <span style={{ ...styles.syncLag, color: config.color }}>
              {pair.lag > 0 ? '+' : ''}{pair.lag}
            </span>
          )}
        </div>
        <div style={{ ...styles.syncStatusBadge, color: config.color, background: config.bg, borderColor: config.color }}>
          {config.label}
        </div>
      </div>
      {pair.lastSync && (
        <div style={styles.syncTime}>Last sync: {formatTime(pair.lastSync)}</div>
      )}
    </div>
  );
}

function SyncDiagram({
  peers,
  storageLocations,
  syncPairs,
  localPeer,
}: {
  peers: PeerInfo[];
  storageLocations: StorageLocation[];
  syncPairs: SyncPair[];
  localPeer: PeerInfo | null;
}) {
  return (
    <div style={styles.diagram}>
      <div style={styles.diagramRow}>
        {/* Tier 1: Local devices */}
        <div style={styles.diagramTier}>
          <div style={styles.tierLabel}>Tier 1 — Local Devices</div>
          <div style={styles.tierDesc}>IndexedDB (AES-GCM encrypted)</div>
          <div style={styles.tierNodes}>
            {peers.map((p) => (
              <div
                key={`${p.userId}:${p.deviceId}`}
                style={{
                  ...styles.diagramNode,
                  borderColor: p.status === 'online' ? '#16a34a' : '#d9487a',
                }}
              >
                <div style={{
                  ...styles.diagramNodeDot,
                  background: p.status === 'online' ? '#16a34a' : '#d9487a',
                }} />
                <span style={styles.diagramNodeLabel}>
                  {p.userId.split(':')[0].replace('@', '')}
                </span>
                <span style={styles.diagramNodeSeq}>seq {p.lastSeq}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Connector arrows */}
        <div style={styles.diagramConnector}>
          <div style={styles.connectorLine} />
          <div style={styles.connectorLabel}>
            E2EE Megolm
          </div>
          <div style={styles.connectorLine} />
        </div>

        {/* Tier 2: Matrix Room */}
        <div style={styles.diagramTier}>
          <div style={styles.tierLabel}>Tier 2 — Matrix Room</div>
          <div style={styles.tierDesc}>Event timeline (source of truth)</div>
          <div style={styles.tierNodes}>
            <div style={{ ...styles.diagramNode, borderColor: '#7c3aed' }}>
              <div style={{ ...styles.diagramNodeDot, background: '#7c3aed' }} />
              <span style={styles.diagramNodeLabel}>#amino-data</span>
              <span style={styles.diagramNodeSeq}>
                {syncPairs.find((p) => p.targetId === 'matrix-room')
                  ? `seq ${syncPairs.find((p) => p.targetId === 'matrix-room')!.targetSeq}`
                  : 'connected'}
              </span>
            </div>
          </div>
        </div>

        {/* Connector arrows */}
        <div style={styles.diagramConnector}>
          <div style={styles.connectorLine} />
          <div style={styles.connectorLabel}>
            msgpack snapshots
          </div>
          <div style={styles.connectorLine} />
        </div>

        {/* Tier 3: Snapshots / Backups */}
        <div style={styles.diagramTier}>
          <div style={styles.tierLabel}>Tier 3 — Snapshots</div>
          <div style={styles.tierDesc}>Matrix media store (hydration)</div>
          <div style={styles.tierNodes}>
            <div style={{ ...styles.diagramNode, borderColor: '#c2700a' }}>
              <div style={{ ...styles.diagramNodeDot, background: '#c2700a' }} />
              <span style={styles.diagramNodeLabel}>Snapshots</span>
              <span style={styles.diagramNodeSeq}>
                {localPeer && useSyncStore.getState().lastSnapshotSeq > 0
                  ? `@ seq ${useSyncStore.getState().lastSnapshotSeq}`
                  : 'none yet'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={styles.diagramLegend}>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendDot, background: '#16a34a' }} />
          <span>Online</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendDot, background: '#d9487a' }} />
          <span>Offline</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendDot, background: '#c2700a' }} />
          <span>Syncing</span>
        </div>
        <div style={styles.legendItem}>
          <div style={{ ...styles.legendDot, background: '#7c3aed' }} />
          <span>Matrix</span>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────── */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();

    if (diffMs < 60_000) return 'just now';
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

function formatEndpoint(id: string): string {
  if (id === 'matrix-room') return 'Matrix Room';
  if (id === 'matrix-snapshots') return 'Snapshots';
  // userId:deviceId format
  const parts = id.split(':');
  if (parts.length >= 2) {
    const user = parts[0].replace('@', '');
    return user;
  }
  return id;
}

/* ── Icons ─────────────────────────────────────────────── */

function StorageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
      <ellipse cx="8" cy="4" rx="6" ry="2.5" />
      <path d="M2 4v3.5c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V4" />
      <path d="M2 7.5V11c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V7.5" />
    </svg>
  );
}

function PeersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
      <circle cx="6" cy="5" r="2.5" />
      <path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
      <circle cx="11.5" cy="4.5" r="2" />
      <path d="M14.5 12.5c0-2 1.5-3 0-3c-1 0-2.5 1-2.5 3" />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
      <path d="M2 8a6 6 0 0 1 10.3-4.2" />
      <polyline points="12.5 1 12.5 4.5 9 4.5" />
      <path d="M14 8a6 6 0 0 1-10.3 4.2" />
      <polyline points="3.5 15 3.5 11.5 7 11.5" />
    </svg>
  );
}

function SnapshotIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}

function DiagramIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
      <rect x="1" y="1" width="4" height="4" rx="1" />
      <rect x="11" y="1" width="4" height="4" rx="1" />
      <rect x="6" y="11" width="4" height="4" rx="1" />
      <line x1="5" y1="3" x2="11" y2="3" />
      <line x1="3" y1="5" x2="8" y2="11" />
      <line x1="13" y1="5" x2="8" y2="11" />
    </svg>
  );
}

/* ── Styles ────────────────────────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: 32,
    maxWidth: 960,
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    color: '#1a1816',
    margin: 0,
    fontFamily: "'Source Serif 4', Georgia, serif",
  },
  headerMeta: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  },
  seqBadge: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: '#aba69e',
    padding: '3px 10px',
    borderRadius: 4,
    background: '#f4f3f0',
    border: '1px solid #e5e2dd',
  },
  queueBadge: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11,
    color: '#c2700a',
    padding: '3px 10px',
    borderRadius: 4,
    background: '#fef6ed',
    border: '1px solid #f0d9b8',
  },

  // Sections
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#1a1816',
    margin: '0 0 4px',
    display: 'flex',
    alignItems: 'center',
  },
  sectionDesc: {
    fontSize: 12,
    color: '#7a756d',
    margin: '0 0 16px',
  },

  // Storage cards
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 12,
  },
  card: {
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 16,
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  typeBadge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#fff',
    padding: '2px 8px',
    borderRadius: 4,
    fontFamily: "'JetBrains Mono', monospace",
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
  },
  encBadge: {
    fontSize: 9,
    fontWeight: 600,
    color: '#16a34a',
    padding: '2px 6px',
    borderRadius: 3,
    background: '#f0faf4',
    border: '1px solid #b8e4ca',
    fontFamily: "'JetBrains Mono', monospace",
  },
  cardLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: '#1a1816',
    marginBottom: 4,
  },
  cardPath: {
    fontSize: 11,
    color: '#7a756d',
    fontFamily: "'JetBrains Mono', monospace",
    wordBreak: 'break-all' as const,
    marginBottom: 8,
  },
  cardMeta: {
    fontSize: 11,
    color: '#aba69e',
    marginTop: 4,
  },

  // Peer list
  peerList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  peerCard: {
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 14,
  },
  peerCardLocal: {
    borderColor: '#1a6dd4',
    borderWidth: 2,
  },
  peerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  peerUser: {
    fontSize: 13,
    fontWeight: 600,
    color: '#1a1816',
    fontFamily: "'JetBrains Mono', monospace",
  },
  localBadge: {
    fontSize: 9,
    fontWeight: 600,
    color: '#1a6dd4',
    padding: '1px 6px',
    borderRadius: 3,
    background: '#eef5fd',
    border: '1px solid #c4d9f2',
    fontFamily: "'JetBrains Mono', monospace",
  },
  peerDetails: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
    gap: 8,
  },
  peerDetail: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  peerDetailLabel: {
    fontSize: 10,
    color: '#aba69e',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    fontFamily: "'JetBrains Mono', monospace",
  },
  peerDetailValue: {
    fontSize: 12,
    color: '#2c2a26',
    fontFamily: "'JetBrains Mono', monospace",
  },
  peerHomeserver: {
    marginTop: 8,
    fontSize: 10,
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
  },

  // Sync pairs
  syncList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  syncRow: {
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 14,
  },
  syncEndpoints: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  syncEndpoint: {
    fontSize: 12,
    fontWeight: 600,
    color: '#1a1816',
    fontFamily: "'JetBrains Mono', monospace",
  },
  syncArrow: {
    fontSize: 14,
    color: '#7a756d',
  },
  syncMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  syncSeqs: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
  },
  syncSeqLabel: {
    fontSize: 11,
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
  },
  syncLag: {
    fontSize: 11,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
  },
  syncStatusBadge: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 10px',
    borderRadius: 12,
    border: '1px solid',
    fontFamily: "'JetBrains Mono', monospace",
  },
  syncTime: {
    fontSize: 10,
    color: '#aba69e',
    marginTop: 6,
  },

  // Diagram
  diagram: {
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 24,
  },
  diagramRow: {
    display: 'flex',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 0,
  },
  diagramTier: {
    flex: 1,
    textAlign: 'center' as const,
    padding: '12px 8px',
  },
  tierLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#1a1816',
    marginBottom: 2,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    fontFamily: "'JetBrains Mono', monospace",
  },
  tierDesc: {
    fontSize: 10,
    color: '#aba69e',
    marginBottom: 12,
  },
  tierNodes: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  diagramNode: {
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '10px 16px',
    border: '2px solid',
    borderRadius: 8,
    background: '#faf9f7',
    minWidth: 100,
  },
  diagramNodeDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  diagramNodeLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#1a1816',
    fontFamily: "'JetBrains Mono', monospace",
  },
  diagramNodeSeq: {
    fontSize: 9,
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
  },
  diagramConnector: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: 80,
    gap: 4,
  },
  connectorLine: {
    width: '100%',
    height: 2,
    background: '#e5e2dd',
  },
  connectorLabel: {
    fontSize: 8,
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
    whiteSpace: 'nowrap' as const,
  },
  diagramLegend: {
    display: 'flex',
    justifyContent: 'center',
    gap: 20,
    marginTop: 20,
    paddingTop: 16,
    borderTop: '1px solid #e5e2dd',
  },
  legendItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    color: '#7a756d',
    fontFamily: "'JetBrains Mono', monospace",
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
  },

  // Snapshot panel
  snapshotPanel: {
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 20,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 24,
  },
  snapshotInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  snapshotRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 16,
  },
  snapshotLabel: {
    fontSize: 12,
    color: '#7a756d',
    fontFamily: "'JetBrains Mono', monospace",
  },
  snapshotValue: {
    fontSize: 12,
    fontWeight: 600,
    color: '#1a1816',
    fontFamily: "'JetBrains Mono', monospace",
  },
  snapshotActions: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-end',
    gap: 8,
    flexShrink: 0,
  },
  snapshotButton: {
    padding: '8px 20px',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: "'JetBrains Mono', monospace",
    color: '#fff',
    background: '#7c3aed',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  snapshotButtonDisabled: {
    background: '#c4b8d9',
    cursor: 'not-allowed',
  },
  snapshotError: {
    fontSize: 11,
    color: '#d9487a',
    fontFamily: "'JetBrains Mono', monospace",
  },
  snapshotUpToDate: {
    fontSize: 11,
    color: '#16a34a',
    fontFamily: "'JetBrains Mono', monospace",
  },

  // Empty states
  emptyState: {
    padding: 24,
    textAlign: 'center' as const,
    fontSize: 13,
    color: '#aba69e',
    background: '#fff',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
  },
  loading: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 16,
    fontSize: 13,
    color: '#7a756d',
  },
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #e5e2dd',
    borderTopColor: '#1a6dd4',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
};
