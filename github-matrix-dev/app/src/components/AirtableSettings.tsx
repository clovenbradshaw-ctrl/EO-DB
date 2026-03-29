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
import { useTheme, type Theme } from '../theme';

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
  const { theme } = useTheme();
  const s = makeStyles(theme);

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
    setSyncStatus((prev) => ({
      ...prev,
      [statusKey]: { state: 'syncing', message: `Starting ${mode}...` },
    }));

    try {
      const rawKey = await getApiKey(key);
      if (!rawKey) {
        setSyncStatus((prev) => ({
          ...prev,
          [statusKey]: { state: 'error', message: 'API key not found in store' },
        }));
        return;
      }

      const store = useEoStore.getState().store;
      if (!store) {
        setSyncStatus((prev) => ({
          ...prev,
          [statusKey]: { state: 'error', message: 'Store not initialized' },
        }));
        return;
      }

      const client = new AirtableClient(rawKey);
      const onProgress = (p: { phase: string; table?: string; records_so_far?: number }) => {
        const msg = p.table
          ? `Syncing ${p.table}${p.records_so_far ? ` (${p.records_so_far} records)` : ''}...`
          : 'Discovering schema...';
        setSyncStatus((prev) => ({
          ...prev,
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

      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: {
          state: 'done',
          message: `${ingested} records synced`,
          detail: `${skipped} unchanged, ${duration}`,
        },
      }));

      await loadKeys();
    } catch (e: any) {
      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: { state: 'error', message: e.message || 'Sync failed' },
      }));
    }
  }

  // ── Discover schema (browser-side) ──
  async function handleDiscover(key: StoredKey) {
    const statusKey = `${key.label}-discover`;
    setSyncStatus((prev) => ({
      ...prev,
      [statusKey]: { state: 'discovering', message: 'Discovering bases & tables...' },
    }));

    try {
      const rawKey = await getApiKey(key);
      if (!rawKey) {
        setSyncStatus((prev) => ({
          ...prev,
          [statusKey]: { state: 'error', message: 'API key not found in store' },
        }));
        return;
      }

      const client = new AirtableClient(rawKey);
      const manifest = await discoverSchema(client);

      const baseCount = manifest.bases.length;
      const tableCount = manifest.bases.reduce((t, b) => t + b.tables.length, 0);

      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: {
          state: 'done',
          message: `Found ${baseCount} base${baseCount !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''}`,
        },
      }));
    } catch (e: any) {
      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: { state: 'error', message: e.message || 'Discovery failed' },
      }));
    }
  }

  return (
    <div>
        {/* Add new key */}
        <div style={s.section}>
          <div style={s.sectionTitle}>Add API Key</div>
          <div style={s.form}>
            <input
              type="text"
              placeholder="Label (e.g. immigration-base)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={s.input}
              disabled={saving}
            />
            <input
              type="password"
              placeholder="Airtable Personal Access Token"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={s.input}
              disabled={saving}
              autoComplete="off"
            />
            <div style={s.shareRow}>
              <label style={s.shareLabel}>
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => setShared(e.target.checked)}
                  disabled={saving}
                />
                <span style={{ marginLeft: 6 }}>Share with all users in the org</span>
              </label>
              <span style={s.shareHint}>
                {shared
                  ? 'All users in this room can use this key to sync'
                  : 'Only you and your devices can use this key'}
              </span>
            </div>
            {error && <div style={s.error}>{error}</div>}
            <button
              onClick={handleSave}
              disabled={saving || !label.trim() || !apiKey.trim()}
              style={{
                ...s.saveBtn,
                opacity: saving || !label.trim() || !apiKey.trim() ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving...' : 'Save API Key'}
            </button>
          </div>
        </div>

        {/* Stored keys */}
        <div style={s.section}>
          <div style={s.sectionTitle}>
            Stored Keys
            {loadingKeys && <span style={s.loadingDot}> loading...</span>}
          </div>

          {!loadingKeys && keys.length === 0 && (
            <div style={s.emptyKeys}>
              No API keys configured yet. Add one above to get started.
            </div>
          )}

          {keys.map((key) => (
            <div key={`${key.label}-${key.shared}`} style={s.keyCard}>
              <div style={s.keyHeader}>
                <div style={s.keyLabel}>{key.label}</div>
                <div style={s.keyBadges}>
                  <span style={key.shared ? s.badgeShared : s.badgePrivate}>
                    {key.shared ? 'org' : 'private'}
                  </span>
                </div>
              </div>
              <div style={s.keyMeta}>
                <span>Key: {key.redactedKey}</span>
                <span style={s.keyMetaDivider} />
                <span>Added by {key.addedBy}</span>
                {key.lastSyncAt && (
                  <>
                    <span style={s.keyMetaDivider} />
                    <span>Last sync: {new Date(key.lastSyncAt).toLocaleString()}</span>
                  </>
                )}
              </div>

              {/* Actions */}
              <div style={s.keyActions}>
                <button
                  onClick={() => handleDiscover(key)}
                  disabled={syncStatus[`${key.label}-discover`]?.state === 'discovering'}
                  style={s.actionBtn}
                >
                  Discover
                </button>
                <button
                  onClick={() => handleSync(key, 'hydrate')}
                  disabled={syncStatus[`${key.label}-hydrate`]?.state === 'syncing'}
                  style={s.actionBtn}
                >
                  Full Sync
                </button>
                <button
                  onClick={() => handleSync(key, 'sync')}
                  disabled={syncStatus[`${key.label}-sync`]?.state === 'syncing'}
                  style={s.actionBtn}
                >
                  Update Sync
                </button>
                <button
                  onClick={() => handleDelete(key)}
                  style={s.deleteBtn}
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
                      ...s.statusMsg,
                      color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                    }}
                  >
                    {status.state === 'syncing' || status.state === 'discovering' ? (
                      <span style={s.spinner} />
                    ) : null}
                    {status.message}
                    {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
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
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.panel} onClick={(e) => e.stopPropagation()}>
        <div style={s.panelHeader}>
          <div>
            <div style={s.panelTitle}>Airtable Integration</div>
            <div style={s.panelSubtitle}>Connect and sync data from Airtable bases</div>
          </div>
          <button onClick={onClose} style={s.closeBtn}>&times;</button>
        </div>
        <AirtableSettingsSection session={session} />
      </div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    overlay: {
      position: 'fixed',
      inset: 0,
      background: t.shadowOverlay,
      display: 'flex',
      justifyContent: 'flex-end',
      zIndex: 1000,
    },
    panel: {
      width: 480,
      maxWidth: '100vw',
      height: '100vh',
      background: t.bgCard,
      borderLeft: `1px solid ${t.border}`,
      overflowY: 'auto',
      boxShadow: t.shadowPanel,
      fontFamily: "'Outfit', system-ui, -apple-system, sans-serif",
    },
    panelHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      padding: '24px 24px 16px',
      borderBottom: `1px solid ${t.border}`,
    },
    panelTitle: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 18,
      fontWeight: 600,
      color: t.textHeading,
    },
    panelSubtitle: {
      fontSize: 12,
      color: t.textSecondary,
      marginTop: 2,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 22,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
    },

    section: {
      padding: '20px 24px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    sectionTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
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
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bg,
      color: t.text,
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
      color: t.text,
      cursor: 'pointer',
    },
    shareHint: {
      fontSize: 11,
      color: t.textMuted,
      paddingLeft: 22,
    },
    error: {
      color: t.dangerText,
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
      color: t.textMuted,
      padding: '12px 0',
    },

    keyCard: {
      background: t.bg,
      border: `1px solid ${t.border}`,
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
      color: t.textHeading,
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
      background: t.badgeSharedBg,
      color: t.badgeSharedText,
    },
    badgePrivate: {
      fontSize: 10,
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: 10,
      background: t.badgePrivateBg,
      color: t.badgePrivateText,
    },
    keyMeta: {
      fontSize: 11,
      color: t.textSecondary,
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
      background: t.borderDivider,
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
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.text,
      cursor: 'pointer',
    },
    deleteBtn: {
      padding: '6px 12px',
      fontSize: 11,
      fontWeight: 500,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.dangerText,
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
      color: t.textMuted,
    },
    spinner: {
      display: 'inline-block',
      width: 10,
      height: 10,
      border: `2px solid ${t.border}`,
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
}
