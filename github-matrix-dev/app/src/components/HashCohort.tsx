/**
 * HashCohort — displays structural twins (targets with identical transformation hashes).
 * These records underwent the exact same operator sequence with the same operand shapes,
 * regardless of when the operations occurred.
 */
import { useMemo } from 'react';
import { useTheme, type Theme } from '../theme';
import { useDisplayNames } from '../hooks/useDisplayNames';

interface HashCohortProps {
  targets: string[];
  currentTarget: string;
  onNavigate: (target: string) => void;
}

export function HashCohort({ targets, currentTarget, onNavigate }: HashCohortProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const displayNames = useDisplayNames(useMemo(() => targets, [targets]));

  // Group by collection prefix for cross-collection echo detection
  const byCollection: Record<string, string[]> = {};
  for (const t of targets) {
    const parts = t.split('.');
    const collection = parts.length >= 2 ? parts.slice(0, 2).join('.') : t;
    if (!byCollection[collection]) byCollection[collection] = [];
    byCollection[collection].push(t);
  }

  const currentCollection = currentTarget.split('.').slice(0, 2).join('.');
  const crossCollection = Object.keys(byCollection).filter(c => c !== currentCollection);

  return (
    <div>
      {crossCollection.length > 0 && (
        <div style={s.echoNotice}>
          Cross-collection echo — same pattern appears in: {crossCollection.map(c => {
            const count = byCollection[c].length;
            return `${c} (${count})`;
          }).join(', ')}
        </div>
      )}
      <div style={s.grid}>
        {targets.map((t) => {
          const shortId = t.split('.').pop() || t;
          const displayName = displayNames.get(t);
          const label = displayName || shortId;
          const collection = t.split('.').slice(0, 2).join('.');
          const isCross = collection !== currentCollection;
          return (
            <div
              key={t}
              style={{ ...s.card, ...(isCross ? s.crossCard : {}) }}
              onClick={() => onNavigate(t)}
            >
              <div style={s.label}>{label}</div>
              <div style={s.target}>{displayName ? shortId : t}</div>
              {isCross && <div style={s.crossBadge}>echo</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 },
    card: {
      padding: '10px 12px',
      background: t.bgCard,
      border: `1px solid ${t.purpleBorder}`,
      borderRadius: 6,
      cursor: 'pointer',
      position: 'relative' as const,
    },
    crossCard: {
      borderStyle: 'dashed',
    },
    label: {
      fontWeight: 600,
      fontSize: 12,
      color: t.purple,
      marginBottom: 2,
    },
    target: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },
    crossBadge: {
      position: 'absolute' as const,
      top: 4,
      right: 6,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 7,
      color: t.purple,
      opacity: 0.6,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
    },
    echoNotice: {
      fontSize: 11,
      color: t.purple,
      marginBottom: 10,
      padding: '6px 10px',
      background: t.purpleBg,
      border: `1px solid ${t.purpleBorder}`,
      borderRadius: 4,
    },
  };
}
