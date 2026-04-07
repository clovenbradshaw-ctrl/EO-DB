import { useState } from 'react';
import type { EntityClassification } from '../db/types';
import { useTheme, type Theme } from '../theme';

interface EntityClassBadgeProps {
  classification: EntityClassification;
}

const TYPE_CONFIG: Record<string, { label: string; color: (t: Theme) => string }> = {
  emanon:   { label: 'emanon',   color: (t) => t.danger },
  protogon: { label: 'protogon', color: (t) => t.warning },
  holon:    { label: 'holon',    color: (t) => t.teal },
};

const SIGNAL_LABELS: Record<string, string> = {
  periodicity:  'periodicity',
  momentum:     'momentum',
  conflictRate: 'conflict rate',
  convergence:  'convergence',
  diffSize:     'diff size',
};

function formatZ(z: number): string {
  const sign = z >= 0 ? '+' : '';
  return `${sign}${z.toFixed(1)}\u03C3`;
}

export function EntityClassBadge({ classification }: EntityClassBadgeProps) {
  const { theme } = useTheme();
  const [showTooltip, setShowTooltip] = useState(false);

  const config = TYPE_CONFIG[classification.type] ?? TYPE_CONFIG.protogon;
  const color = config.color(theme);
  const pct = Math.round(classification.confidence * 100);

  const zEntries = Object.entries(classification.zScores)
    .filter(([, z]) => z !== 0)
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 10,
        fontFamily: "'JetBrains Mono', monospace",
        fontWeight: 600,
        background: `${color}15`,
        color,
        border: `1px solid ${color}40`,
        cursor: 'default',
      }}>
        <span style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: color,
          opacity: classification.confidence > 0.3 ? 1 : 0.4,
        }} />
        {config.label}
        {classification.confidence > 0 && (
          <span style={{ opacity: 0.7 }}>{pct}%</span>
        )}
      </span>

      {showTooltip && zEntries.length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 6,
          padding: '8px 12px',
          borderRadius: 6,
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          whiteSpace: 'nowrap',
          zIndex: 100,
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          lineHeight: 1.8,
          color: theme.text,
        }}>
          <div style={{
            fontSize: 9,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: theme.textMuted,
            marginBottom: 4,
          }}>
            z-scores ({classification.population}, n={classification.populationSize})
          </div>
          {zEntries.map(([key, z]) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <span style={{ color: theme.textSecondary }}>
                {SIGNAL_LABELS[key] ?? key}
              </span>
              <span style={{
                fontWeight: 600,
                color: Math.abs(z) > 1.5 ? (z > 0 ? theme.danger : theme.teal) : theme.text,
              }}>
                {formatZ(z)}
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
