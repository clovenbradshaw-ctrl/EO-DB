/**
 * PersonaQuickActions — a strip of quick-create buttons rendered above the
 * records view when the active persona has quick_actions defined and the
 * currently open scope matches one of them.
 *
 * Each button dispatches a prefilled INS event via the eo-store fold
 * pipeline. No new operators, no new storage path — just a shortcut to
 * the existing compose flow.
 */

import { useState } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import type { QuickAction } from '../permissions/types';

interface PersonaQuickActionsProps {
  actions: QuickAction[];
  currentScope: string | null;
  typeColor?: string;
  /** Called after a record is created, with the new record target. */
  onRecordCreated?: (target: string) => void;
}

export function PersonaQuickActions({ actions, currentScope, typeColor, onRecordCreated }: PersonaQuickActionsProps) {
  const { theme } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);
  const [busyAction, setBusyAction] = useState<number | null>(null);

  // Only show actions whose scope matches the current scope.
  const visible = actions.filter((a) => a.scope && currentScope && a.scope === currentScope);
  if (visible.length === 0) return null;

  const accent = typeColor ?? theme.accent;

  async function handleClick(action: QuickAction, idx: number) {
    if (busyAction !== null) return;
    setBusyAction(idx);
    try {
      const now = new Date().toISOString();
      const recId = `rec_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const target = `${action.scope}.${recId}`;
      const operand = { ...(action.template ?? {}) };
      await dispatch({
        op: 'INS',
        target,
        operand,
        agent: 'user',
        ts: now,
        acquired_ts: now,
      });
      if (onRecordCreated) onRecordCreated(target);
    } catch (e) {
      // Surface failure via console; the fold will emit its own error too.
      console.warn('[EO-DB] Quick action failed:', e);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '6px 16px 0',
      }}
    >
      {visible.map((action, i) => (
        <button
          key={`${action.label}-${i}`}
          onClick={() => handleClick(action, i)}
          disabled={busyAction !== null}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            fontFamily: "'Outfit', sans-serif",
            fontSize: 12,
            fontWeight: 500,
            color: '#fff',
            background: accent,
            border: 'none',
            borderRadius: 6,
            cursor: busyAction !== null ? 'wait' : 'pointer',
            opacity: busyAction !== null && busyAction !== i ? 0.5 : 1,
          }}
          title={`Create a new record at ${action.scope}`}
        >
          {action.icon && <span>{action.icon}</span>}
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  );
}

