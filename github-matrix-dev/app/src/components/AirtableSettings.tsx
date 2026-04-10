/**
 * Airtable integration settings panel.
 *
 * The Airtable API key is delivered via the n8n webhook (same one used for
 * Filen credentials) and held in-memory only. No key management UI — the
 * webhook handles authentication.
 *
 * Sync runs entirely in the browser — Airtable API calls go directly from
 * the browser, records fold into IndexedDB via processEvent.
 *
 * Continuous sync is coordinated via Matrix room state events
 * (eo.airtable.head) so only one client calls the Airtable API at a time.
 */

import { useState, useEffect, useRef } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
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
import { useAirtableStore, DEFAULT_SYNC_SETTINGS } from '../ingestion/airtable-store';
import { AirtableSyncService } from '../ingestion/airtable-sync-service';
import { useTheme, type Theme } from '../theme';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SyncStatus {
  state: 'idle' | 'syncing' | 'discovering' | 'done' | 'error';
  message?: string;
  detail?: string;
}

interface AirtableSettingsProps {
  session: MatrixSession;
  onClose: () => void;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  for (const pattern of namePatterns) {
    const match = fields.find(f => pattern.test(f.name));
    if (match) return match.id;
  }
  return undefined;
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Standalone Airtable settings section (no overlay wrapper).
 * Used inside the Settings page.
 */
export function AirtableSettingsSection({
  session,
  matrixClient,
  roomId,
}: {
  session: MatrixSession;
  matrixClient?: MatrixClient | null;
  roomId?: string | null;
}) {
  const store = useEoStore((s) => s.store);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // ── Airtable store ──
  const connected = useAirtableStore((st) => st.connected);
  const connecting = useAirtableStore((st) => st.connecting);
  const apiKey = useAirtableStore((st) => st.apiKey);
  const storeError = useAirtableStore((st) => st.error);
  const isSyncing = useAirtableStore((st) => st.isSyncing);
  const isPrimarySyncer = useAirtableStore((st) => st.isPrimarySyncer);
  const lastSyncAt = useAirtableStore((st) => st.lastSyncAt);
  const continuousSyncEnabled = useAirtableStore((st) => st.continuousSyncEnabled);
  const syncSettings = useAirtableStore((st) => st.syncSettings);
  const manifest = useAirtableStore((st) => st.manifest);

  // ── Sync state ──
  const [syncStatus, setSyncStatus] = useState<Record<string, SyncStatus>>({});

  // ── Table selection: { baseId: [tableId, ...] } ──
  const [tableSelections, setTableSelections] = useState<Record<string, string[]>>({});

  // ── Preserve existing toggle (initialized from sync settings) ──
  const [preserveExisting, setPreserveExisting] = useState(syncSettings.preserveExisting);

  // ── Record limit (0 = no limit) ──
  const [recordLimit, setRecordLimit] = useState(syncSettings.recordLimit);

  // ── Display field per table: { tableId: fieldId } ──
  const [displayFieldSelections, setDisplayFieldSelections] = useState<Record<string, string>>({});

  // ── Expanded tables (for field preview): Set of tableId ──
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  // ── Sync service ref ──
  const syncServiceRef = useRef<AirtableSyncService | null>(null);

  // ── Cleanup sync service on unmount ──
  useEffect(() => {
    return () => {
      syncServiceRef.current?.stop();
    };
  }, []);

  // ── Connect via webhook ──
  async function handleConnect() {
    try {
      await useAirtableStore.getState().connectFromWebhook(session.accessToken);
    } catch {
      // Error is set in the store
    }
  }

  // ── Disconnect ──
  function handleDisconnect() {
    syncServiceRef.current?.stop();
    syncServiceRef.current = null;
    useAirtableStore.getState().disconnect();
  }

  // ── Resolve which display field to use for a table ──
  function resolveDisplayField(
    table: { id: string; primaryFieldId?: string; fields: Array<{ id: string; name: string; type: string }> },
  ): string | undefined {
    const override = displayFieldSelections[table.id];
    if (override) return override;
    return guessNameField(table.fields) || table.primaryFieldId;
  }

  // ── Toggle expanded table for field preview ──
  function toggleExpandedTable(tableId: string) {
    setExpandedTables((prev) => {
      const next = new Set(prev);
      if (next.has(tableId)) next.delete(tableId);
      else next.add(tableId);
      return next;
    });
  }

  // ── Set display field for a table ──
  function setDisplayField(tableId: string, fieldId: string) {
    setDisplayFieldSelections((prev) => ({ ...prev, [tableId]: fieldId }));
  }

  // ── Build customization from current UI state ──
  function buildCustomization(): SyncCustomization {
    const hasSelection = Object.values(tableSelections).some(t => t.length > 0);

    const displayFieldsMap: Record<string, string> = {};
    if (manifest) {
      for (const base of manifest.bases) {
        for (const table of base.tables) {
          const resolved = resolveDisplayField(table);
          if (resolved) displayFieldsMap[table.id] = resolved;
        }
      }
    }

    return {
      selectedTables: hasSelection ? tableSelections : undefined,
      preserveExisting,
      recordLimit: recordLimit > 0 ? recordLimit : undefined,
      displayFields: Object.keys(displayFieldsMap).length > 0 ? displayFieldsMap : undefined,
    };
  }

  // ── Toggle table selection ──
  function toggleTable(baseId: string, tableId: string) {
    setTableSelections((prev) => {
      const baseTables = [...(prev[baseId] || [])];
      const idx = baseTables.indexOf(tableId);
      if (idx >= 0) baseTables.splice(idx, 1);
      else baseTables.push(tableId);
      return { ...prev, [baseId]: baseTables };
    });
  }

  // ── Select/deselect all tables in a base ──
  function toggleAllTablesInBase(baseId: string, allTableIds: string[]) {
    setTableSelections((prev) => {
      const current = prev[baseId] || [];
      return { ...prev, [baseId]: current.length === allTableIds.length ? [] : [...allTableIds] };
    });
  }

  // ── Discover schema ──
  async function handleDiscover() {
    if (!apiKey) return;
    setSyncStatus((prev) => ({ ...prev, discover: { state: 'discovering', message: 'Discovering bases & tables...' } }));

    try {
      const client = new AirtableClient(apiKey);
      const disc = await discoverSchema(client);

      useAirtableStore.getState().setManifest(disc);

      // Default: select all tables
      const selection: Record<string, string[]> = {};
      for (const base of disc.bases) {
        selection[base.id] = base.tables.map(t => t.id);
      }
      setTableSelections(selection);

      const baseCount = disc.bases.length;
      const tableCount = disc.bases.reduce((t, b) => t + b.tables.length, 0);

      setSyncStatus((prev) => ({
        ...prev,
        discover: {
          state: 'done',
          message: `Found ${baseCount} base${baseCount !== 1 ? 's' : ''}, ${tableCount} table${tableCount !== 1 ? 's' : ''}`,
        },
      }));
    } catch (e: any) {
      setSyncStatus((prev) => ({ ...prev, discover: { state: 'error', message: e.message || 'Discovery failed' } }));
    }
  }

  // ── Trigger one-shot sync ──
  async function handleSync(mode: 'hydrate' | 'sync') {
    if (!apiKey || !store) return;

    const statusKey = mode;
    const modeLabel = mode === 'hydrate' ? 'Full Sync' : 'Update Sync';
    setSyncStatus((prev) => ({ ...prev, [statusKey]: { state: 'syncing', message: `Starting ${modeLabel}...` } }));

    try {
      const client = new AirtableClient(apiKey);
      const customization = buildCustomization();
      const onProgress = (p: { phase: string; table?: string; records_so_far?: number }) => {
        const msg = p.table
          ? `Syncing ${p.table}${p.records_so_far ? ` (${p.records_so_far} records)` : ''}...`
          : 'Discovering schema...';
        setSyncStatus((prev) => ({ ...prev, [statusKey]: { state: 'syncing', message: msg } }));
      };

      const result = mode === 'hydrate'
        ? await hydrationSync(store, client, session.userId, { onProgress, customization })
        : await updateSync(store, client, session.userId, { onProgress, customization });

      const ingested = result.total_records_ingested;
      const skipped = result.total_records_skipped;
      const duration = `${(result.duration_ms / 1000).toFixed(1)}s`;

      useAirtableStore.getState().setLastSyncResult(result);
      useAirtableStore.getState().setLastSyncAt(new Date().toISOString());

      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: {
          state: 'done',
          message: `${ingested} records synced`,
          detail: `${skipped} unchanged, ${duration}`,
        },
      }));
    } catch (e: any) {
      setSyncStatus((prev) => ({
        ...prev,
        [statusKey]: { state: 'error', message: e.message || 'Sync failed' },
      }));
    }
  }

  // ── Toggle continuous sync ──
  function handleToggleContinuousSync() {
    if (continuousSyncEnabled) {
      // Stop
      syncServiceRef.current?.stop();
      syncServiceRef.current = null;
    } else {
      // Start
      if (!matrixClient || !roomId || !store) return;
      const service = new AirtableSyncService(
        matrixClient,
        roomId,
        store,
        session.userId,
        () => useAirtableStore.getState().apiKey,
        buildCustomization(),
      );
      syncServiceRef.current = service;
      useAirtableStore.getState().setContinuousSync(true);
      service.start();
    }
  }

  return (
    <div>
      {/* Connection status */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Airtable Integration</div>

        {!connected ? (
          <div>
            <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 10 }}>
              Connect to Airtable using your organization credentials. The API key is
              fetched securely and held in memory only — it is never stored.
            </div>
            {storeError && <div style={s.error}>{storeError}</div>}
            <button
              onClick={handleConnect}
              disabled={connecting}
              style={{ ...s.connectBtn, opacity: connecting ? 0.5 : 1 }}
            >
              {connecting ? 'Connecting...' : 'Connect to Airtable'}
            </button>
          </div>
        ) : (
          <div>
            <div style={s.connectedRow}>
              <div style={s.connectedDot} />
              <span style={{ fontSize: 12, color: theme.successText }}>Connected</span>
              <button onClick={handleDisconnect} style={s.disconnectBtn}>Disconnect</button>
            </div>

            {lastSyncAt && (
              <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4 }}>
                Last sync: {new Date(lastSyncAt).toLocaleString()}
                {isPrimarySyncer && <span style={{ marginLeft: 8, color: theme.accent }}>(this device is syncing)</span>}
              </div>
            )}

            {/* Actions */}
            <div style={{ ...s.keyActions, marginTop: 10 }}>
              <button
                onClick={handleDiscover}
                disabled={syncStatus.discover?.state === 'discovering'}
                style={s.actionBtn}
              >
                Discover
              </button>
            </div>

            {/* Discovery status */}
            {(() => {
              const status = syncStatus.discover;
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
            {manifest && (
              <div style={s.tablePickerSection}>
                <div style={s.tablePickerTitle}>Select tables to sync</div>
                {manifest.bases.map((base) => {
                  const selection = tableSelections[base.id] || [];
                  const allIds = base.tables.map(t => t.id);
                  const allSelected = allIds.length > 0 && selection.length === allIds.length;
                  return (
                    <div key={base.id} style={s.baseGroup}>
                      <div style={s.baseHeader}>
                        <label style={s.checkLabel}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={() => toggleAllTablesInBase(base.id, allIds)}
                          />
                          <span style={s.baseName}>{base.name}</span>
                        </label>
                        <span style={s.baseCount}>{base.tables.length} tables</span>
                      </div>
                      <div style={s.tableList}>
                        {base.tables.map((table) => {
                          const isExpanded = expandedTables.has(table.id);
                          const resolvedField = resolveDisplayField(table);
                          const resolvedFieldName = table.fields.find(f => f.id === resolvedField)?.name;

                          return (
                            <div key={table.id}>
                              <div style={s.tableItem}>
                                <input
                                  type="checkbox"
                                  checked={selection.includes(table.id)}
                                  onChange={() => toggleTable(base.id, table.id)}
                                />
                                <span
                                  style={{ ...s.tableName, cursor: 'pointer' }}
                                  onClick={() => toggleExpandedTable(table.id)}
                                >
                                  <span style={{ marginRight: 4, fontSize: 10, opacity: 0.6 }}>
                                    {isExpanded ? '\u25BE' : '\u25B8'}
                                  </span>
                                  {table.name}
                                </span>
                                <span style={s.fieldCount}>{table.fieldCount} fields</span>
                                {resolvedFieldName && (
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    fontSize: 10,
                                    color: theme.accent,
                                    marginLeft: 8,
                                    opacity: 0.9,
                                  }}>
                                    name: {resolvedFieldName}
                                    {displayFieldSelections[table.id] && (
                                      <span style={{
                                        background: theme.accentBg,
                                        color: theme.accent,
                                        border: `1px solid ${theme.accent}`,
                                        borderRadius: 4,
                                        padding: '0px 5px',
                                        fontSize: 9,
                                        fontWeight: 700,
                                        letterSpacing: '0.03em',
                                        lineHeight: '16px',
                                      }}>manual</span>
                                    )}
                                  </span>
                                )}
                              </div>

                              {/* Expanded field preview + name field picker */}
                              {isExpanded && (
                                <div style={s.fieldPreview}>
                                  <div style={s.nameFieldPicker}>
                                    <span style={s.nameFieldLabel}>Display name field:</span>
                                    <select
                                      value={displayFieldSelections[table.id] || '_auto'}
                                      onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '_auto') {
                                          setDisplayFieldSelections((prev) => {
                                            const next = { ...prev };
                                            delete next[table.id];
                                            return next;
                                          });
                                        } else if (val === '_first') {
                                          if (table.fields.length > 0) {
                                            setDisplayField(table.id, table.fields[0].id);
                                          }
                                        } else {
                                          setDisplayField(table.id, val);
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
                      checked={preserveExisting}
                      onChange={(e) => {
                        setPreserveExisting(e.target.checked);
                        useAirtableStore.getState().setSyncSettings({ preserveExisting: e.target.checked });
                        syncServiceRef.current?.saveSyncSettings({ preserveExisting: e.target.checked });
                      }}
                    />
                    <span>Preserve existing data in EO-DB</span>
                  </label>
                  <span style={s.preserveHint}>
                    {preserveExisting
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
                      value={recordLimit || ''}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        const limit = isNaN(val) ? 0 : Math.max(0, val);
                        setRecordLimit(limit);
                        useAirtableStore.getState().setSyncSettings({ recordLimit: limit });
                        syncServiceRef.current?.saveSyncSettings({ recordLimit: limit });
                      }}
                      style={s.recordLimitInput}
                    />
                    {recordLimit > 0 && (
                      <button
                        onClick={() => setRecordLimit(0)}
                        style={s.recordLimitClear}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <span style={s.recordLimitHint}>
                    {recordLimit > 0
                      ? `Import up to ${recordLimit} records from each selected table`
                      : 'Import all records from each selected table'}
                  </span>
                </div>

                {/* Sync mode buttons */}
                <div style={s.syncModes}>
                  <div style={s.syncModeCard}>
                    <div style={s.syncModeTitle}>Full Sync</div>
                    <div style={s.syncModeDesc}>
                      Pull all records from selected tables. Skips records that already exist
                      {preserveExisting ? ' and never overwrites existing data' : ''}.
                    </div>
                    <button
                      onClick={() => handleSync('hydrate')}
                      disabled={syncStatus.hydrate?.state === 'syncing'}
                      style={s.syncModeBtn}
                    >
                      {syncStatus.hydrate?.state === 'syncing' ? 'Syncing...' : 'Run Full Sync'}
                    </button>
                    {(() => {
                      const status = syncStatus.hydrate;
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
                      {preserveExisting ? '. Never overwrites existing data' : ''}.
                    </div>
                    <button
                      onClick={() => handleSync('sync')}
                      disabled={syncStatus.sync?.state === 'syncing'}
                      style={s.syncModeBtn}
                    >
                      {syncStatus.sync?.state === 'syncing' ? 'Syncing...' : 'Run Update Sync'}
                    </button>
                    {(() => {
                      const status = syncStatus.sync;
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

                {/* Continuous sync toggle */}
                {matrixClient && roomId && (
                  <div style={s.continuousSyncSection}>
                    <div style={s.continuousSyncRow}>
                      <label style={s.checkLabel}>
                        <input
                          type="checkbox"
                          checked={continuousSyncEnabled}
                          onChange={handleToggleContinuousSync}
                          disabled={isSyncing && !continuousSyncEnabled}
                        />
                        <span>Continuous sync (every 30s)</span>
                      </label>
                      {continuousSyncEnabled && (
                        <span style={{
                          fontSize: 10,
                          padding: '2px 8px',
                          borderRadius: 10,
                          background: isPrimarySyncer ? theme.successBg : theme.bgMuted,
                          color: isPrimarySyncer ? theme.successText : theme.textMuted,
                          border: `1px solid ${isPrimarySyncer ? theme.successBorder : theme.borderLight}`,
                        }}>
                          {isPrimarySyncer ? 'active syncer' : 'standby'}
                        </span>
                      )}
                    </div>
                    <span style={s.continuousSyncHint}>
                      {continuousSyncEnabled
                        ? `This device will automatically pull changes from Airtable every ${syncSettings.syncIntervalSec}s. Only one device syncs at a time — others receive data via the shared data store.`
                        : `Enable to automatically pull Airtable changes every ${syncSettings.syncIntervalSec} seconds`}
                    </span>
                  </div>
                )}

                {/* ── Sync Settings ── */}
                <div style={s.syncSettingsSection}>
                  <div style={s.syncSettingsTitle}>Sync Settings</div>

                  {/* Poll interval */}
                  <div style={s.settingRow}>
                    <label style={s.settingLabel}>Poll interval (seconds)</label>
                    <div style={s.settingInputRow}>
                      <input
                        type="number"
                        min={15}
                        max={600}
                        step={5}
                        value={syncSettings.syncIntervalSec}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val)) {
                            const clamped = Math.max(15, Math.min(600, val));
                            useAirtableStore.getState().setSyncSettings({ syncIntervalSec: clamped });
                            syncServiceRef.current?.saveSyncSettings({ syncIntervalSec: clamped });
                          }
                        }}
                        style={s.settingInput}
                      />
                      <span style={s.settingHint}>
                        How often to check Airtable for changes (15–600s)
                      </span>
                    </div>
                  </div>

                  {/* Sync strategy */}
                  <div style={s.settingRow}>
                    <label style={s.settingLabel}>Check against</label>
                    <div style={s.settingInputRow}>
                      <select
                        value={syncSettings.syncStrategy}
                        onChange={(e) => {
                          const val = e.target.value as 'lastModified' | 'fullDiff';
                          useAirtableStore.getState().setSyncSettings({ syncStrategy: val });
                          syncServiceRef.current?.saveSyncSettings({ syncStrategy: val });
                        }}
                        style={s.settingSelect}
                      >
                        <option value="lastModified">Last modified time (incremental)</option>
                        <option value="fullDiff">Full field diff (thorough)</option>
                      </select>
                      <span style={s.settingHint}>
                        {syncSettings.syncStrategy === 'lastModified'
                          ? 'Uses Airtable\'s LAST_MODIFIED_TIME to fetch only records changed since last sync. Fast and lightweight.'
                          : 'Re-fetches all records and compares field-by-field against EO-DB state. Catches changes that timestamps might miss, but heavier on API quota.'}
                      </span>
                    </div>
                  </div>

                  {/* Last sync info */}
                  {lastSyncAt && (
                    <div style={s.settingRow}>
                      <label style={s.settingLabel}>Last sync</label>
                      <div style={s.lastSyncInfo}>
                        <span style={s.lastSyncTime}>{new Date(lastSyncAt).toLocaleString()}</span>
                        <span style={s.lastSyncAgo}>
                          ({Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 1000)}s ago)
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Overlay wrapper for backward compatibility.
 * Opens AirtableSettingsSection in a slide-out panel.
 */
export function AirtableSettings({ session, onClose, matrixClient, roomId }: AirtableSettingsProps) {
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
        <AirtableSettingsSection session={session} matrixClient={matrixClient} roomId={roomId} />
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

    error: {
      color: t.dangerText,
      fontSize: 12,
      padding: '2px 0',
      marginBottom: 8,
    },
    connectBtn: {
      padding: '10px 20px',
      fontSize: 13,
      fontWeight: 600,
      border: 'none',
      borderRadius: 6,
      background: '#2563eb',
      color: '#fff',
      cursor: 'pointer',
    },
    connectedRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    connectedDot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      background: t.success,
    },
    disconnectBtn: {
      padding: '4px 10px',
      fontSize: 10,
      fontWeight: 500,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 5,
      background: t.bgCard,
      color: t.dangerText,
      cursor: 'pointer',
      marginLeft: 'auto',
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

    // ── Continuous sync ──
    continuousSyncSection: {
      marginTop: 12,
      padding: '10px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    continuousSyncRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    continuousSyncHint: {
      fontSize: 10,
      color: t.textMuted,
      paddingLeft: 22,
      lineHeight: 1.4,
    },

    // ── Sync settings ──
    syncSettingsSection: {
      marginTop: 16,
      padding: '12px 0',
      borderTop: `1px solid ${t.borderLight}`,
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 12,
    },
    syncSettingsTitle: {
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.06em',
      color: t.textMuted,
    },
    settingRow: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    settingLabel: {
      fontSize: 12,
      fontWeight: 500,
      color: t.text,
    },
    settingInputRow: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 3,
    },
    settingInput: {
      width: 80,
      padding: '4px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
    },
    settingSelect: {
      padding: '4px 8px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      maxWidth: 280,
    },
    settingHint: {
      fontSize: 10,
      color: t.textMuted,
      lineHeight: 1.4,
    },
    lastSyncInfo: {
      display: 'flex',
      gap: 6,
      alignItems: 'center',
    },
    lastSyncTime: {
      fontSize: 12,
      color: t.text,
    },
    lastSyncAgo: {
      fontSize: 10,
      color: t.textMuted,
    },
  };
}
