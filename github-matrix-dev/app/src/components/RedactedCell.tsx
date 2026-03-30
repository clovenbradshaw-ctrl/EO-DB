/**
 * Redacted cell — solid black bar for fields the user cannot access.
 *
 * Appears when:
 * - Field data lives in a room the user isn't a member of
 * - Field is encrypted with a segment key the user doesn't hold
 *
 * The column header remains visible so users understand the schema structure.
 */

import { useTheme, type Theme } from '../theme';

interface RedactedCellProps {
  tooltip?: string;
}

export function RedactedCell({ tooltip }: RedactedCellProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <span style={s.container} title={tooltip || "You don't have access to this field"}>
      <span style={s.bar} />
    </span>
  );
}

/**
 * Lock icon indicator for column headers of locked fields.
 */
export function LockIcon() {
  return (
    <span style={{ fontSize: 11, marginRight: 4 }} title="This field is locked">
      &#128274;
    </span>
  );
}

/**
 * Locked cell — visible but non-interactive, with tinted background.
 */
interface LockedCellProps {
  children: React.ReactNode;
  tooltip?: string;
}

export function LockedCell({ children, tooltip }: LockedCellProps) {
  const { theme } = useTheme();
  const s = makeLockedStyles(theme);

  return (
    <span style={s.container} title={tooltip || 'This field can only be edited by Owner and Admin'}>
      {children}
    </span>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'inline-flex',
      alignItems: 'center',
      width: '100%',
      height: '100%',
      cursor: 'not-allowed',
    },
    bar: {
      display: 'block',
      width: '100%',
      height: 14,
      background: '#000',
      borderRadius: 2,
      minWidth: 60,
    },
  };
}

function makeLockedStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'inline-flex',
      alignItems: 'center',
      width: '100%',
      height: '100%',
      opacity: 0.7,
      cursor: 'not-allowed',
      background: t.bgMuted,
      borderRadius: 2,
      padding: '0 4px',
    },
  };
}
