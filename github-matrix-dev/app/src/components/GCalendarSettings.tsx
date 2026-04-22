/**
 * Google Calendar settings panel section — shown inside SettingsView.
 *
 * Lets the user refresh the list of accessible calendars, pick an active
 * one, trigger a sync, and see the last-sync timestamp. Connection state
 * is shared with the Google Drive section because both APIs use the same
 * OAuth token.
 */

import { useState } from 'react';
import { useTheme, type Theme } from '../theme';
import { useGCalendarStore } from '../google-calendar/gcalendar-store';
import { useGDriveStore } from '../google-drive/gdrive-store';
import { pullCalendarEvents, scopeForCalendar } from '../google-calendar/gcalendar-sync';
import { startOAuthFlow, isGoogleOAuthConfigured } from '../google-calendar/gcalendar-oauth';

export function GCalendarSettingsSection() {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // Share connection state with Drive (same OAuth token).
  const gdriveToken = useGDriveStore((st) => st.googleAccessToken);
  const gdriveSyncMode = useGDriveStore((st) => st.syncMode);

  const calendars = useGCalendarStore((st) => st.calendars);
  const activeCalendarId = useGCalendarStore((st) => st.activeCalendarId);
  const setActiveCalendar = useGCalendarStore((st) => st.setActiveCalendar);
  const refreshCalendarList = useGCalendarStore((st) => st.refreshCalendarList);
  const lastSyncAt = useGCalendarStore((st) => st.lastSyncAt);
  const syncing = useGCalendarStore((st) => st.syncing);
  const error = useGCalendarStore((st) => st.error);
  const writableCalendars = useGCalendarStore((st) => st.writableCalendars);
  const needsReauth = useGCalendarStore((st) => st.needsReauth);

  const [busy, setBusy] = useState<'list' | 'sync' | null>(null);

  const connected = !!gdriveToken;
  const oauthMode = gdriveSyncMode === 'oauth';
  const oauthConfigured = isGoogleOAuthConfigured();
  const activeWritable = activeCalendarId
    ? writableCalendars.has(activeCalendarId)
    : false;

  const handleSignIn = async () => {
    try {
      await startOAuthFlow();
      await refreshCalendarList();
    } catch (e) {
      console.warn('[GCalendar] sign-in failed:', e);
    }
  };

  const handleRefresh = async () => {
    setBusy('list');
    try {
      await refreshCalendarList();
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    if (!activeCalendarId) return;
    setBusy('sync');
    try {
      await pullCalendarEvents(activeCalendarId);
    } catch (e) {
      console.warn('[GCalendar] sync failed:', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={s.container}>
      {!oauthMode && (
        <div style={s.warning}>
          Google Calendar requires OAuth sync mode. Switch Drive Sync Mode to
          "Google OAuth" above to enable this section.
        </div>
      )}

      {oauthMode && !oauthConfigured && (
        <div style={s.warning}>
          Google OAuth is not configured for this build (missing
          <code style={{ margin: '0 4px' }}>VITE_GOOGLE_CLIENT_ID</code>).
          Calendar sign-in is disabled.
        </div>
      )}

      {oauthMode && oauthConfigured && !connected && (
        <div style={s.row}>
          <button style={s.primaryBtn} onClick={handleSignIn}>
            Sign in with Google
          </button>
          <span style={s.help}>
            Grants access to Drive + Calendar scopes.
          </span>
        </div>
      )}

      {oauthMode && needsReauth && (
        <div style={s.warning}>
          Your Google session is missing the Calendar scope. Click "Sign in
          with Google" above to re-authenticate.
        </div>
      )}

      {oauthMode && connected && (
        <>
          <div style={s.row}>
            <button
              style={s.secondaryBtn}
              onClick={handleRefresh}
              disabled={busy === 'list'}
            >
              {busy === 'list' ? 'Loading…' : 'Refresh calendar list'}
            </button>
            <span style={s.help}>
              {calendars.length === 0
                ? 'No calendars loaded yet.'
                : `${calendars.length} calendar${calendars.length === 1 ? '' : 's'} found.`}
            </span>
          </div>

          {calendars.length > 0 && (
            <div style={s.row}>
              <label style={s.label}>Active calendar</label>
              <select
                style={s.select}
                value={activeCalendarId ?? ''}
                onChange={(e) => setActiveCalendar(e.target.value || null)}
              >
                <option value="">— select —</option>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.summary}{c.primary ? ' (primary)' : ''}{c.accessRole === 'reader' ? ' [read-only]' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {activeCalendarId && (
            <>
              <div style={s.row}>
                <button
                  style={s.primaryBtn}
                  onClick={handleSync}
                  disabled={busy === 'sync' || syncing}
                >
                  {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <span style={s.help}>
                  {lastSyncAt[activeCalendarId]
                    ? `Last sync: ${formatRelative(lastSyncAt[activeCalendarId])}`
                    : 'Never synced.'}
                </span>
              </div>

              <div style={s.meta}>
                <div>
                  <span style={s.metaLabel}>EO-DB scope:</span>{' '}
                  <code style={s.code}>{scopeForCalendar(activeCalendarId)}</code>
                </div>
                <div>
                  <span style={s.metaLabel}>Write access:</span>{' '}
                  <span style={activeWritable ? s.badgeOk : s.badgeMuted}>
                    {activeWritable ? 'Writable' : 'Read-only'}
                  </span>
                </div>
              </div>
            </>
          )}

          {error && (
            <div style={s.error}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const diffMs = Date.now() - then;
    if (diffMs < 60_000) return 'just now';
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
    },
    label: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      minWidth: 110,
    },
    select: {
      flex: 1,
      minWidth: 180,
      padding: '6px 8px',
      fontSize: 12,
      background: t.bgCard,
      color: t.text,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
    },
    primaryBtn: {
      padding: '6px 14px',
      fontSize: 12,
      fontWeight: 600,
      color: '#fff',
      background: t.accent,
      border: `1px solid ${t.accent}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
    secondaryBtn: {
      padding: '6px 14px',
      fontSize: 12,
      color: t.text,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
    },
    help: {
      fontSize: 11,
      color: t.textMuted,
    },
    warning: {
      padding: '8px 12px',
      background: t.warningBg,
      color: t.warningText,
      border: `1px solid ${t.warningBorder}`,
      borderRadius: 4,
      fontSize: 12,
    },
    error: {
      padding: '8px 12px',
      background: t.dangerBg,
      color: t.dangerText,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 4,
      fontSize: 12,
    },
    meta: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '8px 12px',
      background: t.bgMuted,
      border: `1px solid ${t.borderLight}`,
      borderRadius: 4,
      fontSize: 11,
    },
    metaLabel: {
      color: t.textMuted,
      fontWeight: 600,
    },
    code: {
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      fontSize: 11,
    },
    badgeOk: {
      display: 'inline-block',
      padding: '1px 6px',
      fontSize: 10,
      fontWeight: 600,
      color: t.successText,
      background: t.successBg,
      border: `1px solid ${t.successBorder}`,
      borderRadius: 3,
    },
    badgeMuted: {
      display: 'inline-block',
      padding: '1px 6px',
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      background: t.bgCard,
      border: `1px solid ${t.borderLight}`,
      borderRadius: 3,
    },
  };
}
