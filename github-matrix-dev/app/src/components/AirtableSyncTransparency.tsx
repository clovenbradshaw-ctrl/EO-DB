/**
 * Airtable sync transparency panel.
 *
 * One self-contained surface that exposes everything the user needs to
 * answer "is the sync working, and what is it doing?" without having to
 * open devtools. Reads from `useAirtableStore` and re-renders on every
 * tick — no internal state of its own.
 *
 * The four panels mirror the design the user signed off on:
 *   1. Header strip — running dot, cycle counter, last method, last sync ago,
 *      "run test sync" + "pause" buttons.
 *   2. Webhook health — last /payloads URL, HTTP status, cursor, polled-ago.
 *   3. Recent changes — per-record before/after diffs from update sync.
 *   4. Sync log — rolling 30-row panel of every entry in the syncLog ring.
 *
 * Most of the data (syncLog, currentSync, lastSyncResult) was already
 * being captured before this component existed. The store additions in
 * this branch (cyclesThisSession, webhookHealth, recentChanges) plug the
 * remaining gaps so every box on the mock has a real source of truth.
 */

import { useMemo } from 'react';
import { useAirtableStore } from '../ingestion/airtable-store';
import type { SyncLogEntry, RecentChange, WebhookHealth } from '../ingestion/airtable-store';
import type { Theme } from '../theme';

interface Props {
  theme: Theme;
  /** Re-renders every second from the parent's ticking clock — drives "ago" labels. */
  nowMs: number;
  /** Run a single Update Sync cycle right now (header strip "run test sync" button). */
  onRunTestSync: () => void;
  /** Toggle the continuous-sync timer (header strip "pause/resume" button). */
  onTogglePause: () => void;
  /** Whether continuous sync can be toggled (false when matrix client missing). */
  canToggleContinuous: boolean;
}

// ─── Time helpers ───────────────────────────────────────────────────────────

function formatAgo(ts: number | null, nowMs: number): string {
  if (ts == null) return '—';
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function isoToAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? formatAgo(t, nowMs) : '—';
}

