/**
 * FilenAdminConfig — Admin panel for setting up shared Filen cloud storage.
 *
 * The admin enters Filen credentials once. On save, this component:
 * 1. Logs into Filen (filenLogin)
 * 2. Ensures the /EO-DB/ folder exists
 * 3. Stores the config as a Matrix room state event (eo.filen.config)
 *
 * All other clients read this state event on room join and auto-connect
 * to Filen silently — users never see a Filen login screen.
 *
 * Only users with sufficient power level can set the state event.
 */

import { useState, useEffect } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme, type Theme } from '../theme';
import {
  filenLogin,
  filenGetBaseFolder,
  filenEnsureFolder,
} from '../filen/filen-api';

const EO_FILEN_CONFIG = 'eo.filen.config';

interface FilenAdminConfigProps {
  matrixClient: MatrixClient;
  roomId: string;
}

interface ExistingConfig {
  email: string;
  apiKey: string;
  masterKey: string;
  baseFolderUuid: string;
  eodbFolderUuid: string;
  saved_at?: string;
  saved_by?: string;
}

export function FilenAdminConfig({ matrixClient, roomId }: FilenAdminConfigProps) {
  const { theme } = useTheme();
  const s = styles(theme);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [existing, setExisting] = useState<ExistingConfig | null>(null);
  const [canAdmin, setCanAdmin] = useState(false);
  const [filenStatus, setFilenStatus] = useState<'checking' | 'connected' | 'expired' | 'none'>('checking');
  const [editing, setEditing] = useState(false);
  const [memberCount, setMemberCount] = useState(0);

  // Check existing config, permissions, and live Filen status
  useEffect(() => {
    const room = matrixClient.getRoom(roomId);
    if (!room) return;

    // Check power level
    const userId = matrixClient.getUserId();
    if (userId) {
      const canSet = room.currentState.maySendStateEvent(EO_FILEN_CONFIG, userId);
      setCanAdmin(canSet);
    }

    // Count room members (everyone affected by credential changes)
    try {
      setMemberCount(room.getJoinedMembers().length);
    } catch { /* ignore */ }

    // Read existing config
    const event = room.currentState.getStateEvents(EO_FILEN_CONFIG as any, '');
    if (event) {
      const content = (event as any).getContent?.() ?? event;
      if (content.apiKey) {
        setExisting(content as ExistingConfig);
        setEmail(content.email || '');

        // Verify Filen session is still valid
        fetch('https://gateway.filen.io/v3/user/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${content.apiKey}` },
          body: '{}',
        })
          .then(r => r.json())
          .then(d => setFilenStatus(d.status ? 'connected' : 'expired'))
          .catch(() => setFilenStatus('expired'));
      } else {
        setFilenStatus('none');
      }
    } else {
      setFilenStatus('none');
    }
  }, [matrixClient, roomId]);

  async function handleSave() {
    if (!email || !password) {
      setError('Email and password are required');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      // 1. Login to Filen
      const result = await filenLogin(email, password);

      // 2. Ensure /EO-DB/ folder exists
      const baseFolderUuid = await filenGetBaseFolder(result.apiKey);
      const eodbFolderUuid = await filenEnsureFolder(
        result.apiKey, baseFolderUuid, 'EO-DB', result.masterKeys,
      );

      // 3. Store as room state event
      const config: ExistingConfig = {
        email,
        apiKey: result.apiKey,
        masterKey: result.masterKeys[0],
        baseFolderUuid,
        eodbFolderUuid,
        saved_at: new Date().toISOString(),
        saved_by: matrixClient.getUserId() || undefined,
      };

      await matrixClient.sendStateEvent(roomId, EO_FILEN_CONFIG as any, config, '');

      setExisting(config);
      setPassword('');
      setSuccess('Filen config saved to room state. All clients will auto-connect.');
    } catch (e: any) {
      setError(e.message || 'Failed to save Filen config');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    setError('');
    try {
      await matrixClient.sendStateEvent(roomId, EO_FILEN_CONFIG as any, {}, '');
      setExisting(null);
      setEmail('');
      setSuccess('Filen config removed.');
    } catch (e: any) {
      setError(e.message || 'Failed to remove config');
    } finally {
      setSaving(false);
    }
  }

  const statusColor = filenStatus === 'connected' ? theme.success
    : filenStatus === 'expired' ? theme.warning
    : theme.textMuted;
  const statusLabel = filenStatus === 'connected' ? 'Connected'
    : filenStatus === 'expired' ? 'Session expired'
    : filenStatus === 'checking' ? 'Checking...'
    : 'Not configured';

  if (!canAdmin) {
    return (
      <div style={s.container}>
        <div style={s.statusRow}>
          <div style={{ ...s.dot, background: statusColor }} />
          <span style={s.statusText}>
            Filen: {statusLabel}
            {existing ? ` (${existing.email})` : ''}
          </span>
        </div>
        {!existing && (
          <div style={s.hint}>An admin needs to configure shared Filen storage for this space.</div>
        )}
      </div>
    );
  }

  const showForm = !existing || editing;

  return (
    <div style={s.container}>
      {/* Live status */}
      <div style={s.statusRow}>
        <div style={{ ...s.dot, background: statusColor,
          boxShadow: filenStatus === 'connected' ? `0 0 6px ${theme.success}` : 'none' }} />
        <span style={s.statusText}>
          Filen: {statusLabel}
          {existing ? ` — ${existing.email}` : ''}
        </span>
      </div>

      {existing && !editing && (
        <>
          <div style={s.meta}>
            {existing.saved_at && (
              <span>Configured {new Date(existing.saved_at).toLocaleDateString()}</span>
            )}
            {existing.saved_by && <span> by {existing.saved_by}</span>}
          </div>
          {filenStatus === 'expired' && (
            <div style={s.warning}>
              API key expired. Update credentials to restore cloud storage for all users.
            </div>
          )}
          <div style={s.row}>
            <button style={s.btnSecondary} onClick={() => setEditing(true)} disabled={saving}>
              Change Login
            </button>
            <button style={s.btnDanger} onClick={handleRemove} disabled={saving}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {showForm && (
        <>
          <div style={s.warning}>
            {memberCount > 1
              ? `Changing credentials affects all ${memberCount} members of this room.`
              : 'These credentials will be shared with all room members.'}
            {' '}Stored in an E2EE room state event.
          </div>
          <label style={s.label}>Filen Email</label>
          <input
            style={s.input}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            disabled={saving}
          />
          <label style={s.label}>Filen Password</label>
          <input
            style={s.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Filen password"
            disabled={saving}
          />
          <div style={s.row}>
            <button style={s.btnPrimary} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : existing ? 'Update & Save' : 'Connect & Save'}
            </button>
            {editing && (
              <button style={s.btnSecondary} onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {error && <div style={s.error}>{error}</div>}
      {success && <div style={s.success}>{success}</div>}
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    statusRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      flexShrink: 0,
    },
    statusText: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.text,
    },
    meta: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
    },
    hint: {
      fontSize: 11,
      color: t.textSecondary,
      lineHeight: 1.4,
    },
    label: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
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
    row: {
      display: 'flex',
      gap: 8,
      marginTop: 4,
    },
    btnPrimary: {
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
    btnSecondary: {
      padding: '6px 14px',
      background: 'transparent',
      color: t.accent,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
    btnDanger: {
      padding: '6px 14px',
      background: t.danger,
      color: '#fff',
      border: `1px solid ${t.danger}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
    },
    warning: {
      fontSize: 11,
      color: t.warning,
      lineHeight: 1.4,
      padding: '6px 10px',
      background: `${t.warning}11`,
      border: `1px solid ${t.warning}33`,
      borderRadius: 4,
    },
    error: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.danger,
      marginTop: 4,
    },
    success: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.success,
      marginTop: 4,
    },
  };
}
