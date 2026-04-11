import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme, type Theme } from '../theme';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  width?: number | string;
  maxWidth?: number | string;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  footer?: React.ReactNode;
  zIndex?: number;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 420,
  maxWidth = '90vw',
  closeOnBackdrop = true,
  closeOnEsc = true,
  footer,
  zIndex = 9999,
}: ModalProps) {
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKey = (e: KeyboardEvent) => {
      if (closeOnEsc && e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKey);
    };
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  const s = makeStyles(theme);

  return createPortal(
    <>
      <div
        style={{ ...s.backdrop, zIndex: zIndex - 1 }}
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{
          ...s.dialog,
          width: expanded ? '95vw' : width,
          maxWidth: expanded ? '95vw' : maxWidth,
          maxHeight: expanded ? '95vh' : '90vh',
          zIndex,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div style={s.header}>
            <span style={s.title}>{title}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                style={s.expandBtn}
                onClick={() => setExpanded(e => !e)}
                aria-label={expanded ? 'Collapse' : 'Expand'}
                title={expanded ? 'Collapse' : 'Expand to full width'}
              >
                {expanded ? '⊡' : '⊞'}
              </button>
              <button style={s.closeBtn} onClick={onClose} aria-label="Close">
                &times;
              </button>
            </div>
          </div>
        )}
        <div style={s.body}>{children}</div>
        {footer && <div style={s.footer}>{footer}</div>}
      </div>
    </>,
    document.body,
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    backdrop: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.4)',
    },
    dialog: {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      maxHeight: '90vh',
      overflow: 'hidden',
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 8px 30px ${t.shadow}`,
      display: 'flex',
      flexDirection: 'column',
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '12px 16px',
      borderBottom: `1px solid ${t.border}`,
      flexShrink: 0,
    },
    title: {
      fontSize: 13,
      fontWeight: 600,
      fontFamily: "'Outfit', sans-serif",
      color: t.textHeading,
    },
    expandBtn: {
      background: 'none',
      border: 'none',
      fontSize: 14,
      color: t.textMuted,
      cursor: 'pointer',
      padding: 0,
      lineHeight: 1,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 20,
      color: t.textMuted,
      cursor: 'pointer',
      padding: 0,
      lineHeight: 1,
    },
    body: {
      padding: 16,
      flex: 1,
      minHeight: 0,
      overflowY: 'auto',
    },
    footer: {
      padding: '10px 16px',
      borderTop: `1px solid ${t.border}`,
      flexShrink: 0,
    },
  };
}
