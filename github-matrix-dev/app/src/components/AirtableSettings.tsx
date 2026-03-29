/**
 * Airtable integration settings panel.
 *
 * Manages API keys (stored in room data via EO events), sharing scope
 * (org-wide vs private to current user), and sync triggers.
 *
 * API keys stored as:
 *   - Org-shared:  system.ingestion.airtable.keys.{label}
 *   - Private:     user.{userId}.ingestion.airtable.keys.{label}
 *
 * Sync runs entirely in the browser — Airtable API calls go directly
 * from the browser, records fold into IndexedDB via processEvent.
 * No backend server involved.
 */

import { useState, useEffect, useCallback } from 'react';
import { useEoStore } from '../store/eo-store';
import type { MatrixSession } from '../matrix/client';
import { AirtableClient } from '../ingestion/airtable-client';
import { discoverSchema, hydrationSync, updateSync } from '../ingestion/airtable-sync';

// ─── Types ──────────────────────────────────────────────────────────────────

interface StoredKey {
  label: string;
  shared: boolean;
  addedBy: string;
  addedAt: string;
  lastSyncAt?: string;
  redactedKey: string;
}

interface SyncStatus {
  state: 'idle' | 'syncing' | 'discovering' | 'done' | 'error';
  message?: string;
  detail?: string;
}

