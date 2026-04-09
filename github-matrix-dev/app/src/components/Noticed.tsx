import { useState, useEffect } from 'react';
import type { Observation } from '../db/types';
import { useTheme } from '../theme';

interface NoticedProps {
  observations: Observation[];
  onNavigate?: (target: string) => void;
}

function ObservationRow({
  obs,
  delay,
  onNavigate,
}: {
  obs: Observation;
  delay: number;
  onNavigate?: (target: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { theme } = useTheme();

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  const clickable = obs.action && obs.actionTarget && onNavigate;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => clickable && onNavigate!(obs.actionTarget!)}
      style={{
        display: 'flex',
        gap: 12,
        padding: '11px 0',
        borderBottom: `1px solid ${theme.borderDivider}`,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(4px)',
        transition: 'all 0.2s ease',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <span style={{
        fontSize: 14,
        flexShrink: 0,
        color: obs.color,
        width: 20,
        textAlign: 'center',
        paddingTop: 1,
      }}>
        {obs.icon}
      </span>
      <div style={{ flex: 1 }}>
        <p style={{
          fontSize: 12.5,
          color: theme.textSecondary,
          lineHeight: 1.55,
          margin: 0,
        }}>
          {obs.text}
        </p>
        {obs.action && hovered && (
          <span style={{
            fontSize: 11,
            color: theme.accent,
            fontWeight: 500,
            display: 'inline-block',
            marginTop: 4,
          }}>
            {obs.action}
          </span>
        )}
      </div>
    </div>
  );
}

export function Noticed({ observations, onNavigate }: NoticedProps) {
  return (
    <div>
      {observations.map((obs, i) => (
        <ObservationRow
          key={i}
          obs={obs}
          delay={i * 80}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
