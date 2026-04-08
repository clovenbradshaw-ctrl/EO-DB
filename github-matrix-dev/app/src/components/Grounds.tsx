import { useMemo } from 'react';
import type { GroundEntry } from '../db/types';
import { useTheme, type Theme } from '../theme';
import { useDisplayNames } from '../hooks/useDisplayNames';

const ICONS: Record<string, string> = {
  regulatoryHold: '\u26a0',
  defaultRegion: '\u25c9',
  timezone: '\u25f7',
  firm: '\u2b21',
};

interface GroundsProps {
  entries: GroundEntry[];
}

export function Grounds({ entries }: GroundsProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const sources = useMemo(() => entries.map(e => e.source), [entries]);
  const displayNames = useDisplayNames(sources);

  return (
    <div style={s.row}>
      {entries.map((g, i) => {
        const isWarning = g.key === 'regulatoryHold' && g.value === true;
        return (
          <div key={i} style={{
            ...s.chip,
            ...(isWarning ? s.warning : {}),
          }}>
            <div style={{
              ...s.icon,
              ...(isWarning ? s.warningIcon : {}),
            }}>
              {ICONS[g.key] || '\u25ce'}
            </div>
            <div style={s.text}>
              <div style={s.key}>{g.key}</div>
              <div style={{
                ...s.val,
                ...(isWarning ? { color: theme.danger, fontWeight: 500 } : {}),
              }}>
                {String(g.value)}
              </div>
              <div style={s.from}>{displayNames.get(g.source) || g.source} (distance: {g.distance})</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    row: { display: 'flex', flexWrap: 'wrap', gap: 10 },
    chip: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 14px',
      background: t.bgCard,
      border: `1px solid ${t.purpleBorder}`,
      borderRadius: 8,
      minWidth: 160,
    },
    warning: { borderColor: t.danger, background: t.dangerBg },
    icon: {
      width: 32,
      height: 32,
      borderRadius: 6,
      background: t.purpleBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14,
      flexShrink: 0,
    },
    warningIcon: { background: t.dangerBg, color: t.danger },
    text: { flex: 1 },
    key: { fontSize: 10, color: t.textSecondary, fontWeight: 500 },
    val: { fontSize: 13, color: t.textHeading, fontWeight: 400 },
    from: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      color: t.textMuted,
    },
  };
}
