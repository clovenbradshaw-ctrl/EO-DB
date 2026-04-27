import { useMemo } from 'react';
import type { EoEvent } from '../db/types';
import type { Theme } from '../theme';
import { formatSettingValue, isSettingsChangeEvent } from '../lib/settings-events';

interface SettingsActivityProps {
  events: EoEvent[];
  theme: Theme;
  /** Cap the number of rows shown. Default: 30 most recent. */
  limit?: number;
}

interface TimelineRow {
  seq: number;
  ts: number;
  agent: string;
  setting: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
}

function shortAgent(agent: string): string {
  if (!agent) return 'unknown';
  if (agent.startsWith('@')) {
    const local = agent.slice(1).split(':')[0];
    return local || agent;
  }
  return agent;
}

function formatRelative(ts: number): string {
  const delta = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

export function SettingsActivity({ events, theme, limit = 30 }: SettingsActivityProps) {
  const rows = useMemo<TimelineRow[]>(() => {
    const matches: TimelineRow[] = [];
    for (const ev of events) {
      if (!isSettingsChangeEvent(ev.meta)) continue;
      const meta = ev.meta as Record<string, any>;
      const setting = String(meta.setting ?? ev.target);
      matches.push({
        seq: ev.seq,
        ts: new Date(ev.ts).getTime(),
        agent: ev.agent,
        setting,
        label: typeof meta.label === 'string' && meta.label.length > 0 ? meta.label : setting,
        oldValue: meta.oldValue,
        newValue: meta.newValue,
      });
    }
    matches.sort((a, b) => b.ts - a.ts);
    return matches.slice(0, limit);
  }, [events, limit]);

  if (rows.length === 0) {
    return (
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: theme.textMuted,
      }}>
        No settings changes yet. Toggle anything in this panel and it'll show up here as a room event.
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column' as const,
      borderLeft: `1px solid ${theme.border}`,
      paddingLeft: 12,
      gap: 10,
    }}>
      {rows.map((row) => (
        <TimelineEntry key={row.seq} row={row} theme={theme} />
      ))}
    </div>
  );
}

function TimelineEntry({ row, theme }: { row: TimelineRow; theme: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 2, position: 'relative' as const }}>
      <span style={{
        position: 'absolute' as const,
        left: -16,
        top: 5,
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: theme.accent,
        boxShadow: `0 0 6px ${theme.accent}80`,
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 10,
          fontWeight: 600,
          color: theme.text,
        }}>
          {row.label}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 9,
          color: theme.textMuted,
          flexShrink: 0,
        }} title={new Date(row.ts).toLocaleString()}>
          {formatRelative(row.ts)}
        </span>
      </div>
      <div style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        color: theme.textMuted,
        wordBreak: 'break-word' as const,
      }}>
        <span style={{ color: theme.textMuted }}>{shortAgent(row.agent)}</span>
        <span> · </span>
        <span style={{ color: theme.danger }}>{formatSettingValue(row.oldValue)}</span>
        <span> → </span>
        <span style={{ color: theme.success }}>{formatSettingValue(row.newValue)}</span>
      </div>
    </div>
  );
}