function timeOfDay(ts: number | null): string {
  if (ts == null) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function isoToTimeOfDay(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? timeOfDay(t) : '—';
}

function shortenUrl(url: string | null): string {
  if (!url) return '—';
  try {
    const u = new URL(url);
    // Strip the protocol + drop noisy query params for readability.
    const trimmedPath = u.pathname.length > 80 ? u.pathname.slice(0, 77) + '…' : u.pathname;
    return `${u.host}${trimmedPath}`;
  } catch {
    return url.slice(0, 90);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  } catch {
    return String(v);
  }
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function HeaderStrip({
  theme, nowMs, onRunTestSync, onTogglePause, canToggleContinuous,
}: Props) {
  const continuousEnabled = useAirtableStore((s) => s.continuousSyncEnabled);
  const isSyncing = useAirtableStore((s) => s.isSyncing);
  const cycles = useAirtableStore((s) => s.cyclesThisSession);
  const lastSyncAt = useAirtableStore((s) => s.lastSyncAt);
  const lastSyncResult = useAirtableStore((s) => s.lastSyncResult);
  const syncLog = useAirtableStore((s) => s.syncLog);
  const currentSync = useAirtableStore((s) => s.currentSync);

  // "running" = continuous loop is on OR a one-shot sync is in flight.
  const running = continuousEnabled || isSyncing;

  // "records changed" = ingested + overwritten of last completed run.
  const recordsChanged = lastSyncResult
    ? lastSyncResult.total_records_ingested + lastSyncResult.total_records_overwritten
    : 0;

  // "last sync method" — derive from currentSync (in-flight) → log → fallback.
  const lastMethod = useMemo(() => {
    if (currentSync) {
      // strategy on currentSync is `'hydration' | 'lastModified'`. Use the
      // endpoint URL to disambiguate webhook vs filterByFormula (both share
      // the 'lastModified' strategy label).
      if (currentSync.endpoint?.includes('/webhooks/')) return 'webhook';
      if (currentSync.strategy === 'hydration') return 'full';
      return 'filter';
    }
    const last = syncLog.find((e) => e.type === 'webhook_poll' || e.type === 'sync_complete' || e.type === 'hydration_complete');
    if (!last) return '—';
    if (last.type === 'hydration_complete') return 'full';
    if (last.endpoint?.includes('/webhooks/')) return 'webhook';
    return 'filter';
  }, [currentSync, syncLog]);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      flexWrap: 'wrap',
      padding: '10px 14px',
      border: `1px solid ${theme.borderLight}`,
      borderRadius: 8,
      background: theme.bgCard,
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: running ? theme.success : theme.textMuted,
          boxShadow: running ? `0 0 0 3px ${theme.successBg}` : 'none',
        }} />
        <span style={{ fontWeight: 600, fontSize: 13, color: theme.textHeading }}>Airtable sync</span>
        <span style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: running ? theme.successText : theme.textMuted,
          background: running ? theme.successBg : theme.bgMuted,
          padding: '2px 7px',
          borderRadius: 10,
          border: `1px solid ${running ? theme.successBorder : theme.borderLight}`,
        }}>{running ? (isSyncing ? 'syncing' : 'running') : 'paused'}</span>
      </div>

      <div style={{ display: 'flex', gap: 18, flex: 1, flexWrap: 'wrap' }}>
        <Stat theme={theme} value={cycles} label="cycles this session" />
        <Stat theme={theme} value={recordsChanged} label="records changed" />
        <Stat theme={theme} value={lastMethod} label="last sync method" />
        <Stat theme={theme} value={isoToAgo(lastSyncAt, nowMs)} label="last sync ago" />
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <button
          onClick={onRunTestSync}
          style={{
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 500,
            border: `1px solid ${theme.border}`,
            borderRadius: 5,
            background: theme.bgCard,
            color: theme.text,
            cursor: 'pointer',
          }}
        >run test sync ↗</button>
        <button
          onClick={onTogglePause}
          disabled={!canToggleContinuous}
          style={{
            padding: '5px 10px',
            fontSize: 11,
            fontWeight: 500,
            border: `1px solid ${theme.border}`,
            borderRadius: 5,
            background: theme.bgCard,
            color: canToggleContinuous ? theme.text : theme.textMuted,
            cursor: canToggleContinuous ? 'pointer' : 'not-allowed',
          }}
        >{continuousEnabled ? 'pause' : 'resume'}</button>
      </div>
    </div>
  );
}

function Stat({ theme, value, label }: { theme: Theme; value: string | number; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 16, fontWeight: 600, color: theme.textHeading, lineHeight: 1.1 }}>{value}</span>
      <span style={{ fontSize: 10, color: theme.textMuted, marginTop: 2 }}>{label}</span>
    </div>
  );
}

