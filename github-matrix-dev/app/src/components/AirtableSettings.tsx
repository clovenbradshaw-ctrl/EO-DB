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
import {
  discoverSchema,
  hydrationSync,
  updateSync,
  type HydrationManifest,
  type SyncCustomization,
} from '../ingestion/airtable-sync';
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

  // ── Discovery manifest (for table picker) ──
  const [manifests, setManifests] = useState<Record<string, HydrationManifest>>({});

  // ── Table selection per key: { keyLabel: { baseId: [tableId, ...] } } ──
  const [tableSelections, setTableSelections] = useState<Record<string, Record<string, string[]>>>({});

  // ── Preserve existing toggle per key ──
  const [preserveFlags, setPreserveFlags] = useState<Record<string, boolean>>({});

  // ── Record limit per key (0 = no limit) ──
  const [recordLimits, setRecordLimits] = useState<Record<string, number>>({});

  // ── Display field per table: { keyLabel: { tableId: fieldId } } ──
  const [displayFieldSelections, setDisplayFieldSelections] = useState<Record<string, Record<string, string>>>({});

  // ── Expanded tables (for field preview): Set of "keyLabel:tableId" ──
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

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

  // ── Auto-guess the best display name field for a table ──
  function guessNameField(fields: Array<{ id: string; name: string; type: string }>): string | undefined {
    const namePatterns = [
      /^name$/i,
      /^full[\s_-]?name$/i,
      /^display[\s_-]?name$/i,
      /^title$/i,
      /^label$/i,
      /^client[\s_-]?name$/i,
      /^company[\s_-]?name$/i,
      /^project[\s_-]?name$/i,
      /^subject$/i,
      /name/i,
      /title/i,
    ];
    for (const pattern of namePatterns) {
      const match = fields.find(f => pattern.test(f.name) && (f.type === 'singleLineText' || f.type === 'multilineText' || f.type === 'richText'));
      if (match) return match.id;
    }
    // Also check non-text fields with name patterns
    for (const pattern of namePatterns) {
      const match = fields.find(f => pattern.test(f.name));
      if (match) return match.id;
    }
    return undefined;
  }

  // ── Resolve which display field to use for a table ──
  function resolveDisplayField(
    keyLabel: string,
    table: { id: string; primaryFieldId?: string; fields: Array<{ id: string; name: string; type: string }> },
  ): string | undefined {
    // User override takes priority
    const override = displayFieldSelections[keyLabel]?.[table.id];
    if (override) return override;
    // Auto-guess, falling back to primaryFieldId
    return guessNameField(table.fields) || table.primaryFieldId;
  }

  // ── Toggle expanded table for field preview ──
  function toggleExpandedTable(keyLabel: string, tableId: string) {
    const key = `${keyLabel}:${tableId}`;
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Set display field for a table ──
  function setDisplayField(keyLabel: string, tableId: string, fieldId: string) {
    setDisplayFieldSelections((prev) => ({
      ...prev,
      [keyLabel]: { ...(prev[keyLabel] || {}), [tableId]: fieldId },
    }));
  }

  // ── Build customization from current UI state ──
  function buildCustomization(keyLabel: string, manifest?: HydrationManifest): SyncCustomization {
    const selection = tableSelections[keyLabel];
    const hasSelection = selection && Object.values(selection).some(t => t.length > 0);
    const limit = recordLimits[keyLabel] || 0;

    // Build display fields map from resolved values
    const displayFieldsMap: Record<string, string> = {};
    if (manifest) {
      for (const base of manifest.bases) {
        for (const table of base.tables) {
          const resolved = resolveDisplayField(keyLabel, table);
          if (resolved) displayFieldsMap[table.id] = resolved;
        }
      }
    }

    return {
      selectedTables: hasSelection ? selection : undefined,
      preserveExisting: preserveFlags[keyLabel] ?? true,
      recordLimit: limit > 0 ? limit : undefined,
      displayFields: Object.keys(displayFieldsMap).length > 0 ? displayFieldsMap : undefined,
    };
  }

  // ── Toggle table selection ──
  function toggleTable(keyLabel: string, baseId: string, tableId: string) {
    setTableSelections((prev) => {
      const keySelection = { ...(prev[keyLabel] || {}) };
      const baseTables = [...(keySelection[baseId] || [])];
      const idx = baseTables.indexOf(tableId);
      if (idx >= 0) {
        baseTables.splice(idx, 1);
      } else {
        baseTables.push(tableId);
      }
      keySelection[baseId] = baseTables;
      return { ...prev, [keyLabel]: keySelection };
    });
  }

  // ── Select/deselect all tables in a base ──
  function toggleAllTablesInBase(keyLabel: string, baseId: string, allTableIds: string[]) {
    setTableSelections((prev) => {
      const keySelection = { ...(prev[keyLabel] || {}) };
      const current = keySelection[baseId] || [];
      keySelection[baseId] = current.length === allTableIds.length ? [] : [...allTableIds];
      return { ...prev, [keyLabel]: keySelection };
    });
  }

  // ── Trigger sync (runs entirely in the browser) ──
  async function handleSync(key: StoredKey, mode: 'hydrate' | 'sync') {
    const statusKey = `${key.label}-${mode}`;
    const modeLabel = mode === 'hydrate' ? 'Full Sync' : 'Update Sync';
    setSyncStatus((prev) => ({
      ...prev,
      [statusKey]: { state: 'syncing', message: `Starting ${modeLabel}...` },
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
      const customization = buildCustomization(key.label, manifests[key.label]);
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
        ? await hydrationSync(store, client, session.userId, { onProgress, customization })
        : await updateSync(store, client, session.userId, { onProgress, customization });

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

      // Store the manifest for table picker
      setManifests((prev) => ({ ...prev, [key.label]: manifest }));

      // Default: select all tables
      const selection: Record<string, string[]> = {};
      for (const base of manifest.bases) {
        selection[base.id] = base.tables.map(t => t.id);
      }
      setTableSelections((prev) => ({ ...prev, [key.label]: selection }));

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
          <div style={s.sectionTitle}>Airtable Integration</div>
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
              {saving ? 'Saving...' : 'Save Key'}
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

              {/* Actions row: Discover + Remove */}
              <div style={s.keyActions}>
                <button
                  onClick={() => handleDiscover(key)}
                  disabled={syncStatus[`${key.label}-discover`]?.state === 'discovering'}
                  style={s.actionBtn}
                >
                  Discover
                </button>
                <button
                  onClick={() => handleDelete(key)}
                  style={s.deleteBtn}
                >
                  Remove
                </button>
              </div>

              {/* Discovery status */}
              {(() => {
                const status = syncStatus[`${key.label}-discover`];
                if (!status || status.state === 'idle') return null;
                return (
                  <div style={{
                    ...s.statusMsg,
                    color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                  }}>
                    {status.state === 'discovering' && <span style={s.spinner} />}
                    {status.message}
                  </div>
                );
              })()}

              {/* Table picker (shown after discovery) */}
              {manifests[key.label] && (
                <div style={s.tablePickerSection}>
                  <div style={s.tablePickerTitle}>Select tables to sync</div>
                  {manifests[key.label].bases.map((base) => {
                    const selection = tableSelections[key.label]?.[base.id] || [];
                    const allIds = base.tables.map(t => t.id);
                    const allSelected = allIds.length > 0 && selection.length === allIds.length;
                    return (
                      <div key={base.id} style={s.baseGroup}>
                        <div style={s.baseHeader}>
                          <label style={s.checkLabel}>
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={() => toggleAllTablesInBase(key.label, base.id, allIds)}
                            />
                            <span style={s.baseName}>{base.name}</span>
                          </label>
                          <span style={s.baseCount}>{base.tables.length} tables</span>
                        </div>
                        <div style={s.tableList}>
                          {base.tables.map((table) => {
                            const expandKey = `${key.label}:${table.id}`;
                            const isExpanded = expandedTables.has(expandKey);
                            const resolvedField = resolveDisplayField(key.label, table);
                            const resolvedFieldName = table.fields.find(f => f.id === resolvedField)?.name;

                            return (
                              <div key={table.id}>
                                <div style={s.tableItem}>
                                  <input
                                    type="checkbox"
                                    checked={selection.includes(table.id)}
                                    onChange={() => toggleTable(key.label, base.id, table.id)}
                                  />
                                  <span
                                    style={{ ...s.tableName, cursor: 'pointer' }}
                                    onClick={() => toggleExpandedTable(key.label, table.id)}
                                  >
                                    <span style={{ marginRight: 4, fontSize: 10, opacity: 0.6 }}>
                                      {isExpanded ? '\u25BE' : '\u25B8'}
                                    </span>
                                    {table.name}
                                  </span>
                                  <span style={s.fieldCount}>{table.fieldCount} fields</span>
                                  {resolvedFieldName && (
                                    <span style={{
                                      fontSize: 10,
                                      color: theme.accent,
                                      marginLeft: 8,
                                      opacity: 0.8,
                                    }}>
                                      name: {resolvedFieldName}
                                    </span>
                                  )}
                                </div>

                                {/* Expanded field preview + name field picker */}
                                {isExpanded && (
                                  <div style={s.fieldPreview}>
                                    <div style={s.nameFieldPicker}>
                                      <span style={s.nameFieldLabel}>Display name field:</span>
                                      <select
                                        value={displayFieldSelections[key.label]?.[table.id] || '_auto'}
                                        onChange={(e) => {
                                          const val = e.target.value;
                                          if (val === '_auto') {
                                            // Clear override, use auto-guess
                                            setDisplayFieldSelections((prev) => {
                                              const next = { ...prev, [key.label]: { ...(prev[key.label] || {}) } };
                                              delete next[key.label][table.id];
                                              return next;
                                            });
                                          } else if (val === '_first') {
                                            // Use first field
                                            if (table.fields.length > 0) {
                                              setDisplayField(key.label, table.id, table.fields[0].id);
                                            }
                                          } else {
                                            setDisplayField(key.label, table.id, val);
                                          }
                                        }}
                                        style={s.nameFieldSelect}
                                      >
                                        <option value="_auto">Auto-guess{guessNameField(table.fields) ? ` (${table.fields.find(f => f.id === guessNameField(table.fields))?.name})` : ''}</option>
                                        <option value="_first">First column ({table.fields[0]?.name || '?'})</option>
                                        <optgroup label="Manual select">
                                          {table.fields.map((f) => (
                                            <option key={f.id} value={f.id}>
                                              {f.name} ({f.type})
                                            </option>
                                          ))}
                                        </optgroup>
                                      </select>
                                    </div>
                                    <div style={s.fieldList}>
                                      {table.fields.map((f) => (
                                        <div key={f.id} style={{
                                          ...s.fieldItem,
                                          ...(f.id === resolvedField ? { background: theme.bgHover, fontWeight: 600 } : {}),
                                        }}>
                                          <span style={s.fieldItemName}>{f.name}</span>
                                          <span style={s.fieldItemType}>{f.type}</span>
                                          {f.id === resolvedField && (
                                            <span style={{ fontSize: 10, color: theme.accent, marginLeft: 'auto' }}>name field</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {/* Preserve existing toggle */}
                  <div style={s.preserveRow}>
                    <label style={s.checkLabel}>
                      <input
                        type="checkbox"
                        checked={preserveFlags[key.label] ?? true}
                        onChange={(e) => setPreserveFlags((prev) => ({ ...prev, [key.label]: e.target.checked }))}
                      />
                      <span>Preserve existing data in EO-DB</span>
                    </label>
                    <span style={s.preserveHint}>
                      {(preserveFlags[key.label] ?? true)
                        ? 'New records and empty fields are filled; existing values are never overwritten'
                        : 'Airtable values will overwrite EO-DB values on every sync'}
                    </span>
                  </div>

                  {/* Record limit */}
                  <div style={s.recordLimitRow}>
                    <label style={s.recordLimitLabel}>
                      Record limit per table
                    </label>
                    <div style={s.recordLimitInputRow}>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        placeholder="No limit"
                        value={recordLimits[key.label] || ''}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          setRecordLimits((prev) => ({
                            ...prev,
                            [key.label]: isNaN(val) ? 0 : Math.max(0, val),
                          }));
                        }}
                        style={s.recordLimitInput}
                      />
                      {(recordLimits[key.label] || 0) > 0 && (
                        <button
                          onClick={() => setRecordLimits((prev) => ({ ...prev, [key.label]: 0 }))}
                          style={s.recordLimitClear}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <span style={s.recordLimitHint}>
                      {(recordLimits[key.label] || 0) > 0
                        ? `Import up to ${recordLimits[key.label]} records from each selected table`
                        : 'Import all records from each selected table'}
                    </span>
                  </div>

                  {/* Sync mode buttons */}
                  <div style={s.syncModes}>
                    <div style={s.syncModeCard}>
                      <div style={s.syncModeTitle}>Full Sync</div>
                      <div style={s.syncModeDesc}>
                        Pull all records from selected tables. Skips records that already exist
                        {(preserveFlags[key.label] ?? true) ? ' and never overwrites existing data' : ''}.
                      </div>
                      <button
                        onClick={() => handleSync(key, 'hydrate')}
                        disabled={syncStatus[`${key.label}-hydrate`]?.state === 'syncing'}
                        style={s.syncModeBtn}
                      >
                        {syncStatus[`${key.label}-hydrate`]?.state === 'syncing' ? 'Syncing...' : 'Run Full Sync'}
                      </button>
                      {(() => {
                        const status = syncStatus[`${key.label}-hydrate`];
                        if (!status || status.state === 'idle') return null;
                        return (
                          <div style={{
                            ...s.statusMsg,
                            color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                          }}>
                            {status.state === 'syncing' && <span style={s.spinner} />}
                            {status.message}
                            {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                          </div>
                        );
                      })()}
                    </div>

                    <div style={s.syncModeCard}>
                      <div style={s.syncModeTitle}>Update Sync</div>
                      <div style={s.syncModeDesc}>
                        Pull only records modified since last sync. Requires a prior Full Sync
                        {(preserveFlags[key.label] ?? true) ? '. Never overwrites existing data' : ''}.
                      </div>
                      <button
                        onClick={() => handleSync(key, 'sync')}
                        disabled={syncStatus[`${key.label}-sync`]?.state === 'syncing'}
                        style={s.syncModeBtn}
                      >
                        {syncStatus[`${key.label}-sync`]?.state === 'syncing' ? 'Syncing...' : 'Run Update Sync'}
                      </button>
                      {(() => {
                        const status = syncStatus[`${key.label}-sync`];
                        if (!status || status.state === 'idle') return null;
                        return (
                          <div style={{
                            ...s.statusMsg,
                            color: status.state === 'error' ? theme.dangerText : status.state === 'done' ? theme.successText : theme.textSecondary,
                          }}>
                            {status.state === 'syncing' && <span style={s.spinner} />}
                            {status.message}
                            {status.detail && <span style={s.statusDetail}> {status.detail}</span>}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}
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

    // ── Table picker ──
    tablePickerSection: {
      marginTop: 12,
      borderTop: `1px solid ${t.borderLight}`,
      paddingTop: 12,
    },
    tablePickerTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
      marginBottom: 8,
    },
    baseGroup: {
      marginBottom: 8,
    },
    baseHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    checkLabel: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 12,
      color: t.text,
      cursor: 'pointer',
    },
    baseName: {
      fontWeight: 600,
      fontSize: 12,
    },
    baseCount: {
      fontSize: 10,
      color: t.textMuted,
    },
    tableList: {
      paddingLeft: 20,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 3,
    },
    tableItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11,
      color: t.text,
      cursor: 'pointer',
    },
    tableName: {
      flex: 1,
    },
    fieldCount: {
      fontSize: 10,
      color: t.textMuted,
    },

    // ── Field preview (expanded table) ──
    fieldPreview: {
      marginLeft: 22,
      marginBottom: 6,
      padding: '6px 8px',
      background: t.bgMuted,
      borderRadius: 4,
      border: `1px solid ${t.borderLight}`,
    },
    nameFieldPicker: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 6,
      paddingBottom: 6,
      borderBottom: `1px solid ${t.borderLight}`,
    },
    nameFieldLabel: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textSecondary,
      whiteSpace: 'nowrap' as const,
    },
    nameFieldSelect: {
      flex: 1,
      fontSize: 11,
      padding: '2px 4px',
      borderRadius: 3,
      border: `1px solid ${t.border}`,
      background: t.bg,
      color: t.text,
    },
    fieldList: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 1,
      maxHeight: 160,
      overflowY: 'auto' as const,
    },
    fieldItem: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '2px 4px',
      borderRadius: 2,
      fontSize: 10,
      color: t.text,
    },
    fieldItemName: {
      fontFamily: "'JetBrains Mono', monospace",
    },
    fieldItemType: {
      color: t.textMuted,
      fontSize: 9,
    },

    preserveRow: {
      marginTop: 10,
      padding: '8px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    preserveHint: {
      fontSize: 10,
      color: t.textMuted,
      paddingLeft: 22,
    },

    // ── Record limit ──
    recordLimitRow: {
      marginTop: 10,
      padding: '8px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    recordLimitLabel: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
    },
    recordLimitInputRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    recordLimitInput: {
      width: 120,
      padding: '6px 10px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bg,
      color: t.text,
      outline: 'none',
      fontFamily: "'JetBrains Mono', monospace",
    },
    recordLimitClear: {
      padding: '5px 10px',
      fontSize: 10,
      fontWeight: 500,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.textSecondary,
      cursor: 'pointer',
    },
    recordLimitHint: {
      fontSize: 10,
      color: t.textMuted,
    },

    // ── Sync modes ──
    syncModes: {
      display: 'flex',
      gap: 8,
      marginTop: 10,
    },
    syncModeCard: {
      flex: 1,
      padding: 10,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bgCard,
    },
    syncModeTitle: {
      fontSize: 12,
      fontWeight: 600,
      color: t.textHeading,
      marginBottom: 4,
    },
    syncModeDesc: {
      fontSize: 10,
      color: t.textMuted,
      marginBottom: 8,
      lineHeight: 1.4,
    },
    syncModeBtn: {
      width: '100%',
      padding: '7px 0',
      fontSize: 11,
      fontWeight: 600,
      border: `1px solid ${t.border}`,
      borderRadius: 5,
      background: t.bg,
      color: t.text,
      cursor: 'pointer',
    },
  };
}
