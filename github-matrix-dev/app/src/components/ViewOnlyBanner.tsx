/**
 * Persistent "View only" banner for users with Viewer role (PL 0).
 * Similar to Google Docs' read-only indicator.
 */

import { useTheme, type Theme } from '../theme';

export function ViewOnlyBanner() {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.banner}>
      <span style={s.icon}>&#128274;</span>
      <span style={s.text}>View only — You can view but not edit</span>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    banner: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      padding: '6px 16px',
      background: t.bgMuted,
      borderBottom: `1px solid ${t.border}`,
      fontSize: 12,
      fontFamily: "'Outfit', system-ui, sans-serif",
      flexShrink: 0,
    },
    icon: {
      fontSize: 13,
    },
    text: {
      color: t.textSecondary,
      fontWeight: 500,
    },
  };
}
