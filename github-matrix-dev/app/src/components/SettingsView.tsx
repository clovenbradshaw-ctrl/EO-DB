import { useState, useEffect } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { MatrixSession } from '../matrix/client';

interface SettingsViewProps {
  session: MatrixSession;
}

export function SettingsView({ session }: SettingsViewProps) {
  const { theme } = useTheme();
  const lastSeq = useEoStore((s) => s.lastSeq);
  const recentEvents = useEoStore((s) => s.recentEvents);
  const store = useEoStore((s) => s.store);
  const syncManager = useEoStore((s) => s.syncManager);
  const manualSnapshot = useEoStore((s) => s.manualSnapshot);
  const s = styles(theme);

  const [eventCount, setEventCount] = useState<number | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteError, setDeleteError] = useState('');

  // Airtable keys
  const [atLabel, setAtLabel] = useState('');
  const [atToken, setAtToken] = useState('');
  const [atShared, setAtShared] = useState(true);
  const [atKeys, setAtKeys] = useState<Array<{ label: string; shared: boolean; lastSync?: string }>>([]);
  const [atError, setAtError] = useState('');

  // Hydration sources
  const [hydLabel, setHydLabel] = useState('');
  const [hydEndpoint, setHydEndpoint] = useState('');
  const [hydApiKey, setHydApiKey] = useState('');
  const [hydSources, setHydSources] = useState<Array<{ label: string; endpoint: string }>>([]);

  useEffect(() => {
    setEventCount(recentEvents.length);
  }, [recentEvents]);

  async function handleSnapshot() {
    setSnapshotStatus('Taking snapshot...');
    try {
      const result = await manualSnapshot();
      setSnapshotStatus(`Snapshot saved — seq ${result.seq}`);
    } catch (e: any) {
      setSnapshotStatus(`Error: ${e.message}`);
    }
  }

  async function handleDeleteAll() {
    if (deleteConfirm !== 'DELETE') {
      setDeleteError('Type DELETE to confirm');
      return;
    }
    try {
      const { teardown } = useEoStore.getState();
      teardown();
      setDeleteError('');
      setDeleteConfirm('');
      window.location.reload();
    } catch (e: any) {
      setDeleteError(e.message);
    }
  }

  function handleSaveAtKey() {
    if (!atLabel || !atToken) {
      setAtError('Label and token are required');
      return;
    }
    const newKey = { label: atLabel, shared: atShared };
    setAtKeys([...atKeys, newKey]);
    // Store in localStorage for persistence
    const stored = JSON.parse(localStorage.getItem('eo-at-keys') || '[]');
    stored.push({ label: atLabel, token: atToken, shared: atShared });
    localStorage.setItem('eo-at-keys', JSON.stringify(stored));
    setAtLabel('');
    setAtToken('');
    setAtError('');
  }

  useEffect(() => {
    const stored = JSON.parse(localStorage.getItem('eo-at-keys') || '[]');
    setAtKeys(stored.map((k: any) => ({ label: k.label, shared: k.shared, lastSync: k.lastSync })));
    const storedHyd = JSON.parse(localStorage.getItem('eo-hyd-sources') || '[]');
    setHydSources(storedHyd);
  }, []);

  function handleAddHydSource() {
    if (!hydLabel || !hydEndpoint) return;
    const newSources = [...hydSources, { label: hydLabel, endpoint: hydEndpoint }];
    setHydSources(newSources);
    localStorage.setItem('eo-hyd-sources', JSON.stringify(newSources));
    setHydLabel('');
    setHydEndpoint('');
    setHydApiKey('');
  }

  function removeAtKey(i: number) {
    const stored = JSON.parse(localStorage.getItem('eo-at-keys') || '[]');
    stored.splice(i, 1);
    localStorage.setItem('eo-at-keys', JSON.stringify(stored));
    setAtKeys(stored.map((k: any) => ({ label: k.label, shared: k.shared })));
  }

  function removeHydSource(i: number) {
    const next = hydSources.filter((_, j) => j !== i);
    setHydSources(next);
    localStorage.setItem('eo-hyd-sources', JSON.stringify(next));
  }

  const displayName = session.userId.startsWith('@')
    ? session.userId.slice(1).split(':')[0]
    : session.userId;
  const homeserver = session.userId.includes(':')
    ? session.userId.split(':')[1]
    : 'unknown';

  return (
    <div style={s.container}>
      <div style={s.form}>
        {/* Current Session */}
        <Section title="Current Session" theme={theme}>
          <Field label="User" value={displayName} theme={theme} />
          <Field label="User ID" value={session.userId} theme={theme} />
          <Field label="Homeserver" value={homeserver} theme={theme} />
          <Field label="Device ID" value={session.deviceId} theme={theme} />
        </Section>

        {/* Local Storage */}
        <Section title="Local Storage (IndexedDB)" theme={theme}>
          <Field label="Events" value={String(eventCount ?? '—')} theme={theme} />
          <Field label="Current Seq" value={String(lastSeq)} theme={theme} />
          <Field label="Architecture" value="Browser-native (no server)" theme={theme} />
        </Section>

        {/* Sync & Snapshots */}
        <Section title="Sync & Snapshots" theme={theme}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{
              width: 6, height: 6, borderRadius: '50%',
              background: syncManager ? '#22c55e' : theme.textMuted,
              boxShadow: syncManager ? '0 0 6px #22c55e' : 'none',
            }} />
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: theme.text }}>
              Matrix sync: {syncManager ? 'connected' : 'offline'}
            </span>
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button style={s.actionBtn} onClick={handleSnapshot} disabled={!syncManager}>
              Take Snapshot
            </button>
            {snapshotStatus && (
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: snapshotStatus.startsWith('Error') ? theme.danger : theme.success }}>
                {snapshotStatus}
              </span>
            )}
          </div>
        </Section>

        {/* Hydration Sources */}
        <Section title="Hydration Sources" theme={theme}>
          {hydSources.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {hydSources.map((src, i) => (
                <div key={i} style={s.keyRow}>
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: theme.text }}>{src.label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: theme.textMuted }}>{src.endpoint}</div>
                  </div>
                  <button style={s.removeBtn} onClick={() => removeHydSource(i)}>Remove</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
            <input style={s.input} value={hydLabel} onChange={(e) => setHydLabel(e.target.value)} placeholder="Label (e.g. Cloudflare R2)" />
            <input style={s.input} value={hydEndpoint} onChange={(e) => setHydEndpoint(e.target.value)} placeholder="Endpoint URL" />
            <input style={s.input} type="password" value={hydApiKey} onChange={(e) => setHydApiKey(e.target.value)} placeholder="API key (optional)" />
            <button style={s.actionBtn} onClick={handleAddHydSource}>Add Source</button>
          </div>
        </Section>

        {/* Airtable Integration */}
        <Section title="Airtable Integration" theme={theme}>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 12 }}>
            <input style={s.input} value={atLabel} onChange={(e) => setAtLabel(e.target.value)} placeholder="Label (e.g. immigration-base)" />
            <input style={s.input} type="password" value={atToken} onChange={(e) => setAtToken(e.target.value)} placeholder="Airtable Personal Access Token" />
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textSecondary, cursor: 'pointer' }}>
                <input type="checkbox" checked={atShared} onChange={(e) => setAtShared(e.target.checked)} /> Share with org
              </label>
              <button style={s.actionBtn} onClick={handleSaveAtKey}>Save Key</button>
            </div>
            {atError && <div style={{ color: theme.danger, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>{atError}</div>}
          </div>
          {atKeys.map((k, i) => (
            <div key={i} style={s.keyRow}>
              <div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: theme.text }}>{k.label}</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: theme.textMuted }}>
                  {k.shared ? 'shared' : 'private'}{k.lastSync ? ` · last sync ${k.lastSync}` : ''}
                </div>
              </div>
              <button style={s.removeBtn} onClick={() => removeAtKey(i)}>Remove</button>
            </div>
          ))}
        </Section>

        {/* Danger Zone */}
        <Section title="Danger Zone" theme={theme} danger>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
            <div style={{ fontSize: 11, color: theme.textSecondary }}>
              Permanently erase all events, state, and graph data from IndexedDB.
            </div>
            <input
              style={s.input}
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder='Type "DELETE" to confirm'
            />
            <button
              style={{ ...s.actionBtn, background: theme.danger, borderColor: theme.danger, color: '#fff' }}
              onClick={handleDeleteAll}
            >
              Erase Database
            </button>
            {deleteError && <div style={{ color: theme.danger, fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>{deleteError}</div>}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children, theme, danger }: { title: string; children: React.ReactNode; theme: Theme; danger?: boolean }) {
  return (
    <div style={{
      padding: '16px 0',
      borderBottom: `1px solid ${theme.border}`,
    }}>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase' as const,
        letterSpacing: '0.08em',
        color: danger ? theme.danger : theme.textMuted,
        marginBottom: 12,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, theme }: { label: string; value: string; theme: Theme }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.textMuted }}>{label}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: theme.text }}>{value}</span>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '8px 16px 40px',
    },
    form: {
      width: '100%',
      maxWidth: 560,
    },
    input: {
      width: '100%',
      padding: '8px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      outline: 'none',
    },
    actionBtn: {
      padding: '6px 14px',
      background: t.accent,
      color: '#fff',
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
    removeBtn: {
      padding: '3px 10px',
      background: 'transparent',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.danger,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      fontWeight: 600,
      cursor: 'pointer',
    },
    keyRow: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '8px 0',
      borderBottom: `1px solid ${t.borderLight}`,
    },
  };
}