function WebhookHealthPanel({ theme, nowMs }: { theme: Theme; nowMs: number }) {
  const health: WebhookHealth = useAirtableStore((s) => s.webhookHealth);

  const ok = health.lastStatus != null && health.lastStatus >= 200 && health.lastStatus < 300;
  const badgeColor = health.lastStatus == null
    ? { fg: theme.textMuted, bg: theme.bgMuted, border: theme.borderLight }
    : ok
    ? { fg: theme.successText, bg: theme.successBg, border: theme.successBorder }
    : { fg: theme.dangerText, bg: theme.dangerBg, border: theme.dangerBorder };

  return (
    <div style={{
      border: `1px solid ${theme.borderLight}`,
      borderRadius: 8,
      background: theme.bgCard,
      marginBottom: 10,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.borderLight}`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.textHeading }}>Webhook health</span>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 10,
          color: badgeColor.fg,
          background: badgeColor.bg,
          border: `1px solid ${badgeColor.border}`,
        }}>{health.lastStatusText ?? 'never polled'}</span>
      </div>
      <div style={{ padding: '8px 12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: theme.text, wordBreak: 'break-all' }}>
        {shortenUrl(health.url)}
      </div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '6px 12px 8px',
        fontSize: 11,
        color: theme.textMuted,
      }}>
        <span>last polled: {formatAgo(health.lastPolledAt, nowMs)}</span>
        <span>cursor: {health.lastCursor ?? '—'}</span>
      </div>
      {health.lastError && !ok && (
        <div style={{
          padding: '6px 12px 8px',
          fontSize: 11,
          color: theme.dangerText,
          borderTop: `1px solid ${theme.borderLight}`,
        }}>error: {health.lastError}</div>
      )}
      {health.hint && !ok && (
        <div style={{
          padding: '8px 12px',
          fontSize: 11,
          color: theme.text,
          background: theme.bgMuted,
          borderTop: `1px solid ${theme.borderLight}`,
          borderBottomLeftRadius: 8,
          borderBottomRightRadius: 8,
          lineHeight: 1.45,
        }}>{health.hint}</div>
      )}
    </div>
  );
}

function RecentChangesPanel({ theme }: { theme: Theme }) {
  const recent: RecentChange[] = useAirtableStore((s) => s.recentChanges);
  const lastSyncAt = useAirtableStore((s) => s.lastSyncAt);
  const clear = useAirtableStore((s) => s.clearRecentChanges);

  // Group consecutive diffs by record id so the panel reads "record X had
  // these 3 fields changed" rather than 3 disjointed rows.
  const head = recent[0];

  return (
    <div style={{
      border: `1px solid ${theme.borderLight}`,
      borderRadius: 8,
      background: theme.bgCard,
      marginBottom: 10,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.borderLight}`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.textHeading }}>Recent changes</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: theme.textMuted }}>
            last sync: {isoToTimeOfDay(lastSyncAt)}
          </span>
          {recent.length > 0 && (
            <button
              onClick={clear}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                border: `1px solid ${theme.border}`,
                borderRadius: 4,
                background: 'transparent',
                color: theme.textSecondary,
                cursor: 'pointer',
              }}
            >clear</button>
          )}
        </div>
      </div>

      {recent.length === 0 ? (
        <div style={{ padding: '14px 12px', fontSize: 11, color: theme.textMuted, fontStyle: 'italic' }}>
          No record changes detected this session. The next update sync that catches an
          edit will land here with a before/after diff.
        </div>
      ) : (
        <div>
          {head && (
            <div style={{ padding: '10px 12px' }}>
              <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 11 }}>
                <colgroup>
                  <col style={{ width: '22%' }} />
                  <col style={{ width: '39%' }} />
                  <col style={{ width: '39%' }} />
                </colgroup>
                <thead>
                  <tr style={{ color: theme.textMuted, textAlign: 'left' }}>
                    <th style={{ padding: '0 8px 4px 0', fontWeight: 500 }}>field</th>
                    <th style={{ padding: '0 8px 4px 0', fontWeight: 500 }}>before</th>
                    <th style={{ padding: '0 0 4px 0', fontWeight: 500 }}>after</th>
                  </tr>
                </thead>
                <tbody>
                  {head.diffs.map((d, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${theme.borderLight}` }}>
                      <td style={{ padding: '4px 8px 4px 0', color: theme.text, fontWeight: 500, verticalAlign: 'top', wordBreak: 'break-word', overflowWrap: 'anywhere' }}>{d.field}</td>
                      <td style={{ padding: '4px 8px 4px 0', color: theme.dangerText, textDecoration: 'line-through', verticalAlign: 'top', wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                        {formatValue(d.before)}
                      </td>
                      <td style={{ padding: '4px 0', color: theme.successText, verticalAlign: 'top', wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                        {formatValue(d.after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 6, fontSize: 10, color: theme.textMuted }}>
                record: <code>{head.recordId}</code> · {head.tableName}
                {head.recordLabel && head.recordLabel !== head.recordId ? ` · "${head.recordLabel}"` : ''}
              </div>
            </div>
          )}
          {recent.length > 1 && (
            <div style={{
              padding: '6px 12px 10px',
              fontSize: 10,
              color: theme.textMuted,
              borderTop: `1px solid ${theme.borderLight}`,
            }}>
              + {recent.length - 1} earlier change{recent.length - 1 === 1 ? '' : 's'} (see Sync log below)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function methodBadge(theme: Theme, entry: SyncLogEntry): { label: string; bg: string; fg: string; border: string } {
  switch (entry.type) {
    case 'hydration_complete':
    case 'snapshot_imported':
      return { label: 'full', bg: theme.purpleBg, fg: theme.purple, border: theme.purpleBorder };
    case 'webhook_poll':
    case 'change_detected':
      return { label: 'webhook', bg: theme.tealBg, fg: theme.teal, border: theme.tealBorder };
    case 'sync_error':
      return { label: 'error', bg: theme.dangerBg, fg: theme.dangerText, border: theme.dangerBorder };
    case 'snapshot_downloaded':
      return { label: 'pull', bg: theme.goldBg, fg: theme.gold, border: theme.goldBorder };
    case 'sync_start':
      return { label: 'start', bg: theme.bgMuted, fg: theme.textMuted, border: theme.borderLight };
    case 'lock_acquired':
    case 'lock_released':
      return { label: 'lock', bg: theme.bgMuted, fg: theme.textMuted, border: theme.borderLight };
    case 'provenance_uploaded':
      return { label: 'drive', bg: theme.accentBg, fg: theme.accent, border: theme.accentBorder };
    default:
      return { label: 'sync', bg: theme.bgMuted, fg: theme.textMuted, border: theme.borderLight };
  }
}

function SyncLogPanel({ theme }: { theme: Theme }) {
  const log = useAirtableStore((s) => s.syncLog);
  const clear = useAirtableStore((s) => s.clearSyncLog);
  const visible = log.slice(0, 30);

  return (
    <div style={{
      border: `1px solid ${theme.borderLight}`,
      borderRadius: 8,
      background: theme.bgCard,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderBottom: `1px solid ${theme.borderLight}`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.textHeading }}>Sync log</span>
        {log.length > 0 && (
          <button
            onClick={clear}
            style={{
              fontSize: 11,
              padding: '2px 8px',
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              background: 'transparent',
              color: theme.textSecondary,
              cursor: 'pointer',
            }}
          >clear</button>
        )}
      </div>
      {visible.length === 0 ? (
        <div style={{ padding: '14px 12px', fontSize: 11, color: theme.textMuted, fontStyle: 'italic' }}>
          No log entries yet. Run a sync above to populate the log.
        </div>
      ) : (
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {visible.map((entry, i) => {
            const badge = methodBadge(theme, entry);
            return (
              <div key={i} style={{
                display: 'flex',
                gap: 10,
                padding: '6px 12px',
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                borderTop: i === 0 ? 'none' : `1px solid ${theme.borderLight}`,
                color: theme.text,
              }}>
                <span style={{ color: theme.textMuted, minWidth: 64 }}>
                  {timeOfDay(entry.ts)}
                </span>
                <span style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 3,
                  color: badge.fg,
                  background: badge.bg,
                  border: `1px solid ${badge.border}`,
                  alignSelf: 'flex-start',
                  marginTop: 1,
                  minWidth: 48,
                  textAlign: 'center',
                }}>{badge.label}</span>
                <span style={{ flex: 1, wordBreak: 'break-word' }}>{entry.detail ?? entry.type}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Public entry ───────────────────────────────────────────────────────────

export function AirtableSyncTransparency(props: Props) {
  return (
    <div>
      <HeaderStrip {...props} />
      <WebhookHealthPanel theme={props.theme} nowMs={props.nowMs} />
      <RecentChangesPanel theme={props.theme} />
      <SyncLogPanel theme={props.theme} />
    </div>
  );
}
