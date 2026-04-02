/**
 * Role badge component — shows the user's role in the current space.
 * Reads power level and displays the human-readable label.
 */

import { useTheme, type Theme } from '../theme';
import { type AccessRole, ROLE_LABELS } from '../permissions/types';

interface PermissionBadgeProps {
  role: AccessRole;
  displayName: string;
}

const ROLE_COLORS: Record<AccessRole, string> = {
  owner: '#f59e0b',
  admin: '#8b5cf6',
  editor: '#3b82f6',
  creator: '#10b981',
  viewer: '#6b7280',
};

export function PermissionBadge({ role, displayName }: PermissionBadgeProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme, role);

  return (
    <div style={s.container}>
      <span style={s.name}>{displayName}</span>
      <span style={s.dot}>&middot;</span>
      <span style={s.role}>{ROLE_LABELS[role]}</span>
    </div>
  );
}

function makeStyles(t: Theme, role: AccessRole): Record<string, React.CSSProperties> {
  const color = ROLE_COLORS[role];
  return {
    container: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden',
      flexShrink: 1,
      minWidth: 0,
    },
    name: {
      color: t.textSecondary,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    },
    dot: {
      color: t.textMuted,
    },
    role: {
      color,
      fontWeight: 500,
    },
  };
}
