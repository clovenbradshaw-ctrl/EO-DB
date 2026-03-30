import { useEffect, useRef } from 'react';
import { useTheme, type Theme } from '../theme';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const ref = useRef<HTMLDivElement>(null);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      ref.current.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight) {
      ref.current.style.top = `${window.innerHeight - rect.height - 8}px`;
    }
  }, [x, y]);

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  return (
    <>
      <div style={s.backdrop} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} style={{ ...s.menu, left: x, top: y }}>
        {items.map((item, i) => {
          if (item.separator) {
            return <div key={i} style={s.separator} />;
          }
          return (
            <button
              key={i}
              style={{
                ...s.item,
                ...(item.danger ? { color: theme.danger } : {}),
                ...(item.disabled ? { opacity: 0.4, pointerEvents: 'none' as const } : {}),
              }}
              onClick={() => { item.onClick(); onClose(); }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = theme.bgHover; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    backdrop: {
      position: 'fixed',
      inset: 0,
      zIndex: 9998,
    },
    menu: {
      position: 'fixed',
      zIndex: 9999,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 4,
      minWidth: 180,
      boxShadow: `0 8px 30px ${t.shadow}, 0 2px 8px ${t.shadow}`,
    },
    item: {
      display: 'block',
      width: '100%',
      padding: '7px 12px',
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      cursor: 'pointer',
      fontSize: 12,
      color: t.text,
      textAlign: 'left' as const,
      fontFamily: 'inherit',
    },
    separator: {
      height: 1,
      margin: '4px 8px',
      background: t.border,
    },
  };
}
