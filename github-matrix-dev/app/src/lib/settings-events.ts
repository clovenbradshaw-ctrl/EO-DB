/**
 * Settings-change audit events.
 *
 * When a user flips a toggle in the settings panel we dispatch a DEF event so
 * the change is preserved in the room log alongside everything else. Local
 * preferences (presence, NL, etc.) still live in localStorage — this is purely
 * the audit trail: who changed what, when, and what the prior value was.
 *
 * Events are picked up by `SettingsActivity` (renders a chronological timeline
 * inside SettingsView) by filtering `recentEvents` for
 * `meta.source === 'settings_change'`.
 */

import type { EoEventInput } from '../db/types';

export const SETTINGS_TARGET_PREFIX = 'space_settings.';
export const SETTINGS_EVENT_SOURCE = 'settings_change';

export interface SettingChange {
  /** Stable key, e.g. `"presence.showPeers"`. */
  setting: string;
  /** Human-friendly label shown in the timeline. */
  label: string;
  oldValue: unknown;
  newValue: unknown;
  /** Matrix user ID of whoever made the change. */
  agent: string;
}

export function buildSettingChangeEvent(change: SettingChange): EoEventInput {
  const now = new Date().toISOString();
  return {
    op: 'DEF',
    target: `${SETTINGS_TARGET_PREFIX}${change.setting}`,
    operand: { value: change.newValue, _prev: change.oldValue },
    agent: change.agent,
    ts: now,
    acquired_ts: now,
    level: 1,
    meta: {
      source: SETTINGS_EVENT_SOURCE,
      setting: change.setting,
      label: change.label,
      oldValue: change.oldValue,
      newValue: change.newValue,
    },
  };
}

export function isSettingsChangeEvent(meta: Record<string, any> | undefined): boolean {
  return !!meta && meta.source === SETTINGS_EVENT_SOURCE;
}

export function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > 0 ? value : '""';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