interface AirtableSettingsProps {
  session: MatrixSession;
  onClose: () => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const ORG_PREFIX = 'system.ingestion.airtable.keys.';
function userPrefix(userId: string) {
  // Matrix user IDs contain colons — sanitize for target paths
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `user.${safe}.ingestion.airtable.keys.`;
}

function redact(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function labelFromTarget(target: string, userId: string): { label: string; shared: boolean } {
  if (target.startsWith(ORG_PREFIX)) {
    return { label: target.slice(ORG_PREFIX.length), shared: true };
  }
  const up = userPrefix(userId);
  if (target.startsWith(up)) {
    return { label: target.slice(up.length), shared: false };
  }
  return { label: target, shared: false };
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Standalone Airtable settings section (no overlay wrapper).
 * Used inside the Settings page.
 */
export function AirtableSettingsSection({ session }: { session: MatrixSession }) {
  const dispatch = useEoStore((s) => s.dispatch);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);

  // ── Form state ──
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [shared, setShared] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Stored keys ──
  const [keys, setKeys] = useState<StoredKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);

  // ── Sync state ──
  const [syncStatus, setSyncStatus] = useState<Record<string, SyncStatus>>({});

  // ── Load stored keys ──
  const loadKeys = useCallback(async () => {
    setLoadingKeys(true);
    try {
      const orgStates = await getStateByPrefix(ORG_PREFIX);
      const userStates = await getStateByPrefix(userPrefix(session.userId));

      const all: StoredKey[] = [];

      for (const state of orgStates) {
        const { label: lbl } = labelFromTarget(state.target, session.userId);
        const val = state.value || {};
        all.push({
          label: lbl,
          shared: true,
          addedBy: val.added_by || state.last_agent || 'unknown',
          addedAt: val.added_at || state.last_ts || '',
          lastSyncAt: val.last_sync_at,
          redactedKey: val.redacted_key || '***',
        });
      }

      for (const state of userStates) {
        const { label: lbl } = labelFromTarget(state.target, session.userId);
        const val = state.value || {};
        all.push({
          label: lbl,
          shared: false,
          addedBy: val.added_by || state.last_agent || 'unknown',
          addedAt: val.added_at || state.last_ts || '',
          lastSyncAt: val.last_sync_at,
          redactedKey: val.redacted_key || '***',
        });
      }

      setKeys(all);
    } finally {
      setLoadingKeys(false);
    }
  }, [getStateByPrefix, session.userId]);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  // ── Save a new API key ──
  async function handleSave() {
    if (!label.trim() || !apiKey.trim()) return;

    // Validate label (alphanumeric, hyphens, underscores)
    if (!/^[a-zA-Z0-9_-]+$/.test(label.trim())) {
      setError('Label must be alphanumeric with hyphens/underscores only');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const target = shared
        ? `${ORG_PREFIX}${label.trim()}`
        : `${userPrefix(session.userId)}${label.trim()}`;

      // Store the key in room data via a DEF event.
      // The actual API key is stored in the event — it'll be encrypted
      // by Matrix E2EE in the room and by AES-GCM in the local IndexedDB.
      await dispatch({
        op: 'DEF',
        target,
        operand: {
          api_key: apiKey.trim(),
          redacted_key: redact(apiKey.trim()),
          added_by: session.userId,
          added_at: new Date().toISOString(),
          shared,
        },
        agent: session.userId,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      });

      setLabel('');
      setApiKey('');
      await loadKeys();
    } catch (e: any) {
      setError(e.message || 'Failed to save key');
    } finally {
      setSaving(false);
    }
  }

  // ── Delete a key ──
  async function handleDelete(key: StoredKey) {
    const target = key.shared
      ? `${ORG_PREFIX}${key.label}`
      : `${userPrefix(session.userId)}${key.label}`;

    // Remove by setting to null (tombstone)
    await dispatch({
      op: 'DEF',
      target,
      operand: null,
      agent: session.userId,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
      client_event_id: crypto.randomUUID(),
    });

    await loadKeys();
  }

  // ── Retrieve the actual API key from IndexedDB for a stored key entry ──
  async function getApiKey(key: StoredKey): Promise<string | null> {
    const target = key.shared
      ? `${ORG_PREFIX}${key.label}`
      : `${userPrefix(session.userId)}${key.label}`;
    const state = await useEoStore.getState().getState(target);
    return state?.value?.api_key ?? null;
  }

  // ── Trigger sync (runs entirely in the browser) ──
  async function handleSync(key: StoredKey, mode: 'hydrate' | 'sync') {
    const statusKey = `${key.label}-${mode}`;
    setSyncStatus((s) => ({
      ...s,
      [statusKey]: { state: 'syncing', message: `Starting ${mode}...` },
    }));

    try {
      const rawKey = await getApiKey(key);
      if (!rawKey) {
        setSyncStatus((s) => ({
          ...s,
          [statusKey]: { state: 'error', message: 'API key not found in store' },
        }));
        return;
      }

      const store = useEoStore.getState().store;
      if (!store) {
        setSyncStatus((s) => ({
          ...s,
          [statusKey]: { state: 'error', message: 'Store not initialized' },
        }));
        return;
      }

      const client = new AirtableClient(rawKey);
      const onProgress = (p: { phase: string; table?: string; records_so_far?: number }) => {
        const msg = p.table
          ? `Syncing ${p.table}${p.records_so_far ? ` (${p.records_so_far} records)` : ''}...`
          : 'Discovering schema...';
        setSyncStatus((s) => ({
          ...s,
          [statusKey]: { state: 'syncing', message: msg },
        }));
      };

      const result = mode === 'hydrate'
        ? await hydrationSync(store, client, session.userId, { onProgress })
        : await updateSync(store, client, session.userId, { onProgress });

      const ingested = result.total_records_ingested;
      const skipped = result.total_records_skipped;
      const duration = `${(result.duration_ms / 1000).toFixed(1)}s`;

      // Update last sync time in room data
      const target = key.shared
        ? `${ORG_PREFIX}${key.label}`
        : `${userPrefix(session.userId)}${key.label}`;

      try {
        const currentState = await useEoStore.getState().getState(target);
        if (currentState?.value) {
          await dispatch({
            op: 'DEF',
            target,
            operand: {
              ...currentState.value,
              last_sync_at: new Date().toISOString(),
            },
            agent: session.userId,
            ts: new Date().toISOString(),
            acquired_ts: new Date().toISOString(),
            client_event_id: crypto.randomUUID(),
          });
        }
      } catch { /* best-effort update */ }

      setSyncStatus((s) => ({
        ...s,
        [statusKey]: {
          state: 'done',
          message: `${ingested} records synced`,
          detail: `${skipped} unchanged, ${duration}`,
        },
      }));

      await loadKeys();
    } catch (e: any) {
      setSyncStatus((s) => ({
        ...s,
        [statusKey]: { state: 'error', message: e.message || 'Sync failed' },
      }));
    }
  }

  // ── Discover schema (browser-side) ──
  async function handleDiscover(key: StoredKey) {
    const statusKey = `${key.label}-discover`;
    setSyncStatus((s) => ({
      ...s,
      [statusKey]: { state: 'discovering', message: 'Discovering bases & tables...' },
    }));

    try {
      const rawKey = await getApiKey(key);
      if (!rawKey) {
        setSyncStatus((s) => ({
          ...s,
          [statusKey]: { state: 'error', message: 'API key not found in store' },
        }));
        return;
      }

      const client = new AirtableClient(rawKey);
      const manifest = await discoverSchema(client);

      const baseCount = manifest.bases.length;
      const tableCount = manifest.bases.reduce((t, b) => t + b.tables.length, 0);

      setSyncStatus((s) => ({
        ...s,
        [statusKey]: {
          state: 'done',
          message: `Found ${baseCount} base${baseCount !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''}`,
        },
      }));
    } catch (e: any) {
      setSyncStatus((s) => ({
        ...s,
        [statusKey]: { state: 'error', message: e.message || 'Discovery failed' },
      }));
    }
  }

  return (
    <div>
        {/* Add new key */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Add API Key</div>
          <div style={styles.form}>
            <input
              type="text"
              placeholder="Label (e.g. immigration-base)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={styles.input}
              disabled={saving}
            />
            <input
              type="password"
              placeholder="Airtable Personal Access Token"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={styles.input}
              disabled={saving}
              autoComplete="off"
            />
            <div style={styles.shareRow}>
              <label style={styles.shareLabel}>
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => setShared(e.target.checked)}
                  disabled={saving}
                />
                <span style={{ marginLeft: 6 }}>Share with all users in the org</span>
              </label>
              <span style={styles.shareHint}>
                {shared
                  ? 'All users in this room can use this key to sync'
                  : 'Only you and your devices can use this key'}
              </span>
            </div>
            {error && <div style={styles.error}>{error}</div>}
            <button
              onClick={handleSave}
              disabled={saving || !label.trim() || !apiKey.trim()}
              style={{
                ...styles.saveBtn,
                opacity: saving || !label.trim() || !apiKey.trim() ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Save API Key'}
            </button>
          </div>
        </div>

        {/* Stored keys */}
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            Stored Keys
            {loadingKeys && <span style={styles.loadingDot}> loading...</span>}
          </div>

          {!loadingKeys && keys.length === 0 && (
            <div style={styles.emptyKeys}>
              No API keys configured yet. Add one above to get started.
            </div>
          )}

          {keys.map((key) => (
            <div key={`${key.label}-${key.shared}`} style={styles.keyCard}>
              <div style={styles.keyHeader}>
                <div style={styles.keyLabel}>{key.label}</div>
                <div style={styles.keyBadges}>
                  <span style={key.shared ? styles.badgeShared : styles.badgePrivate}>
                    {key.shared ? 'org' : 'private'}
                  </span>
                </div>
              </div>
              <div style={styles.keyMeta}>
                <span>Key: {key.redactedKey}</span>
                <span style={styles.keyMetaDivider} />
                <span>Added by {key.addedBy}</span>
                {key.lastSyncAt && (
                  <>
                    <span style={styles.keyMetaDivider} />
                    <span>Last sync: {new Date(key.lastSyncAt).toLocaleString()}</span>
                  </>
                )}
              </div>

              {/* Actions */}
              <div style={styles.keyActions}>
                <button
                  onClick={() => handleDiscover(key)}
                  disabled={syncStatus[`${key.label}-discover`]?.state === 'discovering'}
                  style={styles.actionBtn}
                >
                  Discover
                </button>
                <button
                  onClick={() => handleSync(key, 'hydrate')}
                  disabled={syncStatus[`${key.label}-hydrate`]?.state === 'syncing'}
                  style={styles.actionBtn}
                >
                  Full Sync
                </button>
                <button
                  onClick={() => handleSync(key, 'sync')}
                  disabled={syncStatus[`${key.label}-sync`]?.state === 'syncing'}
                  style={styles.actionBtn}
                >
                  Update Sync
                </button>
                <button
                  onClick={() => handleDelete(key)}
                  style={styles.deleteBtn}
                >
                  Remove
                </button>
              </div>

              {/* Status messages */}
              {(['discover', 'hydrate', 'sync'] as const).map((mode) => {
                const status = syncStatus[`${key.label}-${mode}`];
                if (!status || status.state === 'idle') return null;
                return (
                  <div
                    key={mode}
                    style={{
                      ...styles.statusMsg,
                      color: status.state === 'error' ? '#dc3545' : status.state === 'done' ? '#28a745' : '#6c757d',
                    }}
                  >
                    {status.state === 'syncing' || status.state === 'discovering' ? (
                      <span style={styles.spinner} />
                    ) : null}
                    {status.message}
                    {status.detail && <span style={styles.statusDetail}> {status.detail}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
    </div>
  );
}

/**
 * Overlay wrapper for backward compatibility.
 * Opens AirtableSettingsSection in a slide-out panel.
 */
export function AirtableSettings({ session, onClose }: AirtableSettingsProps) {
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.panelHeader}>
          <div>
            <div style={styles.panelTitle}>Airtable Integration</div>
            <div style={styles.panelSubtitle}>Connect and sync data from Airtable bases</div>
          </div>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        <AirtableSettingsSection session={session} />
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.3)',
    display: 'flex',
    justifyContent: 'flex-end',
    zIndex: 1000,
  },
  panel: {
    width: 480,
    maxWidth: '100vw',
    height: '100vh',
    background: '#fff',
    borderLeft: '1px solid #e5e2dd',
    overflowY: 'auto',
    boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
    fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '24px 24px 16px',
    borderBottom: '1px solid #e5e2dd',
  },
  panelTitle: {
    fontFamily: "'Source Serif 4', Georgia, serif",
    fontSize: 18,
    fontWeight: 600,
    color: '#1a1816',
  },
  panelSubtitle: {
    fontSize: 12,
    color: '#7a756d',
    marginTop: 2,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 22,
    color: '#7a756d',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },

  section: {
    padding: '20px 24px',
    borderBottom: '1px solid #f0eeeb',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: '#aba69e',
    marginBottom: 12,
  },

  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  input: {
    padding: '10px 12px',
    fontSize: 13,
    border: '1px solid #e5e2dd',
    borderRadius: 6,
    background: '#faf9f7',
    color: '#2c2a26',
    outline: 'none',
    fontFamily: "'JetBrains Mono', monospace",
  },
  shareRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
  },
  shareLabel: {
    display: 'flex',
    alignItems: 'center',
    fontSize: 13,
    color: '#2c2a26',
    cursor: 'pointer',
  },
  shareHint: {
    fontSize: 11,
    color: '#aba69e',
    paddingLeft: 22,
  },
  error: {
    color: '#dc3545',
    fontSize: 12,
    padding: '2px 0',
  },
  saveBtn: {
    padding: '10px 0',
    fontSize: 13,
    fontWeight: 600,
    border: 'none',
    borderRadius: 6,
    background: '#2563eb',
    color: '#fff',
    cursor: 'pointer',
  },

  emptyKeys: {
    fontSize: 13,
    color: '#aba69e',
    padding: '12px 0',
  },

  keyCard: {
    background: '#faf9f7',
    border: '1px solid #e5e2dd',
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  keyHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  keyLabel: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    fontWeight: 600,
    color: '#1a1816',
  },
  keyBadges: {
    display: 'flex',
    gap: 6,
  },
  badgeShared: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#dbeafe',
    color: '#1d4ed8',
  },
  badgePrivate: {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 10,
    background: '#fef3c7',
    color: '#92400e',
  },
  keyMeta: {
    fontSize: 11,
    color: '#7a756d',
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    gap: 4,
    marginBottom: 10,
  },
  keyMetaDivider: {
    display: 'inline-block',
    width: 3,
    height: 3,
    borderRadius: '50%',
    background: '#d4d0ca',
  },

  keyActions: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  actionBtn: {
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 500,
    border: '1px solid #e5e2dd',
    borderRadius: 5,
    background: '#fff',
    color: '#2c2a26',
    cursor: 'pointer',
  },
  deleteBtn: {
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 500,
    border: '1px solid #fecaca',
    borderRadius: 5,
    background: '#fff',
    color: '#dc3545',
    cursor: 'pointer',
    marginLeft: 'auto',
  },

  statusMsg: {
    fontSize: 11,
    marginTop: 8,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  statusDetail: {
    color: '#aba69e',
  },
  spinner: {
    display: 'inline-block',
    width: 10,
    height: 10,
    border: '2px solid #e5e2dd',
    borderTopColor: '#2563eb',
    borderRadius: '50%',
    animation: 'spin 0.6s linear infinite',
  },
  loadingDot: {
    fontWeight: 400,
    textTransform: 'none' as const,
    letterSpacing: 0,
  },
};
