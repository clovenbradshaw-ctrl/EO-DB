/**
 * AirtableSyncBadge — persistent "what's happening with Airtable right now"
 * indicator that lives in the app shell (not just the settings panel).
 *
 * Four visual states, derived from the Airtable Zustand store:
 *   - syncing     → green pulsing dot + "syncing {table} ({N} records)"
 *   - idle+cont.  → grey dot + "idle — next in Ns" (live countdown)
 *   - manual only → dim dot + "manual only"
 *   - error       → red dot + last error snippet
 *
 * Click toggles the tooltip-style detail popup so the user can see the exact
 * API endpoint + cursor + strategy + overwrite mode without opening Settings.
 */

import { useEffect, useState } from 'react';
import { useAirtableStore } from '../ingestion/airtable-store';
import { useTheme } from '../theme';

interface AirtableSyncBadgeProps {
  /**
   * When true, render nothing unless the user has connected Airtable. The
   * badge is noisy if it shows "manual only" for users who aren't using
   * Airtable at all.
   */
  hideWhenDisconnected?: boolean;
}

export function AirtableSyncBadge({ hideWhenDisconnected = true }: AirtableSyncBadgeProps) {
  const { theme } = useTheme();
  const connected = useAirtableStore((s) => s.connected);
  const isSyncing = useAirtableStore((s) => s.isSyncing);
  const continuousSyncEnabled = useAirtableStore((s) => s.continuousSyncEnabled);
  const currentSync = useAirtableStore((s) => s.currentSync);
  const nextTickAt = useAirtableStore((s) => s.nextTickAt);
  const storeError = useAirtableStore((s) => s.error);
  const lastSyncAt = useAirtableStore((s) => s.lastSyncAt);

  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);

  // Tick once a second while the countdown is visible so "next in Ns" stays
  // accurate. Cheap — one setState per second, only while mounted.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (hideWhenDisconnected && !connected) return null;

  // Pick colour + label based on state. Order matters: error > syncing >
  // countdown > idle.
  let dot = theme.textMuted;
  let label: string;
  let pulse = false;

  if (storeError && !isSyncing) {
    dot = theme.dangerText ?? theme.danger ?? '#d04';
    label = `Airtable: error — ${truncate(storeError, 40)}`;
  } else if (isSyncing && currentSync) {
    dot = theme.successText ?? theme.success ?? '#2a7';
    pulse = true;
    const phaseLabel = phaseToWord(currentSync.phase);
    const tbl = currentSync.table ? ` ${currentSync.table}` : '';
    const rec = currentSync.recordsSoFar > 0 ? ` (${currentSync.recordsSoFar})` : '';
    label = `Airtable: ${phaseLabel}${tbl}${rec}`;
  } else if (continuousSyncEnabled && nextTickAt) {
    dot = theme.textSecondary;
    const secs = Math.max(0, Math.round((nextTickAt - now) / 1000));
    label = `Airtable: idle — next in ${secs}s`;
  } else if (connected) {
    label = 'Airtable: manual only';
  } else {
    label = 'Airtable: not connected';
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title="Click for Airtable sync details"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 12,
          border: `1px solid ${theme.borderLight ?? theme.border ?? '#333'}`,
          background: theme.bgMuted ?? 'transparent',
          color: theme.text,
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          cursor: 'pointer',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dot,
            boxShadow: pulse ? `0 0 0 0 ${dot}` : undefined,
            animation: pulse ? 'eo-at-badge-pulse 1.2s infinite' : undefined,
          }}
        />
        <span>{label}</span>
      </button>

      {expanded && <AirtableBadgeDetails lastSyncAt={lastSyncAt} />}

      {/* Inline keyframes so we don't need a global stylesheet entry. */}
      <style>{`
        @keyframes eo-at-badge-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(42, 170, 120, 0.6); }
          70%  { box-shadow: 0 0 0 6px rgba(42, 170, 120, 0);   }
          100% { box-shadow: 0 0 0 0 rgba(42, 170, 120, 0);     }
        }
      `}</style>
    </div>
  );
}

function phaseToWord(phase: string): string {
  switch (phase) {
    case 'preparing':    return 'preparing';
    case 'discovering':  return 'discovering schema';
    case 'collecting':   return 'collecting';
    case 'fetching':     return 'fetching';
    case 'folding':      return 'folding';
    case 'syncing':      return 'syncing';
    case 'table_done':   return 'finishing';
    default:             return phase;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ─── Detail pop-out ────────────────────────────────────────────────────────

function AirtableBadgeDetails({ lastSyncAt }: { lastSyncAt: string | null }) {
  const { theme } = useTheme();
  const currentSync = useAirtableStore((s) => s.currentSync);
  const syncSettings = useAirtableStore((s) => s.syncSettings);

  const rows: Array<[string, string]> = [];
  if (currentSync) {
    rows.push(['Phase', currentSync.phase]);
    rows.push(['Strategy', describeStrategy(currentSync.strategy)]);
    rows.push(['Mode', currentSync.preserveExisting ? 'Preserve existing' : 'May overwrite']);
    if (currentSync.baseName || currentSync.baseId) {
      rows.push(['Base', `${currentSync.baseName ?? ''}${currentSync.baseId ? ` (${currentSync.baseId})` : ''}`.trim()]);
    }
    if (currentSync.table) rows.push(['Table', currentSync.table]);
    if (currentSync.endpoint) rows.push(['Endpoint', `GET ${currentSync.endpoint}`]);
    rows.push([
      'Cursor',
      currentSync.cursorUsed
        ? `${currentSync.cursorUsed} (since this time)`
        : 'full rehydrate — no cursor',
    ]);
    rows.push(['Records so far', String(currentSync.recordsSoFar)]);
  } else {
    rows.push(['Status', 'Idle']);
    if (lastSyncAt) rows.push(['Last sync', new Date(lastSyncAt).toLocaleString()]);
    rows.push(['Mode setting', syncSettings.preserveExisting ? 'Preserve existing' : 'May overwrite']);
    rows.push(['Poll interval', `${syncSettings.syncIntervalSec}s`]);
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: 0,
        minWidth: 320,
        maxWidth: 520,
        padding: 10,
        borderRadius: 8,
        border: `1px solid ${theme.borderLight ?? theme.border ?? '#333'}`,
        background: theme.bg,
        color: theme.text,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
        zIndex: 10000,
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
          <span style={{ color: theme.textMuted, minWidth: 100 }}>{label}</span>
          <span style={{ wordBreak: 'break-all' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function describeStrategy(s?: string): string {
  switch (s) {
    case 'hydration':    return 'Full hydration (no cursor)';
    case 'lastModified': return 'Incremental (LAST_MODIFIED_TIME)';
    default:             return s ?? 'unknown';
  }
}
