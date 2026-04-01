import { RecordView } from './RecordView';
import { useTheme, type Theme } from '../theme';

interface RecordDetailDrawerProps {
  target: string;
  onClose: () => void;
  onNavigate: (target: string) => void;
}

export function RecordDetailDrawer({ target, onClose, onNavigate }: RecordDetailDrawerProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <div style={s.headerTarget}>{target}</div>
        <button onClick={onClose} style={s.closeBtn}>&times;</button>
      </div>
      <div style={s.body}>
        <RecordView target={target} onNavigate={onNavigate} />
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
