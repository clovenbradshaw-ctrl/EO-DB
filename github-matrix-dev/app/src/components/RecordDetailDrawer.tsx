import { RecordView } from './RecordView';

interface RecordDetailDrawerProps {
  target: string;
  onClose: () => void;
  onNavigate: (target: string) => void;
}

export function RecordDetailDrawer({ target, onClose, onNavigate }: RecordDetailDrawerProps) {
  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <div style={styles.headerTarget}>{target}</div>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>
        <div style={styles.body}>
          <RecordView target={target} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.3)',
    display: 'flex',
    justifyContent: 'flex-end',
    zIndex: 1000,
  },
  panel: {
    width: 640,
    maxWidth: '100vw',
    height: '100vh',
    background: '#faf9f7',
    borderLeft: '1px solid #e5e2dd',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-4px 0 24px rgba(0,0,0,0.08)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 20px',
    borderBottom: '1px solid #e5e2dd',
    background: '#fff',
    flexShrink: 0,
  },
  headerTarget: {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12,
    color: '#7a756d',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 22,
    color: '#7a756d',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
  },
};
