import type { LoggableOperator, EoEvent } from '../db/types';
import { useTheme, type Theme } from '../theme';

// REC is system-generated — distinct style: dashed border, "SYS" label
const REC_SYSTEM_STYLE: React.CSSProperties = {
  borderStyle: 'dashed',
};

interface TrajectoryProps {
  ops: LoggableOperator[];
  events?: EoEvent[];  // optional: full events for agent-aware rendering
}

export function Trajectory({ ops, events }: TrajectoryProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const opColors = makeOpColors(theme);

  return (
    <div style={s.row}>
      {ops.map((op, i) => {
        const c = opColors[op] || opColors.DEF;
        const isSystemREC = op === 'REC' && (!events || events[i]?.agent === 'system');
        return (
          <div key={i} style={s.nodeWrap}>
            {i > 0 && <div style={s.connector} />}
            <div style={s.node}>
              <div
                style={{
                  ...s.dot,
                  background: isSystemREC ? theme.warningBg : c.bg,
                  color: c.color,
                  borderColor: c.border,
                  ...(isSystemREC ? REC_SYSTEM_STYLE : {}),
                }}
                title={isSystemREC
                  ? `System-discovered cycle (triggered by event #${events?.[i]?.triggered_by ?? '?'})`
                  : op}
              >
                {op}
              </div>
              <div style={{
                ...s.label,
                ...(isSystemREC ? { color: theme.warning, fontWeight: 600 } : {}),
              }}>
                {isSystemREC ? 'SYS' : op}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function makeOpColors(t: Theme): Record<string, { bg: string; color: string; border: string }> {
  return {
    INS: { bg: t.successBg, color: t.success, border: t.success },
    DEF: { bg: t.accentBg, color: t.accent, border: t.accent },
    CON: { bg: t.purpleBg, color: t.purple, border: t.purple },
    SEG: { bg: t.dangerBg, color: t.danger, border: t.danger },
    SYN: { bg: t.purpleBg, color: t.purple, border: t.purple },
    EVA: { bg: t.tealBg, color: t.teal, border: t.teal },
    REC: { bg: t.warningBg, color: t.warning, border: t.warning },
    NUL: { bg: t.bgMuted, color: t.textMuted, border: t.textMuted },
  };
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    row: { display: 'flex', alignItems: 'center', padding: '4px 0' },
    nodeWrap: { display: 'flex', alignItems: 'center' },
    connector: { width: 24, height: 2, background: t.borderDivider, flexShrink: 0 },
    node: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
    dot: {
      width: 24,
      height: 24,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 7,
      fontWeight: 600,
      border: '2px solid',
    },
    label: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      color: t.textMuted,
      marginTop: 4,
      whiteSpace: 'nowrap' as const,
    },
  };
}
