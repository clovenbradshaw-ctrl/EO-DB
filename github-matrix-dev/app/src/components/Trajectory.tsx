import type { LoggableOperator, EoEvent, TrajectoryEntry, TrajectoryFingerprint, CadenceInfo } from '../db/types';
import { useTheme, type Theme } from '../theme';

// REC is system-generated — distinct style: dashed border, "SYS" label
const REC_SYSTEM_STYLE: React.CSSProperties = {
  borderStyle: 'dashed',
};

interface TrajectoryProps {
  entries: TrajectoryEntry[];
  events?: EoEvent[];  // optional: full events for agent-aware rendering
  fingerprint?: TrajectoryFingerprint;
  cadence?: CadenceInfo;
}

/** Truncate a hex hash to a short prefix for display. */
function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function Trajectory({ entries, events, fingerprint, cadence }: TrajectoryProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const opColors = makeOpColors(theme);

  return (
    <div>
      {/* Fingerprint + Cadence summary bar */}
      {(fingerprint || cadence) && (
        <div style={s.summaryBar}>
          {fingerprint && (
            <span style={s.fingerprintBadge} title={`Operator sequence: ${fingerprint.sequence}`}>
              {fingerprint.fingerprint.slice(0, 8)}
            </span>
          )}
          {fingerprint && (
            <span style={s.sequenceLabel}>
              {fingerprint.sequence}
            </span>
          )}
          {cadence && (
            <span style={{
              ...s.cadenceBadge,
              background: cadence.classification === 'burst' ? theme.dangerBg
                : cadence.classification === 'dormant' ? theme.bgMuted
                : cadence.classification === 'periodic' ? theme.successBg
                : theme.accentBg,
              color: cadence.classification === 'burst' ? theme.danger
                : cadence.classification === 'dormant' ? theme.textMuted
                : cadence.classification === 'periodic' ? theme.success
                : theme.accent,
            }} title={cadence.description}>
              {cadence.classification}
            </span>
          )}
        </div>
      )}
      <div style={s.row}>
      {entries.map((entry, i) => {
        const c = opColors[entry.op] || opColors.DEF;
        const isSystemREC = entry.op === 'REC' && (!events || events[i]?.agent === 'system');
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
                  ? `System-discovered cycle (triggered by event #${events?.[i]?.triggered_by ?? '?'})\n${entry.hash}`
                  : `${entry.op}\n${entry.hash}`}
              >
                {entry.op}
              </div>
              <div style={{
                ...s.hashLabel,
                color: c.color,
              }}>
                {shortHash(entry.hash)}
              </div>
              <div style={{
                ...s.label,
                ...(isSystemREC ? { color: theme.warning, fontWeight: 600 } : {}),
              }}>
                {isSystemREC ? 'SYS' : entry.op}
              </div>
            </div>
          </div>
        );
      })}
      </div>
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
    summaryBar: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 10,
      padding: '6px 0',
    },
    fingerprintBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      background: t.accentBg,
      color: t.accent,
      border: `1px solid ${t.accentBorder}`,
      borderRadius: 3,
      padding: '2px 6px',
      fontWeight: 600,
    },
    sequenceLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
      maxWidth: 300,
    },
    cadenceBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      borderRadius: 3,
      padding: '2px 6px',
      fontWeight: 500,
    },
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
    hashLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      marginTop: 3,
      opacity: 0.7,
      whiteSpace: 'nowrap' as const,
    },
    label: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      color: t.textMuted,
      marginTop: 1,
      whiteSpace: 'nowrap' as const,
    },
  };
}
