import { useState } from 'react';
import { useTheme, type Theme } from '../theme';

const PAGE_TYPES = [
  { value: 'metric', label: 'Metric', color: '#0e8a6e' },
  { value: 'note', label: 'Note', color: '#7c5cbf' },
  { value: 'task', label: 'Task', color: '#1a6dd4' },
  { value: 'contact', label: 'Contact', color: '#c2700a' },
  { value: 'event', label: 'Event', color: '#d9487a' },
  { value: 'document', label: 'Document', color: '#8b6834' },
  { value: 'resource', label: 'Resource', color: '#16a34a' },
] as const;

interface TypeSelectorProps {
  currentType?: string;
  onSelect: (type: string) => void;
  onClose: () => void;
}

export function TypeSelector({ currentType, onSelect, onClose }: TypeSelectorProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [customType, setCustomType] = useState('');

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>PAGE TYPE</span>
        <button style={s.closeBtn} onClick={onClose}>&times;</button>
      </div>
      <div style={s.types}>
        {PAGE_TYPES.map((pt) => {
          const isActive = currentType === pt.value;
          return (
            <button
              key={pt.value}
              onClick={() => onSelect(pt.value)}
              style={{
                ...s.typeBtn,
                background: isActive ? `${pt.color}15` : 'transparent',
                borderColor: isActive ? pt.color : theme.border,
                color: isActive ? pt.color : theme.text,
              }}
              onMouseEnter={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
              }}
              onMouseLeave={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              <span style={{ ...s.dot, background: pt.color }} />
              {pt.label}
            </button>
          );
        })}
      </div>
      <div style={s.customRow}>
        <input
          style={s.customInput}
          value={customType}
          onChange={(e) => setCustomType(e.target.value)}
          placeholder="Custom type..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && customType.trim()) {
              onSelect(customType.trim().toLowerCase());
            }
          }}
        />
        <button
          style={{
            ...s.customBtn,
            opacity: customType.trim() ? 1 : 0.4,
          }}
          disabled={!customType.trim()}
          onClick={() => {
            if (customType.trim()) onSelect(customType.trim().toLowerCase());
          }}
        >
          Set
        </button>
      </div>
      {currentType && (
        <button
          style={s.clearBtn}
          onClick={() => onSelect('')}
        >
          Clear type
        </button>
      )}
    </div>
  );
}

/** Small inline badge showing the current type */
export function TypeBadge({ type }: { type: string }) {
  const pt = PAGE_TYPES.find((p) => p.value === type);
  const color = pt?.color || '#7a756d';
  const label = pt?.label || type;

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 500,
      background: `${color}15`,
      color,
      border: `1px solid ${color}30`,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
      }} />
      {label}
    </span>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      padding: 12,
      minWidth: 200,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
    },
    title: {
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.08em',
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '0 2px',
      lineHeight: 1,
    },
    types: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    },
    typeBtn: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      padding: '6px 10px',
      border: '1px solid transparent',
      borderRadius: 6,
      cursor: 'pointer',
      fontSize: 12,
      fontFamily: 'inherit',
      textAlign: 'left' as const,
      transition: 'background 0.1s',
    },
    dot: {
      width: 8,
      height: 8,
      borderRadius: '50%',
      flexShrink: 0,
    },
    customRow: {
      display: 'flex',
      gap: 6,
      marginTop: 8,
      paddingTop: 8,
      borderTop: `1px solid ${t.border}`,
    },
    customInput: {
      flex: 1,
      padding: '5px 8px',
      fontSize: 11,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgMuted,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      outline: 'none',
    },
    customBtn: {
      padding: '5px 10px',
      fontSize: 10,
      fontWeight: 600,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.accent,
      cursor: 'pointer',
      fontFamily: "'JetBrains Mono', monospace",
    },
    clearBtn: {
      display: 'block',
      width: '100%',
      padding: '5px 10px',
      marginTop: 6,
      fontSize: 11,
      border: 'none',
      borderRadius: 4,
      background: 'transparent',
      color: t.danger,
      cursor: 'pointer',
      textAlign: 'left' as const,
      fontFamily: 'inherit',
    },
  };
}
