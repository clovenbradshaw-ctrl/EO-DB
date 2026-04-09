import { useMemo, useState, useEffect } from 'react';
import type { SimilarRecord, SimilarityReason } from '../db/types';
import { useTheme, type Theme } from '../theme';
import { useDisplayNames } from '../hooks/useDisplayNames';

interface NearbyProps {
  entries: SimilarRecord[];
  onNavigate: (target: string) => void;
}

function ScoreRing({ score, theme }: { score: number; theme: Theme }) {
  const size = 36;
  const r = (size - 4) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const color = score >= 80 ? theme.accent : score >= 65 ? theme.purple : theme.textMuted;
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={theme.bgMuted} strokeWidth={3} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke={color} strokeWidth={3}
        strokeDasharray={`${dash} ${circ - dash}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray 0.6s ease' }}
      />
      <text
        x={size / 2} y={size / 2 + 4}
        textAnchor="middle"
        fill={color}
        fontSize={10} fontWeight={700}
        fontFamily="'JetBrains Mono', monospace"
      >
        {score}
      </text>
    </svg>
  );
}

function ReasonTag({ reason, theme }: { reason: SimilarityReason; theme: Theme }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '2px 0' }}>
      <span style={{
        fontSize: 11,
        color: reason.color,
        fontFamily: "'JetBrains Mono', monospace",
        flexShrink: 0,
        width: 14,
        textAlign: 'center',
      }}>
        {reason.icon}
      </span>
      <span style={{
        fontSize: 11.5,
        color: theme.textSecondary,
        lineHeight: 1.3,
      }}>
        {reason.text}
      </span>
    </div>
  );
}

function SimilarCard({
  entry,
  onNavigate,
  theme,
  delay,
}: {
  entry: SimilarRecord;
  onNavigate: (target: string) => void;
  theme: Theme;
  delay: number;
}) {
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  const targets = useMemo(() => [entry.target], [entry.target]);
  const displayNames = useDisplayNames(targets);
  const displayName = displayNames.get(entry.target);
  const shortId = entry.target.split('.').pop() || entry.target;
  const label = displayName || shortId;

  return (
    <div
      onClick={() => onNavigate(entry.target)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: hovered ? theme.bgHover : theme.bgCard,
        border: `1px solid ${hovered ? theme.border : theme.borderLight}`,
        borderRadius: 10,
        padding: '12px 14px',
        cursor: 'pointer',
        transition: 'all 0.15s ease',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 13,
            fontWeight: 600,
            color: theme.textHeading,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical' as any,
            overflow: 'hidden',
            lineHeight: 1.35,
          }}>
            {label}
          </div>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            color: theme.textMuted,
            marginTop: 1,
          }}>
            {displayName ? shortId : entry.target}
          </div>
        </div>
        <ScoreRing score={entry.score} theme={theme} />
      </div>

      {/* Reasons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {entry.reasons.map((r, i) => (
          <ReasonTag key={i} reason={r} theme={theme} />
        ))}
      </div>
    </div>
  );
}

export function Nearby({ entries, onNavigate }: NearbyProps) {
  const { theme } = useTheme();

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {entries.map((entry, i) => (
        <SimilarCard
          key={entry.target}
          entry={entry}
          onNavigate={onNavigate}
          theme={theme}
          delay={i * 60}
        />
      ))}
    </div>
  );
}
