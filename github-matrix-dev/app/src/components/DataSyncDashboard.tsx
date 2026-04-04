/**
 * Data Sync Dashboard — shows storage locations, online peers, and sync status.
 *
 * Three panels:
 * 1. Storage Locations — where data lives (IndexedDB, Matrix room, snapshots)
 * 2. Online Peers — users/devices connected to the sync room
 * 3. Sync Status — pairwise sync state between all peers
 */

import { useEffect, useState, useCallback } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useSyncStore, type PeerInfo, type StorageLocation, type SyncPair } from '../store/sync-store';
import { useEoStore } from '../store/eo-store';
import type { MatrixSession } from '../matrix/client';
import { useTheme, type Theme } from '../theme';
import { readBackupHealth, type BackupHealth, type UserBackupStatus } from '../filen/backup-monitor';
import { useFilenStore } from '../filen/filen-store';

interface DataSyncDashboardProps {
  session: MatrixSession;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
  spaceId?: string | null;
}

export function DataSyncDashboard({ session, matrixClient, roomId, spaceId }: DataSyncDashboardProps) {
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
  const { theme } = useTheme();
  const s = makeStyles(theme);

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

    const localDevice = localPeer;
    if (!localDevice) return;

    const matrixSeq = lastSeq;
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
        status: lastSeq - lastSnapshotSeq > 500 ? 'behind' : 'synced',
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
      <div style={s.loading}>
        <div style={s.spinner} />
        <span>Initializing sync dashboard...</span>
      </div>
    );
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <h2 style={s.title}>Data Sync Dashboard</h2>
        <div style={s.headerMeta}>
          <span style={s.seqBadge}>local seq: {lastSeq}</span>
          {offlineQueueSize > 0 && (
            <span style={s.queueBadge}>{offlineQueueSize} queued</span>
          )}
        </div>
      </div>

      {/* Storage Locations */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>
          <StorageIcon />
          Storage Locations
        </h3>
        <p style={s.sectionDesc}>Where your data lives across the sync network</p>
        <div style={s.cardGrid}>
          {storageLocations.map((loc) => (
            <StorageCard key={loc.id} location={loc} />
          ))}
        </div>
      </section>

      {/* Online Peers */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>
          <PeersIcon />
          Connected Peers
        </h3>
        <p style={s.sectionDesc}>Users and devices in the sync room</p>
        {peers.length === 0 ? (
          <div style={s.emptyState}>No peers detected</div>
        ) : (
          <div style={s.peerList}>
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
      <section style={s.section}>
        <h3 style={s.sectionTitle}>
          <SyncIcon />
          Sync Status
        </h3>
        <p style={s.sectionDesc}>Replication state between all storage tiers</p>
        {syncPairs.length === 0 ? (
          <div style={s.emptyState}>No sync relationships established</div>
        ) : (
          <div style={s.syncList}>
            {syncPairs.map((pair) => (
              <SyncPairRow key={`${pair.sourceId}->${pair.targetId}`} pair={pair} />
            ))}
          </div>
        )}
      </section>

      {/* Cloud Storage (Filen) — shown when org-mode is active */}
      {matrixClient && roomId && spaceId && (
        <CloudStoragePanel
          matrixClient={matrixClient}
          roomId={roomId}
          spaceId={spaceId}
        />
      )}

      {/* Delta Snapshots */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>
          <SnapshotIcon />
          Delta Snapshots
        </h3>
        <p style={s.sectionDesc}>
          Capture events since the last snapshot as a delta blob in Matrix media.
          Each snapshot records its mxc URI in a NUL event, forming a reconstructable chain.
        </p>
        <div style={s.snapshotPanel}>
          <div style={s.snapshotInfo}>
            <div style={s.snapshotRow}>
              <span style={s.snapshotLabel}>Last Snapshot Seq</span>
              <span style={s.snapshotValue}>
                {lastSnapshotSeq > 0 ? lastSnapshotSeq : 'None'}
              </span>
            </div>
            <div style={s.snapshotRow}>
              <span style={s.snapshotLabel}>Events Since Snapshot</span>
              <span style={s.snapshotValue}>
                {lastSeq - lastSnapshotSeq}
              </span>
            </div>
            <div style={s.snapshotRow}>
              <span style={s.snapshotLabel}>Latest Delta URI</span>
              <span style={{ ...s.snapshotValue, fontSize: 10, wordBreak: 'break-all' as const }}>
                {lastSnapshotMxc || 'None'}
              </span>
            </div>
          </div>
          <div style={s.snapshotActions}>
            <button
              onClick={handleSnapshot}
              disabled={snapshotInProgress || lastSeq === lastSnapshotSeq}
              style={{
                ...s.snapshotButton,
                ...(snapshotInProgress || lastSeq === lastSnapshotSeq
                  ? s.snapshotButtonDisabled
                  : {}),
              }}
            >
              {snapshotInProgress ? 'Uploading...' : 'Take Snapshot'}
            </button>
            {snapshotError && (
              <div style={s.snapshotError}>{snapshotError}</div>
            )}
            {lastSeq === lastSnapshotSeq && !snapshotError && (
              <div style={s.snapshotUpToDate}>Up to date</div>
            )}
          </div>
        </div>
      </section>

      {/* Architecture Diagram */}
      <section style={s.section}>
        <h3 style={s.sectionTitle}>
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

/* ── Cloud Storage Panel ──────────────────────────────── */

function CloudStoragePanel({
  matrixClient,
  roomId,
  spaceId,
}: {
  matrixClient: MatrixClient;
  roomId: string;
  spaceId: string;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [health, setHealth] = useState<BackupHealth | null>(null);
  const isOrgMode = useFilenStore((st) => st.isOrgMode);

  useEffect(() => {
    const update = () => {
      const h = readBackupHealth(matrixClient, roomId, spaceId);
      setHealth(h);
    };
    update();
    const interval = setInterval(update, 10_000); // refresh every 10s
    return () => clearInterval(interval);
  }, [matrixClient, roomId, spaceId]);

  if (!health || (!health.orgMode && !isOrgMode)) return null;

  const statusColors: Record<string, string> = {
    active: theme.success,
    stale: theme.warning,
    offline: theme.textMuted,
  };

  return (
    <section style={s.section}>
      <h3 style={s.sectionTitle}>
        <CloudIcon />
        Cloud Storage (Filen)
      </h3>
      <p style={s.sectionDesc}>Shared data store — all users read/write via Filen</p>

      {/* Head + Horizon summary */}
      <div style={{
        ...s.snapshotPanel,
        flexDirection: 'column' as const,
        gap: 12,
        marginBottom: 16,
      }}>
        <div style={s.snapshotRow}>
          <span style={s.snapshotLabel}>Head Seq</span>
          <span style={s.snapshotValue}>{health.headSeq || 'None'}</span>
        </div>
        {health.headUpdatedAt && (
          <div style={s.snapshotRow}>
            <span style={s.snapshotLabel}>Last Update</span>
            <span style={s.snapshotValue}>
              {formatTime(health.headUpdatedAt)} by {health.headUpdatedBy}
            </span>
          </div>
        )}
        <div style={s.snapshotRow}>
          <span style={s.snapshotLabel}>Snapshot (Horizon)</span>
          <span style={s.snapshotValue}>
            {health.horizonSeq > 0
              ? `seq ${health.horizonSeq} (${formatTime(health.horizonCompactedAt)})`
              : 'None'}
          </span>
        </div>
      </div>

      {/* Per-user status table */}
      {health.perUserStatus.length > 0 ? (
        <div style={{
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          overflow: 'hidden',
        }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
          }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.textMuted, fontWeight: 500, fontSize: 10 }}>User</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.textMuted, fontWeight: 500, fontSize: 10 }}>Status</th>
                <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.textMuted, fontWeight: 500, fontSize: 10 }}>Last Upload</th>
                <th style={{ textAlign: 'right', padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.textMuted, fontWeight: 500, fontSize: 10 }}>Seq</th>
              </tr>
            </thead>
            <tbody>
              {health.perUserStatus.map((user) => (
                <tr key={user.userId}>
                  <td style={{ padding: '6px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.textHeading }}>
                    {user.userId.split(':')[0].replace('@', '')}
                  </td>
                  <td style={{ padding: '6px 12px', borderBottom: `1px solid ${theme.border}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: statusColors[user.status] || theme.textMuted,
                      }} />
                      <span style={{ color: statusColors[user.status] || theme.textMuted }}>
                        {user.status}
                      </span>
                    </div>
                  </td>
                  <td style={{ padding: '6px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.textSecondary }}>
                    {formatTime(user.lastUploadAt)}
                  </td>
                  <td style={{ padding: '6px 12px', borderBottom: `1px solid ${theme.border}`, color: theme.text, textAlign: 'right' }}>
                    {user.lastSeq.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={s.emptyState}>No backup signals received yet</div>
      )}
    </section>
  );
}

function CloudIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}>
      <path d="M4 12a3.5 3.5 0 0 1-.5-6.95 5 5 0 0 1 9.53 1.35A3 3 0 0 1 12 12H4z" />
    </svg>
  );
}

/* ── Sub-components ────────────────────────────────────── */

function StorageCard({ location }: { location: StorageLocation }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const typeColors: Record<string, string> = {
    indexeddb: theme.accent,
    'matrix-media': theme.purple,
    leveldb: theme.warning,
    backup: theme.success,
  };

  const typeLabels: Record<string, string> = {
    indexeddb: 'IndexedDB',
    'matrix-media': 'Matrix',
    leveldb: 'LevelDB',
    backup: 'Backup',
  };

  return (
    <div style={s.card}>
      <div style={s.cardHeader}>
        <div style={{ ...s.typeBadge, background: typeColors[location.type] || theme.textSecondary }}>
          {typeLabels[location.type] || location.type}
        </div>
        {location.encrypted && <span style={s.encBadge}>E2EE</span>}
      </div>
      <div style={s.cardLabel}>{location.label}</div>
      <div style={s.cardPath}>{location.path}</div>
      {location.sizeEstimate && (
        <div style={s.cardMeta}>{location.sizeEstimate}</div>
      )}
      {location.lastWrite && (
        <div style={s.cardMeta}>
          Last write: {formatTime(location.lastWrite)}
        </div>
      )}
    </div>
  );
}

function PeerCard({ peer, isLocal }: { peer: PeerInfo; isLocal: boolean }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const statusColors: Record<string, string> = {
    online: theme.success,
    offline: theme.danger,
    syncing: theme.warning,
  };

  return (
    <div style={{ ...s.peerCard, ...(isLocal ? s.peerCardLocal : {}) }}>
      <div style={s.peerHeader}>
        <div style={{ ...s.statusDot, background: statusColors[peer.status] }} />
        <span style={s.peerUser}>{peer.userId}</span>
        {isLocal && <span style={s.localBadge}>this device</span>}
      </div>
      <div style={s.peerDetails}>
        <div style={s.peerDetail}>
          <span style={s.peerDetailLabel}>Device</span>
          <span style={s.peerDetailValue}>{peer.deviceId.slice(0, 10)}...</span>
        </div>
        <div style={s.peerDetail}>
          <span style={s.peerDetailLabel}>Seq</span>
          <span style={s.peerDetailValue}>{peer.lastSeq}</span>
        </div>
        <div style={s.peerDetail}>
          <span style={s.peerDetailLabel}>Storage</span>
          <span style={s.peerDetailValue}>{peer.storageType}</span>
        </div>
        <div style={s.peerDetail}>
          <span style={s.peerDetailLabel}>Last Seen</span>
          <span style={s.peerDetailValue}>{formatTime(peer.lastSeen)}</span>
        </div>
      </div>
      <div style={s.peerHomeserver}>
        {peer.homeserver}
      </div>
    </div>
  );
}

function SyncPairRow({ pair }: { pair: SyncPair }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
    synced:   { color: theme.success, bg: theme.successBg, label: 'Synced' },
    behind:   { color: theme.warning, bg: theme.warningBg, label: 'Behind' },
    ahead:    { color: theme.accent, bg: theme.accentBg, label: 'Ahead' },
    conflict: { color: theme.danger, bg: theme.dangerBg, label: 'Conflict' },
    offline:  { color: theme.textSecondary, bg: theme.bgMuted, label: 'Offline' },
  };

  const config = statusConfig[pair.status] || statusConfig.offline;

  return (
    <div style={s.syncRow}>
      <div style={s.syncEndpoints}>
        <span style={s.syncEndpoint}>{formatEndpoint(pair.sourceId)}</span>
        <span style={s.syncArrow}>
          {pair.status === 'synced' ? '\u21c4' : pair.lag < 0 ? '\u2192' : '\u2190'}
        </span>
        <span style={s.syncEndpoint}>{formatEndpoint(pair.targetId)}</span>
      </div>
      <div style={s.syncMeta}>
        <div style={s.syncSeqs}>
          <span style={s.syncSeqLabel}>src: {pair.sourceSeq}</span>
          <span style={s.syncSeqLabel}>dst: {pair.targetSeq}</span>
          {pair.lag !== 0 && (
            <span style={{ ...s.syncLag, color: config.color }}>
              {pair.lag > 0 ? '+' : ''}{pair.lag}
            </span>
          )}
        </div>
        <div style={{ ...s.syncStatusBadge, color: config.color, background: config.bg, borderColor: config.color }}>
          {config.label}
        </div>
      </div>
      {pair.lastSync && (
        <div style={s.syncTime}>Last sync: {formatTime(pair.lastSync)}</div>
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
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.diagram}>
      <div style={s.diagramRow}>
        {/* Tier 1: Local devices */}
        <div style={s.diagramTier}>
          <div style={s.tierLabel}>Tier 1 — Local Devices</div>
          <div style={s.tierDesc}>IndexedDB (AES-GCM encrypted)</div>
          <div style={s.tierNodes}>
            {peers.map((p) => (
              <div
                key={`${p.userId}:${p.deviceId}`}
                style={{
                  ...s.diagramNode,
                  borderColor: p.status === 'online' ? theme.success : theme.danger,
                }}
              >
                <div style={{
                  ...s.diagramNodeDot,
                  background: p.status === 'online' ? theme.success : theme.danger,
                }} />
                <span style={s.diagramNodeLabel}>
                  {p.userId.split(':')[0].replace('@', '')}
                </span>
                <span style={s.diagramNodeSeq}>seq {p.lastSeq}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Connector arrows */}
        <div style={s.diagramConnector}>
          <div style={s.connectorLine} />
          <div style={s.connectorLabel}>
            E2EE Megolm
          </div>
          <div style={s.connectorLine} />
        </div>

        {/* Tier 2: Matrix Room */}
        <div style={s.diagramTier}>
          <div style={s.tierLabel}>Tier 2 — Matrix Room</div>
          <div style={s.tierDesc}>Event timeline (source of truth)</div>
          <div style={s.tierNodes}>
            <div style={{ ...s.diagramNode, borderColor: theme.purple }}>
              <div style={{ ...s.diagramNodeDot, background: theme.purple }} />
              <span style={s.diagramNodeLabel}>#amino-data</span>
              <span style={s.diagramNodeSeq}>
                {syncPairs.find((p) => p.targetId === 'matrix-room')
                  ? `seq ${syncPairs.find((p) => p.targetId === 'matrix-room')!.targetSeq}`
                  : 'connected'}
              </span>
            </div>
          </div>
        </div>

        {/* Connector arrows */}
        <div style={s.diagramConnector}>
          <div style={s.connectorLine} />
          <div style={s.connectorLabel}>
            msgpack snapshots
          </div>
          <div style={s.connectorLine} />
        </div>

        {/* Tier 3: Snapshots / Backups */}
        <div style={s.diagramTier}>
          <div style={s.tierLabel}>Tier 3 — Snapshots</div>
          <div style={s.tierDesc}>Matrix media store (hydration)</div>
          <div style={s.tierNodes}>
            <div style={{ ...s.diagramNode, borderColor: theme.warning }}>
              <div style={{ ...s.diagramNodeDot, background: theme.warning }} />
              <span style={s.diagramNodeLabel}>Snapshots</span>
              <span style={s.diagramNodeSeq}>
                {localPeer && useSyncStore.getState().lastSnapshotSeq > 0
                  ? `@ seq ${useSyncStore.getState().lastSnapshotSeq}`
                  : 'none yet'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div style={s.diagramLegend}>
        <div style={s.legendItem}>
          <div style={{ ...s.legendDot, background: theme.success }} />
          <span>Online</span>
        </div>
        <div style={s.legendItem}>
          <div style={{ ...s.legendDot, background: theme.danger }} />
          <span>Offline</span>
        </div>
        <div style={s.legendItem}>
          <div style={{ ...s.legendDot, background: theme.warning }} />
          <span>Syncing</span>
        </div>
        <div style={s.legendItem}>
          <div style={{ ...s.legendDot, background: theme.purple }} />
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

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
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
      color: t.textHeading,
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
      color: t.textMuted,
      padding: '3px 10px',
      borderRadius: 4,
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
    },
    queueBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.warning,
      padding: '3px 10px',
      borderRadius: 4,
      background: t.warningBg,
      border: `1px solid ${t.warningBorder}`,
    },

    // Sections
    section: {
      marginBottom: 32,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: 600,
      color: t.textHeading,
      margin: '0 0 4px',
      display: 'flex',
      alignItems: 'center',
    },
    sectionDesc: {
      fontSize: 12,
      color: t.textSecondary,
      margin: '0 0 16px',
    },

    // Storage cards
    cardGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
      gap: 12,
    },
    card: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
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
      color: t.success,
      padding: '2px 6px',
      borderRadius: 3,
      background: t.successBg,
      border: `1px solid ${t.successBorder}`,
      fontFamily: "'JetBrains Mono', monospace",
    },
    cardLabel: {
      fontSize: 13,
      fontWeight: 600,
      color: t.textHeading,
      marginBottom: 4,
    },
    cardPath: {
      fontSize: 11,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
      wordBreak: 'break-all' as const,
      marginBottom: 8,
    },
    cardMeta: {
      fontSize: 11,
      color: t.textMuted,
      marginTop: 4,
    },

    // Peer list
    peerList: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    peerCard: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 14,
    },
    peerCardLocal: {
      borderColor: t.accent,
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
      color: t.textHeading,
      fontFamily: "'JetBrains Mono', monospace",
    },
    localBadge: {
      fontSize: 9,
      fontWeight: 600,
      color: t.accent,
      padding: '1px 6px',
      borderRadius: 3,
      background: t.accentBg,
      border: `1px solid ${t.accentBorder}`,
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
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      fontFamily: "'JetBrains Mono', monospace",
    },
    peerDetailValue: {
      fontSize: 12,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
    },
    peerHomeserver: {
      marginTop: 8,
      fontSize: 10,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },

    // Sync pairs
    syncList: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    syncRow: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
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
      color: t.textHeading,
      fontFamily: "'JetBrains Mono', monospace",
    },
    syncArrow: {
      fontSize: 14,
      color: t.textSecondary,
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
      color: t.textMuted,
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
      color: t.textMuted,
      marginTop: 6,
    },

    // Diagram
    diagram: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
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
      color: t.textHeading,
      marginBottom: 2,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      fontFamily: "'JetBrains Mono', monospace",
    },
    tierDesc: {
      fontSize: 10,
      color: t.textMuted,
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
      background: t.bg,
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
      color: t.textHeading,
      fontFamily: "'JetBrains Mono', monospace",
    },
    diagramNodeSeq: {
      fontSize: 9,
      color: t.textMuted,
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
      background: t.border,
    },
    connectorLabel: {
      fontSize: 8,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
      whiteSpace: 'nowrap' as const,
    },
    diagramLegend: {
      display: 'flex',
      justifyContent: 'center',
      gap: 20,
      marginTop: 20,
      paddingTop: 16,
      borderTop: `1px solid ${t.border}`,
    },
    legendItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 10,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
    },
    legendDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
    },

    // Snapshot panel
    snapshotPanel: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
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
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
    },
    snapshotValue: {
      fontSize: 12,
      fontWeight: 600,
      color: t.textHeading,
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
      background: t.purple,
      border: 'none',
      borderRadius: 6,
      cursor: 'pointer',
    },
    snapshotButtonDisabled: {
      background: t.purpleBorder,
      cursor: 'not-allowed',
    },
    snapshotError: {
      fontSize: 11,
      color: t.danger,
      fontFamily: "'JetBrains Mono', monospace",
    },
    snapshotUpToDate: {
      fontSize: 11,
      color: t.success,
      fontFamily: "'JetBrains Mono', monospace",
    },

    // Empty states
    emptyState: {
      padding: 24,
      textAlign: 'center' as const,
      fontSize: 13,
      color: t.textMuted,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
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
      color: t.textSecondary,
    },
    spinner: {
      width: 32,
      height: 32,
      border: `3px solid ${t.border}`,
      borderTopColor: t.accent,
      borderRadius: '50%',
      animation: 'spin 0.8s linear infinite',
    },
  };
}
