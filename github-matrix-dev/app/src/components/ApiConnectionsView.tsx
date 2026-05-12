import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTheme, type Theme } from '../theme';
import { Modal } from './Modal';
import { useApiConnectionStore, reverseMapping } from '../store/api-connection-store';
import type { ApiConnectionConfig, ApiCredentials, GenericRestCredentials, RemoteField } from '../lib/api-adapters/types';

// ─── Utility ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Sync interval options ────────────────────────────────────────────────────

const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: '30 seconds', ms: 30_000 },
  { label: '1 minute',   ms: 60_000 },
  { label: '5 minutes',  ms: 300_000 },
  { label: '15 minutes', ms: 900_000 },
  { label: '1 hour',     ms: 3_600_000 },
];

function intervalLabel(ms: number): string {
  return INTERVAL_OPTIONS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 1000)}s`;
}

// ─── Wizard state ─────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3;

interface WizardState {
  open: boolean;
  step: WizardStep;
  editingConnectionId: string | null;
  // Step 1 — common
  sourceType: 'airtable' | 'generic_rest';
  label: string;
  // Step 1 — Airtable
  apiKey: string;
  baseId: string;
  tableId: string;
  // Step 1 — Generic REST
  baseUrl: string;
  authType: GenericRestCredentials['authType'];
  authValue: string;
  recordsPath: string;
  // Step 1 → 2
  discoveredFields: RemoteField[];
  // Step 2
  fieldMappings: Record<string, string>;  // remoteFieldId → internalName
  writeBackEnabled: boolean;
  minSyncIntervalMs: number;
  // Per-step feedback
  stepLoading: boolean;
  stepError: string | null;
  stepSuccess: string | null;
}

const WIZARD_INIT: WizardState = {
  open: false,
  step: 1,
  editingConnectionId: null,
  sourceType: 'airtable',
  label: '',
  apiKey: '',
  baseId: '',
  tableId: '',
  baseUrl: '',
  authType: 'none',
  authValue: '',
  recordsPath: '',
  discoveredFields: [],
  fieldMappings: {},
  writeBackEnabled: true,
  minSyncIntervalMs: 60_000,
  stepLoading: false,
  stepError: null,
  stepSuccess: null,
};

// ─── Main view ────────────────────────────────────────────────────────────────

export function ApiConnectionsView() {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const {
    connections,
    connectionsLoading,
    loadConnections,
    deleteConnection,
    testAndDiscover,
    saveConnection,
  } = useApiConnectionStore();

  const [wiz, setWiz] = useState<WizardState>(WIZARD_INIT);
  const [openDataConnectionId, setOpenDataConnectionId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    loadConnections();
  }, [loadConnections]);

  const connectionList = useMemo(
    () => Object.values(connections),
    [connections],
  );

  // ── Wizard helpers ────────────────────────────────────────────────────────

  function openNewWizard() {
    setWiz({ ...WIZARD_INIT, open: true });
  }

  function openEditWizard(config: ApiConnectionConfig) {
    const creds = config.credentials;
    if (creds.sourceType === 'airtable') {
      setWiz({
        ...WIZARD_INIT,
        open: true,
        editingConnectionId: config.connectionId,
        sourceType: 'airtable',
        label: config.label,
        apiKey: creds.apiKey,
        baseId: creds.baseId,
        tableId: creds.tableId,
        fieldMappings: { ...config.fieldMappings },
        minSyncIntervalMs: config.minSyncIntervalMs ?? 60_000,
      });
    } else if (creds.sourceType === 'generic_rest') {
      setWiz({
        ...WIZARD_INIT,
        open: true,
        editingConnectionId: config.connectionId,
        sourceType: 'generic_rest',
        label: config.label,
        baseUrl: creds.baseUrl,
        authType: creds.authType,
        authValue: creds.authValue,
        recordsPath: creds.recordsPath,
        fieldMappings: { ...config.fieldMappings },
        minSyncIntervalMs: config.minSyncIntervalMs ?? 60_000,
      });
    }
  }

  function closeWizard() {
    setWiz(WIZARD_INIT);
  }

  function wizSet(partial: Partial<WizardState>) {
    setWiz((prev) => ({ ...prev, ...partial }));
  }

  // Step 1 → 2: test connection and discover fields
  async function handleTestAndContinue() {
    wizSet({ stepLoading: true, stepError: null, stepSuccess: null });
    const creds: ApiCredentials = wiz.sourceType === 'airtable'
      ? {
          sourceType: 'airtable',
          apiKey: wiz.apiKey.trim(),
          baseId: wiz.baseId.trim(),
          tableId: wiz.tableId.trim(),
        }
      : {
          sourceType: 'generic_rest',
          baseUrl: wiz.baseUrl.trim(),
          authType: wiz.authType,
          authValue: wiz.authValue.trim(),
          recordsPath: wiz.recordsPath.trim(),
        };
    try {
      const fields = await testAndDiscover(creds);
      // Pre-fill mappings: existing mapping if editing, else source field name
      const mappings: Record<string, string> = {};
      for (const f of fields) {
        mappings[f.id] = wiz.fieldMappings[f.id] ?? f.name;
      }
      wizSet({
        stepLoading: false,
        stepSuccess: `Connected — ${fields.length} field${fields.length !== 1 ? 's' : ''} found`,
        discoveredFields: fields,
        fieldMappings: mappings,
        step: 2,
      });
    } catch (e: unknown) {
      wizSet({
        stepLoading: false,
        stepError: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Step 3: save
  async function handleSave() {
    wizSet({ stepLoading: true, stepError: null });
    const creds: ApiCredentials = wiz.sourceType === 'airtable'
      ? {
          sourceType: 'airtable',
          apiKey: wiz.apiKey.trim(),
          baseId: wiz.baseId.trim(),
          tableId: wiz.tableId.trim(),
        }
      : {
          sourceType: 'generic_rest',
          baseUrl: wiz.baseUrl.trim(),
          authType: wiz.authType,
          authValue: wiz.authValue.trim(),
          recordsPath: wiz.recordsPath.trim(),
        };
    const fallbackLabel = wiz.sourceType === 'airtable'
      ? `${wiz.baseId}/${wiz.tableId}`
      : wiz.baseUrl;
    // Build _fieldTypes map so the adapter can detect lastModifiedTime fields
    const fieldTypes: Record<string, string> = {};
    for (const f of wiz.discoveredFields) {
      fieldTypes[f.id] = f.type;
    }
    try {
      await saveConnection({
        connectionId: wiz.editingConnectionId ?? undefined,
        label: wiz.label.trim() || fallbackLabel,
        credentials: creds,
        fieldMappings: wiz.fieldMappings,
        minSyncIntervalMs: wiz.minSyncIntervalMs,
        _fieldTypes: fieldTypes,
      } as Parameters<typeof saveConnection>[0] & { _fieldTypes: Record<string, string> });
      closeWizard();
      await loadConnections();
    } catch (e: unknown) {
      wizSet({
        stepLoading: false,
        stepError: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── Connection list view ──────────────────────────────────────────────────

  if (openDataConnectionId && connections[openDataConnectionId]) {
    return (
      <ApiDataView
        config={connections[openDataConnectionId]}
        onBack={() => setOpenDataConnectionId(null)}
      />
    );
  }

  const mappedFieldCount = (config: ApiConnectionConfig) =>
    Object.values(config.fieldMappings).filter(Boolean).length;

  return (
    <div style={s.container}>
      <div style={s.header}>
        <div>
          <div style={s.pageTitle}>API Connections</div>
          <div style={s.pageSubtitle}>
            Connect external sources and sync data into this space.
            Credentials are stored in room state and shared with all members.
          </div>
        </div>
        <button style={s.btnPrimary} onClick={openNewWizard}>
          + New Connection
        </button>
      </div>

      {connectionsLoading && (
        <div style={s.empty}>Loading connections…</div>
      )}

      {!connectionsLoading && connectionList.length === 0 && (
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>🔗</div>
          <div style={s.emptyTitle}>No connections yet</div>
          <div style={s.emptySub}>
            Add your first API connection to start syncing external data.
          </div>
          <button style={s.btnPrimary} onClick={openNewWizard}>
            + New Connection
          </button>
        </div>
      )}

      {connectionList.map((config) => (
        <div key={config.connectionId} style={s.card}>
          <div style={s.cardLeft}>
            <div style={s.cardTitle}>{config.label}</div>
            <div style={s.cardMeta}>
              <span style={s.pill}>{config.credentials.sourceType}</span>
              {'baseId' in config.credentials && (
                <span style={s.cardSub}>
                  {config.credentials.baseId} / {config.credentials.tableId}
                </span>
              )}
              {'baseUrl' in config.credentials && (
                <span style={s.cardSub}>
                  {config.credentials.baseUrl}
                </span>
              )}
            </div>
            <div style={s.cardSub}>
              {mappedFieldCount(config)} fields mapped ·{' '}
              Last synced: {relativeTime(config.lastSyncAt)}
            </div>
          </div>
          <div style={s.cardActions}>
            <button
              style={s.btnSecondary}
              onClick={() => setOpenDataConnectionId(config.connectionId)}
            >
              Open Data
            </button>
            <button style={s.btnGhost} onClick={() => openEditWizard(config)}>
              Edit
            </button>
            {deleteConfirmId === config.connectionId ? (
              <>
                <span style={s.deleteConfirmText}>Delete this connection?</span>
                <button
                  style={s.btnDanger}
                  onClick={async () => {
                    await deleteConnection(config.connectionId);
                    setDeleteConfirmId(null);
                  }}
                >
                  Confirm
                </button>
                <button style={s.btnGhost} onClick={() => setDeleteConfirmId(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button
                style={s.btnGhost}
                onClick={() => setDeleteConfirmId(config.connectionId)}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ))}

      {/* ── Wizard modal ── */}
      <Modal
        open={wiz.open}
        onClose={closeWizard}
        title={wiz.editingConnectionId ? 'Edit Connection' : 'New Connection'}
        width={580}
        closeOnBackdrop={false}
        footer={<WizardFooter wiz={wiz} wizSet={wizSet} onTest={handleTestAndContinue} onSave={handleSave} onClose={closeWizard} />}
      >
        <WizardBody wiz={wiz} wizSet={wizSet} />
      </Modal>
    </div>
  );
}

// ─── Wizard body ──────────────────────────────────────────────────────────────

function WizardBody({ wiz, wizSet }: { wiz: WizardState; wizSet: (p: Partial<WizardState>) => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div>
      {/* Step indicator */}
      <div style={s.stepBar}>
        {([1, 2, 3] as WizardStep[]).map((n, i) => (
          <div key={n} style={s.stepItem}>
            <div style={{ ...s.stepDot, ...(wiz.step >= n ? s.stepDotActive : {}) }}>
              {n}
            </div>
            {i < 2 && <div style={{ ...s.stepLine, ...(wiz.step > n ? s.stepLineActive : {}) }} />}
          </div>
        ))}
        <div style={s.stepLabels}>
          <span style={wiz.step === 1 ? s.stepLabelActive : s.stepLabel}>Connect</span>
          <span style={wiz.step === 2 ? s.stepLabelActive : s.stepLabel}>Map Fields</span>
          <span style={wiz.step === 3 ? s.stepLabelActive : s.stepLabel}>Review</span>
        </div>
      </div>

      {wiz.step === 1 && <Step1 wiz={wiz} wizSet={wizSet} />}
      {wiz.step === 2 && <Step2 wiz={wiz} wizSet={wizSet} />}
      {wiz.step === 3 && <Step3 wiz={wiz} />}
    </div>
  );
}

// ─── Step 1: Connect ──────────────────────────────────────────────────────────

function Step1({ wiz, wizSet }: { wiz: WizardState; wizSet: (p: Partial<WizardState>) => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.stepBody}>
      <div style={s.fieldGroup}>
        <label style={s.label}>Source type</label>
        <div style={s.radioGroup}>
          <label style={s.radioLabel}>
            <input
              type="radio"
              checked={wiz.sourceType === 'airtable'}
              onChange={() => wizSet({ sourceType: 'airtable' })}
            />
            {' '}Airtable
          </label>
          <label style={s.radioLabel}>
            <input
              type="radio"
              checked={wiz.sourceType === 'generic_rest'}
              onChange={() => wizSet({ sourceType: 'generic_rest' })}
            />
            {' '}Generic REST
          </label>
        </div>
      </div>

      <div style={s.fieldGroup}>
        <label style={s.label}>Label</label>
        <input
          style={s.input}
          value={wiz.label}
          onChange={(e) => wizSet({ label: e.target.value })}
          placeholder="e.g. Contacts Base"
          aria-label="Connection label"
        />
      </div>

      {wiz.sourceType === 'airtable' && (
        <>
          <div style={s.fieldGroup}>
            <label style={s.label}>Base ID</label>
            <input
              style={s.input}
              value={wiz.baseId}
              onChange={(e) => wizSet({ baseId: e.target.value })}
              placeholder="appXYZ123"
              aria-label="Airtable base ID"
              autoComplete="off"
            />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Table ID or name</label>
            <input
              style={s.input}
              value={wiz.tableId}
              onChange={(e) => wizSet({ tableId: e.target.value })}
              placeholder="tblABC456 or Contacts"
              aria-label="Airtable table ID or name"
              autoComplete="off"
            />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>API Key (Personal Access Token)</label>
            <input
              style={s.input}
              type="password"
              value={wiz.apiKey}
              onChange={(e) => wizSet({ apiKey: e.target.value })}
              placeholder="pat..."
              aria-label="Airtable API key"
              autoComplete="new-password"
            />
            <div style={s.hint}>
              Stored encrypted in room state — shared with all space members.
            </div>
          </div>
        </>
      )}

      {wiz.sourceType === 'generic_rest' && (
        <>
          <div style={s.fieldGroup}>
            <label style={s.label}>Base URL</label>
            <input
              style={s.input}
              value={wiz.baseUrl}
              onChange={(e) => wizSet({ baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1/users"
              aria-label="REST endpoint URL"
              autoComplete="off"
            />
          </div>

          <div style={s.fieldGroup}>
            <label style={s.label}>Auth type</label>
            <select
              style={s.input}
              value={wiz.authType}
              onChange={(e) => wizSet({ authType: e.target.value as GenericRestCredentials['authType'] })}
              aria-label="Auth type"
            >
              <option value="none">No Auth</option>
              <option value="bearer">Bearer Token</option>
              <option value="apikey">API Key Header</option>
            </select>
          </div>

          {wiz.authType !== 'none' && (
            <div style={s.fieldGroup}>
              <label style={s.label}>
                {wiz.authType === 'bearer' ? 'Bearer Token' : 'API Key Value'}
              </label>
              <input
                style={s.input}
                type="password"
                value={wiz.authValue}
                onChange={(e) => wizSet({ authValue: e.target.value })}
                placeholder={wiz.authType === 'bearer' ? 'eyJ…' : 'your-api-key'}
                aria-label="Auth value"
                autoComplete="new-password"
              />
              <div style={s.hint}>
                Stored encrypted in room state — shared with all space members.
              </div>
            </div>
          )}

          <div style={s.fieldGroup}>
            <label style={s.label}>Records path</label>
            <input
              style={s.input}
              value={wiz.recordsPath}
              onChange={(e) => wizSet({ recordsPath: e.target.value })}
              placeholder="data.items"
              aria-label="Records path"
              autoComplete="off"
            />
            <div style={s.hint}>
              Dot-path to the records array in the JSON response (e.g. <code>data.items</code>).
              Leave blank if the root response is already an array.
            </div>
          </div>
        </>
      )}

      {wiz.stepError && <div style={s.errorMsg} role="alert">{wiz.stepError}</div>}
      {wiz.stepSuccess && <div style={s.successMsg}>{wiz.stepSuccess}</div>}
    </div>
  );
}

// ─── Step 2: Map Fields ───────────────────────────────────────────────────────

function Step2({ wiz, wizSet }: { wiz: WizardState; wizSet: (p: Partial<WizardState>) => void }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.stepBody}>
      <div style={s.mapHeader}>
        <div style={s.mapCol}>Source Field</div>
        <div style={s.mapCol}>Internal Name</div>
      </div>

      {wiz.stepError && <div style={s.errorMsg} role="alert">{wiz.stepError}</div>}

      <div style={s.mapRows}>
        {wiz.discoveredFields.map((field) => {
          const isLastModified = field.type === 'lastModifiedTime';
          return (
            <div key={field.id} style={s.mapRow}>
              <div style={s.mapSourceCell}>
                <span style={s.mapFieldName}>{field.name}</span>
                <span style={s.typePill}>{field.type}</span>
                {isLastModified && (
                  <span style={s.syncBadge} title="This field will be used as the sync signal">
                    ⟳ sync signal
                  </span>
                )}
              </div>
              <div style={s.mapInternalCell}>
                <input
                  style={s.mapInput}
                  value={wiz.fieldMappings[field.id] ?? ''}
                  onChange={(e) =>
                    wizSet({
                      fieldMappings: {
                        ...wiz.fieldMappings,
                        [field.id]: e.target.value,
                      },
                    })
                  }
                  placeholder="(skip)"
                  aria-label={`Internal name for ${field.name}`}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div style={s.toggleRow}>
        <label style={s.toggleLabel}>
          <input
            type="checkbox"
            checked={wiz.writeBackEnabled}
            onChange={(e) => wizSet({ writeBackEnabled: e.target.checked })}
          />
          {' '}Write back on edit (enables CRUD — changes sync back to source)
        </label>
      </div>

      <div style={s.fieldGroup}>
        <label style={s.label}>Min sync interval</label>
        <select
          style={s.input}
          value={wiz.minSyncIntervalMs}
          onChange={(e) => wizSet({ minSyncIntervalMs: Number(e.target.value) })}
          aria-label="Minimum sync interval"
        >
          {INTERVAL_OPTIONS.map((o) => (
            <option key={o.ms} value={o.ms}>{o.label}</option>
          ))}
        </select>
        <div style={s.hint}>How often "Sync Now" can be triggered. Applies to all clients.</div>
      </div>
    </div>
  );
}

// ─── Step 3: Review ───────────────────────────────────────────────────────────

function Step3({ wiz }: { wiz: WizardState }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const mappedCount = Object.values(wiz.fieldMappings).filter(Boolean).length;
  const totalCount = wiz.discoveredFields.length;
  const hasLastModified = wiz.discoveredFields.some(
    (f) => f.type === 'lastModifiedTime' && wiz.fieldMappings[f.id],
  );

  const fallbackLabel = wiz.sourceType === 'airtable'
    ? `${wiz.baseId}/${wiz.tableId}`
    : wiz.baseUrl;

  return (
    <div style={s.stepBody}>
      <div style={s.reviewCard}>
        <ReviewRow label="Label" value={wiz.label || fallbackLabel} />
        <ReviewRow label="Source" value={wiz.sourceType === 'airtable' ? 'Airtable' : 'Generic REST'} />
        {wiz.sourceType === 'airtable' && (
          <>
            <ReviewRow label="Base ID" value={wiz.baseId} />
            <ReviewRow label="Table" value={wiz.tableId} />
          </>
        )}
        {wiz.sourceType === 'generic_rest' && (
          <>
            <ReviewRow label="Base URL" value={wiz.baseUrl} />
            <ReviewRow label="Auth type" value={wiz.authType} />
            <ReviewRow label="Records path" value={wiz.recordsPath || '(root array)'} />
          </>
        )}
        <ReviewRow label="Fields mapped" value={`${mappedCount} / ${totalCount}`} />
        <ReviewRow label="Write-back" value={wiz.writeBackEnabled ? 'Enabled' : 'Disabled'} />
        <ReviewRow label="Min sync interval" value={intervalLabel(wiz.minSyncIntervalMs)} />
        {wiz.sourceType === 'airtable' && (
          <ReviewRow
            label="Sync signal"
            value={hasLastModified ? '⟳ lastModifiedTime field detected' : 'createdTime (fallback)'}
          />
        )}
      </div>
      <div style={s.hint}>
        Credentials are stored encrypted in this space's Matrix room state
        and are accessible to all members with access.
      </div>
      {wiz.stepError && <div style={s.errorMsg} role="alert">{wiz.stepError}</div>}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  return (
    <div style={s.reviewRow}>
      <span style={s.reviewLabel}>{label}</span>
      <span style={s.reviewValue}>{value}</span>
    </div>
  );
}

// ─── Wizard footer buttons ────────────────────────────────────────────────────

function WizardFooter({
  wiz,
  wizSet,
  onTest,
  onSave,
  onClose,
}: {
  wiz: WizardState;
  wizSet: (p: Partial<WizardState>) => void;
  onTest: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const canTest = wiz.sourceType === 'airtable'
    ? Boolean(wiz.apiKey.trim() && wiz.baseId.trim() && wiz.tableId.trim())
    : Boolean(wiz.baseUrl.trim());

  return (
    <div style={s.footerRow}>
      <button style={s.btnGhost} onClick={onClose}>
        Cancel
      </button>
      <div style={s.footerRight}>
        {wiz.step > 1 && (
          <button
            style={s.btnSecondary}
            onClick={() => wizSet({ step: (wiz.step - 1) as WizardStep, stepError: null })}
            disabled={wiz.stepLoading}
          >
            ← Back
          </button>
        )}
        {wiz.step === 1 && (
          <button
            style={canTest && !wiz.stepLoading ? s.btnPrimary : s.btnDisabled}
            onClick={onTest}
            disabled={!canTest || wiz.stepLoading}
          >
            {wiz.stepLoading ? 'Testing…' : 'Test & Continue →'}
          </button>
        )}
        {wiz.step === 2 && (
          <button
            style={s.btnPrimary}
            onClick={() => wizSet({ step: 3, stepError: null })}
          >
            Next →
          </button>
        )}
        {wiz.step === 3 && (
          <button
            style={wiz.stepLoading ? s.btnDisabled : s.btnPrimary}
            onClick={onSave}
            disabled={wiz.stepLoading}
          >
            {wiz.stepLoading ? 'Saving…' : '✓ Save Connection'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Data view ────────────────────────────────────────────────────────────────

function ApiDataView({
  config,
  onBack,
}: {
  config: ApiConnectionConfig;
  onBack: () => void;
}) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const {
    recordsCache,
    recordsLoading,
    errors,
    lastSyncAttemptAt,
    fetchRecords,
    fetchRecordsFull,
    updateRecord,
    deleteRecord,
    clearError,
    getSyncCooldownMs,
  } = useApiConnectionStore();

  const cache = recordsCache[config.connectionId];
  const loading = recordsLoading[config.connectionId] ?? false;
  const error = errors[config.connectionId] ?? '';

  // Cooldown countdown — recomputed every second while active
  const [cooldownMs, setCooldownMs] = useState(() => getSyncCooldownMs(config.connectionId));
  useEffect(() => {
    // Recompute whenever a sync attempt is recorded
    setCooldownMs(getSyncCooldownMs(config.connectionId));
  }, [lastSyncAttemptAt, config.connectionId, getSyncCooldownMs]);
  useEffect(() => {
    if (cooldownMs <= 0) return;
    const id = setInterval(() => {
      const remaining = getSyncCooldownMs(config.connectionId);
      setCooldownMs(remaining);
      if (remaining <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [cooldownMs > 0, config.connectionId, getSyncCooldownMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Record<string, unknown>>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Auto-fetch on mount if no cache
  useEffect(() => {
    if (!cache) {
      fetchRecords(config.connectionId);
    }
  }, [config.connectionId, cache, fetchRecords]);

  // Derive columns from field mappings (internalName values, in insertion order)
  const columns = useMemo(
    () => Object.values(config.fieldMappings).filter(Boolean),
    [config.fieldMappings],
  );

  // Build reverse mapping once
  const revMap = useMemo(
    () => reverseMapping(config.fieldMappings),
    [config.fieldMappings],
  );

  const startEdit = useCallback((record: { id: string; fields: Record<string, unknown> }) => {
    setEditingId(record.id);
    setEditDraft({ ...record.fields });
    setEditError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft({});
    setEditError(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    setEditLoading(true);
    setEditError(null);
    try {
      // Translate editDraft (internal names) back to remoteFieldIds
      const remoteFields: Record<string, unknown> = {};
      for (const [internalName, value] of Object.entries(editDraft)) {
        const remoteId = revMap[internalName];
        if (remoteId) remoteFields[remoteId] = value;
      }
      await updateRecord(config.connectionId, editingId, remoteFields, editDraft);
      setEditingId(null);
      setEditDraft({});
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setEditError(msg === 'NOT_SUPPORTED' ? 'This source does not support editing.' : msg);
    } finally {
      setEditLoading(false);
    }
  }, [editingId, editDraft, revMap, updateRecord, config.connectionId]);

  const confirmDelete = useCallback(async (recordId: string) => {
    setDeleteLoading(true);
    try {
      await deleteRecord(config.connectionId, recordId);
      setDeleteConfirmId(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Surface as an edit-area error
      setEditError(msg === 'NOT_SUPPORTED' ? 'This source does not support deletion.' : msg);
      setDeleteConfirmId(null);
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteRecord, config.connectionId]);

  const records = cache?.records ?? [];

  return (
    <div style={s.container}>
      {/* Header */}
      <div style={s.dataHeader}>
        <div style={s.breadcrumb}>
          <button style={s.btnGhost} onClick={onBack}>
            ← API Connections
          </button>
          <span style={s.breadcrumbSep}>/</span>
          <span style={s.breadcrumbCurrent}>{config.label}</span>
        </div>
        <div style={s.dataHeaderRight}>
          <span style={s.syncMeta}>
            {cache ? `${records.length} records · ${relativeTime(cache.loadedAt)}` : ''}
          </span>
          <button
            style={loading || cooldownMs > 0 ? s.btnDisabled : s.btnSecondary}
            disabled={loading || cooldownMs > 0}
            onClick={() => {
              clearError(config.connectionId);
              fetchRecordsFull(config.connectionId);
            }}
          >
            {loading
              ? 'Syncing…'
              : cooldownMs > 0
                ? `Sync in ${Math.ceil(cooldownMs / 1000)}s`
                : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={s.errorBanner} role="alert">
          {error}
          <button
            style={s.errorBannerRetry}
            onClick={() => {
              clearError(config.connectionId);
              fetchRecords(config.connectionId);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && records.length === 0 && (
        <div style={s.empty}>Loading records…</div>
      )}

      {/* Empty states — distinguish never-synced vs synced-empty vs failed.
          The blanket "No records found" used to hide silent persistence
          failures across multiple sync attempts. */}
      {!loading && !error && records.length === 0 && !config.lastSyncAt && (
        <div style={s.empty}>
          Not yet synced. Click <strong>Sync Now</strong> to fetch records from{' '}
          {config.credentials.sourceType === 'airtable' ? 'Airtable' : 'this source'}.
        </div>
      )}
      {!loading && !error && records.length === 0 && config.lastSyncAt && (
        <div style={s.empty}>
          Source returned 0 records. Last synced{' '}
          {new Date(config.lastSyncAt).toLocaleString()}.
        </div>
      )}

      {/* Table */}
      {records.length > 0 && (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
                <th style={{ ...s.th, width: 80 }}>Updated</th>
                <th style={{ ...s.th, width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {records.map((rec) => {
                const isEditing = editingId === rec.id;
                const isDeleteConfirm = deleteConfirmId === rec.id;
                return (
                  <tr key={rec.id} style={isEditing ? s.trEditing : s.tr}>
                    {columns.map((col) => (
                      <td key={col} style={s.td}>
                        {isEditing ? (
                          <input
                            style={s.cellInput}
                            value={String(editDraft[col] ?? '')}
                            onChange={(e) =>
                              setEditDraft((prev) => ({ ...prev, [col]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit();
                              if (e.key === 'Escape') cancelEdit();
                            }}
                          />
                        ) : (
                          <span
                            style={s.cellValue}
                            onClick={() => startEdit(rec)}
                            title="Click to edit"
                          >
                            {String(rec.fields[col] ?? '')}
                          </span>
                        )}
                      </td>
                    ))}
                    <td style={s.td}>
                      <span style={s.metaText}>{relativeTime(rec.lastModifiedAt)}</span>
                    </td>
                    <td style={s.tdActions}>
                      {isEditing ? (
                        <div style={s.editActions}>
                          <button
                            style={editLoading ? s.btnDisabled : s.btnPrimary}
                            onClick={saveEdit}
                            disabled={editLoading}
                          >
                            {editLoading ? '…' : '✓'}
                          </button>
                          <button style={s.btnGhost} onClick={cancelEdit}>✕</button>
                          {editError && (
                            <div style={s.inlineError} role="alert">{editError}</div>
                          )}
                        </div>
                      ) : isDeleteConfirm ? (
                        <div style={s.editActions}>
                          <button
                            style={deleteLoading ? s.btnDisabled : s.btnDanger}
                            onClick={() => confirmDelete(rec.id)}
                            disabled={deleteLoading}
                          >
                            {deleteLoading ? '…' : 'Delete'}
                          </button>
                          <button style={s.btnGhost} onClick={() => setDeleteConfirmId(null)}>
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          style={s.btnGhost}
                          onClick={() => setDeleteConfirmId(rec.id)}
                          title="Delete record"
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  const inputBase: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    fontSize: 13,
    color: t.text,
    background: t.bg,
    border: `1px solid ${t.border}`,
    borderRadius: 5,
    outline: 'none',
  };
  const btnBase: React.CSSProperties = {
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 500,
    border: 'none',
    borderRadius: 5,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
  return {
    container: {
      padding: '24px 28px',
      maxWidth: 860,
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: 24,
      gap: 16,
    },
    pageTitle: {
      fontSize: 18,
      fontWeight: 700,
      color: t.textHeading,
      marginBottom: 4,
    },
    pageSubtitle: {
      fontSize: 12,
      color: t.textMuted,
      maxWidth: 500,
    },
    empty: {
      padding: 24,
      color: t.textMuted,
      fontSize: 13,
    },
    emptyState: {
      padding: '60px 24px',
      textAlign: 'center',
    },
    emptyIcon: {
      fontSize: 40,
      marginBottom: 12,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: 600,
      color: t.textHeading,
      marginBottom: 6,
    },
    emptySub: {
      fontSize: 13,
      color: t.textMuted,
      marginBottom: 20,
    },
    card: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '14px 16px',
      border: `1px solid ${t.border}`,
      borderRadius: 7,
      marginBottom: 10,
      background: t.bgCard,
      gap: 12,
    },
    cardLeft: {
      flex: 1,
      minWidth: 0,
    },
    cardTitle: {
      fontSize: 14,
      fontWeight: 600,
      color: t.textHeading,
      marginBottom: 4,
    },
    cardMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 2,
    },
    cardSub: {
      fontSize: 11,
      color: t.textMuted,
    },
    cardActions: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexShrink: 0,
    },
    pill: {
      fontSize: 10,
      fontWeight: 600,
      padding: '2px 7px',
      borderRadius: 10,
      background: t.accentBg,
      color: t.accent,
      border: `1px solid ${t.accentBorder}`,
    },
    deleteConfirmText: {
      fontSize: 12,
      color: t.danger,
    },

    // Wizard
    stepBar: {
      display: 'flex',
      alignItems: 'center',
      marginBottom: 20,
      position: 'relative' as const,
    },
    stepItem: {
      display: 'flex',
      alignItems: 'center',
    },
    stepDot: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      background: t.bgMuted,
      color: t.textMuted,
      fontSize: 11,
      fontWeight: 700,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: `1px solid ${t.border}`,
      flexShrink: 0,
    },
    stepDotActive: {
      background: t.accent,
      color: '#fff',
      border: `1px solid ${t.accent}`,
    },
    stepLine: {
      width: 40,
      height: 2,
      background: t.border,
      margin: '0 4px',
    },
    stepLineActive: {
      background: t.accent,
    },
    stepLabels: {
      position: 'absolute' as const,
      top: 28,
      left: 0,
      display: 'flex',
      gap: 48,
      fontSize: 10,
      color: t.textMuted,
    },
    stepLabel: {
      color: t.textMuted,
    },
    stepLabelActive: {
      color: t.accent,
      fontWeight: 600,
    },
    stepBody: {
      paddingTop: 24,
    },
    fieldGroup: {
      marginBottom: 14,
    },
    label: {
      display: 'block',
      fontSize: 12,
      fontWeight: 500,
      color: t.textSecondary,
      marginBottom: 5,
    },
    input: inputBase,
    hint: {
      fontSize: 11,
      color: t.textMuted,
      marginTop: 4,
    },
    radioGroup: {
      display: 'flex',
      gap: 16,
    },
    radioLabel: {
      fontSize: 13,
      color: t.text,
      cursor: 'pointer',
    },
    radioDisabled: {
      color: t.textMuted,
      cursor: 'default',
    },
    errorMsg: {
      marginTop: 8,
      padding: '8px 12px',
      background: t.dangerBg,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 5,
      fontSize: 12,
      color: t.dangerText,
    },
    successMsg: {
      marginTop: 8,
      padding: '8px 12px',
      background: t.successBg,
      border: `1px solid ${t.successBorder}`,
      borderRadius: 5,
      fontSize: 12,
      color: t.successText,
    },

    // Step 2 — field map
    mapHeader: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 8,
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.4px',
      padding: '0 2px 6px',
      borderBottom: `1px solid ${t.border}`,
    },
    mapCol: {},
    mapRows: {
      maxHeight: 320,
      overflowY: 'auto' as const,
      marginBottom: 12,
    },
    mapRow: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 8,
      padding: '6px 2px',
      borderBottom: `1px solid ${t.borderLight}`,
      alignItems: 'center',
    },
    mapSourceCell: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      minWidth: 0,
    },
    mapFieldName: {
      fontSize: 12,
      color: t.text,
      flexShrink: 0,
    },
    typePill: {
      fontSize: 10,
      padding: '1px 5px',
      borderRadius: 8,
      background: t.bgMuted,
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      flexShrink: 0,
    },
    syncBadge: {
      fontSize: 10,
      padding: '1px 5px',
      borderRadius: 8,
      background: t.tealBg,
      color: t.teal,
      border: `1px solid ${t.tealBorder}`,
      flexShrink: 0,
    },
    mapInternalCell: {},
    mapInput: {
      ...inputBase,
      padding: '4px 8px',
      fontSize: 12,
    },
    toggleRow: {
      paddingTop: 8,
      borderTop: `1px solid ${t.border}`,
    },
    toggleLabel: {
      fontSize: 12,
      color: t.text,
      cursor: 'pointer',
    },

    // Step 3 — review
    reviewCard: {
      border: `1px solid ${t.border}`,
      borderRadius: 7,
      overflow: 'hidden',
      marginBottom: 14,
    },
    reviewRow: {
      display: 'flex',
      padding: '9px 14px',
      borderBottom: `1px solid ${t.borderLight}`,
      fontSize: 13,
    },
    reviewLabel: {
      width: 120,
      color: t.textMuted,
      fontWeight: 500,
      flexShrink: 0,
    },
    reviewValue: {
      color: t.text,
    },

    // Footer
    footerRow: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    footerRight: {
      display: 'flex',
      gap: 8,
    },

    // Buttons
    btnPrimary: {
      ...btnBase,
      background: t.accent,
      color: '#fff',
    },
    btnSecondary: {
      ...btnBase,
      background: t.bgMuted,
      color: t.text,
      border: `1px solid ${t.border}`,
    },
    btnGhost: {
      ...btnBase,
      background: 'transparent',
      color: t.textSecondary,
      border: 'none',
    },
    btnDanger: {
      ...btnBase,
      background: t.dangerBg,
      color: t.dangerText,
      border: `1px solid ${t.dangerBorder}`,
    },
    btnDisabled: {
      ...btnBase,
      background: t.bgMuted,
      color: t.textMuted,
      cursor: 'not-allowed',
    },

    // Data view
    dataHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 16,
      gap: 12,
    },
    breadcrumb: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    breadcrumbSep: {
      color: t.textMuted,
      fontSize: 12,
    },
    breadcrumbCurrent: {
      fontSize: 14,
      fontWeight: 600,
      color: t.textHeading,
    },
    dataHeaderRight: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    },
    syncMeta: {
      fontSize: 11,
      color: t.textMuted,
    },
    errorBanner: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 14px',
      background: t.dangerBg,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 6,
      fontSize: 13,
      color: t.dangerText,
      marginBottom: 14,
    },
    errorBannerRetry: {
      marginLeft: 'auto',
      fontSize: 12,
      fontWeight: 600,
      background: 'none',
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 4,
      color: t.dangerText,
      cursor: 'pointer',
      padding: '3px 10px',
    },
    tableWrap: {
      overflowX: 'auto' as const,
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse' as const,
      fontSize: 13,
    },
    th: {
      textAlign: 'left' as const,
      padding: '7px 10px',
      borderBottom: `1px solid ${t.border}`,
      fontSize: 11,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.3px',
      background: t.bgCard,
      whiteSpace: 'nowrap' as const,
    },
    tr: {
      borderBottom: `1px solid ${t.borderLight}`,
    },
    trEditing: {
      borderBottom: `1px solid ${t.accentBorder}`,
      background: t.accentBg,
    },
    td: {
      padding: '7px 10px',
      verticalAlign: 'top' as const,
    },
    tdActions: {
      padding: '7px 10px',
      verticalAlign: 'middle' as const,
      textAlign: 'right' as const,
    },
    cellValue: {
      cursor: 'pointer',
      color: t.text,
      display: 'block',
      maxWidth: 200,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    cellInput: {
      ...inputBase,
      padding: '3px 7px',
      fontSize: 12,
    },
    metaText: {
      fontSize: 11,
      color: t.textMuted,
    },
    editActions: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      justifyContent: 'flex-end',
      flexWrap: 'wrap' as const,
    },
    inlineError: {
      width: '100%',
      fontSize: 11,
      color: t.dangerText,
      marginTop: 2,
    },
  };
}
