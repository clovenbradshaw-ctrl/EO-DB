import { RecordView } from './RecordView';
import { formatName } from './scope-picker-utils';
import { useTheme, type Theme } from '../theme';

interface RecordDetailDrawerProps {
  target: string;
  onClose: () => void;
  onNavigate: (target: string) => void;
  profileFields?: string[];
  isMobile?: boolean;
}

export function RecordDetailDrawer({ target, onClose, onNavigate, profileFields, isMobile }: RecordDetailDrawerProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const displayName = formatName(target.split('.').pop() || '');

  return (
    <div style={{
      ...s.panel,
      ...(isMobile ? {
        width: '100vw', maxWidth: '100vw',
        position: 'fixed' as const, inset: 0, zIndex: 1000,
        borderLeft: 'none',
      } : {}),
    }}>
      <div style={s.header}>
        {isMobile && (
          <button onClick={onClose} style={s.backBtn}>{'\u2190'} Back</button>
        )}
        <div style={s.headerTarget}>{displayName}</div>
        {!isMobile && <button onClick={onClose} style={s.closeBtn}>&times;</button>}
      </div>
      <div style={s.body}>
        <RecordView target={target} onNavigate={onNavigate} profileFields={profileFields} />
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    panel: {
      width: 640,
      maxWidth: '50vw',
      height: '100%',
      flexShrink: 0,
      background: t.bg,
      borderLeft: `1px solid ${t.border}`,
      display: 'flex',
      flexDirection: 'column',
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '14px 20px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    headerTarget: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      color: t.textSecondary,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      fontSize: 13,
      fontWeight: 500,
      color: t.accent,
      cursor: 'pointer',
      padding: '4px 8px',
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 22,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
    },
    body: {
      flex: 1,
      overflowY: 'auto',
    },
  };
}
