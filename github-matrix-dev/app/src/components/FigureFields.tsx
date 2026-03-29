import type { EoState } from '../db/types';
import { useTheme, type Theme } from '../theme';

interface FigureFieldsProps {
  figure: EoState;
  onNavigate: (target: string) => void;
}

export function FigureFields({ figure, onNavigate }: FigureFieldsProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const value = figure.value;
  if (!value || typeof value !== 'object') {
    return <div style={s.mono}>{JSON.stringify(value)}</div>;
  }

  const entries = Object.entries(value).filter(([k]) => !k.startsWith('_'));

  return (
    <div style={s.grid}>
      {entries.map(([key, val]) => (
        <div key={key} style={s.cell}>
          <div style={s.label}>
            {key}
            {value._computed && key === '_computed' && (
              <span style={s.evaBadge}>EVA</span>
            )}
          </div>
          <div style={s.value}>
            {typeof val === 'object' && val !== null
              ? renderObjectValue(val, onNavigate, theme)
              : String(val)}
          </div>
        </div>
      ))}
    </div>
  );
}

function renderObjectValue(val: any, onNavigate: (t: string) => void, t: Theme): React.ReactNode {
  // CON linked array
  if (val.linked && Array.isArray(val.linked)) {
    return (
      <div>
        {val.linked.map((target: string) => (
          <div
            key={target}
            onClick={() => onNavigate(target)}
            style={{ color: t.purple, cursor: 'pointer', fontSize: 13 }}
          >
            {target}
          </div>
        ))}
      </div>
    );
  }
  return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{JSON.stringify(val, null, 1)}</span>;
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    grid: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr 1fr',
      gap: 0,
    },
    cell: {
      padding: '14px 16px',
      border: `1px solid ${t.border}`,
      margin: '-1px 0 0 -1px',
      background: t.bgCard,
    },
    label: {
      fontSize: 10,
      fontWeight: 500,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.3,
      marginBottom: 4,
      display: 'flex',
      alignItems: 'center',
      gap: 4,
    },
    value: {
      fontSize: 14,
      color: t.textHeading,
      fontWeight: 400,
    },
    mono: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textSecondary,
    },
    evaBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 8,
      color: t.teal,
      padding: '1px 4px',
      borderRadius: 2,
      background: t.tealBg,
      border: `1px solid ${t.tealBorder}`,
    },
  };
}
