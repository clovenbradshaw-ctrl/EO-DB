/**
 * UserTypeBadge — small inline badge showing a user type label + color dot.
 * Used in SpaceMembers, header switcher, and view tabs.
 */

import { useTheme, type Theme } from '../theme';

interface UserTypeBadgeProps {
  label: string;
  color?: string;
  /** Render smaller for inline use */
  compact?: boolean;
}

const DEFAULT_COLOR = '#6b7280';

export function UserTypeBadge({ label, color, compact }: UserTypeBadgeProps) {
  const { theme } = useTheme();
  const badgeColor = color || DEFAULT_COLOR;
  const mono = "'JetBrains Mono', monospace";

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: compact ? 3 : 4,
      padding: compact ? '1px 6px' : '2px 8px',
      borderRadius: 10,
      background: `${badgeColor}14`,
      border: `1px solid ${badgeColor}30`,
      fontFamily: mono,
      fontSize: compact ? 9 : 10,
      fontWeight: 500,
      color: badgeColor,
      whiteSpace: 'nowrap' as const,
      lineHeight: 1.4,
    }}>
      <span style={{
        width: compact ? 5 : 6,
        height: compact ? 5 : 6,
        borderRadius: '50%',
        background: badgeColor,
        flexShrink: 0,
      }} />
      {label}
    </span>
  );
}
