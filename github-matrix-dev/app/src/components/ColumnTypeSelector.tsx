import { useTheme, type Theme } from '../theme';

const COLUMN_TYPES = [
  { value: 'text', label: 'Text', color: '#7a756d' },
  { value: 'number', label: 'Number', color: '#3b82f6' },
  { value: 'date', label: 'Date', color: '#e67e22' },
  { value: 'select', label: 'Select', color: '#9b59b6' },
  { value: 'boolean', label: 'Boolean', color: '#27ae60' },
  { value: 'object', label: 'Object', color: '#6b7280' },
] as const;

interface ColumnTypeSelectorProps {
  currentType: string;
  /** Whether the current type comes from a schema DEF (true) or data inference (false) */
  isDefined: boolean;
  onSelect: (type: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export function ColumnTypeSelector({
  currentType,
  isDefined,
  onSelect,
  onClear,
  onClose,
}: ColumnTypeSelectorProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>⊢ COLUMN TYPE</span>
        <button style={s.closeBtn} onClick={onClose}>&times;</button>
      </div>
      <div style={s.types}>
        {COLUMN_TYPES.map((ct) => {
          const isActive = currentType === ct.value;
          return (
            <button
              key={ct.value}
              onClick={() => onSelect(ct.value)}
              style={{
                ...s.typeBtn,
                background: isActive ? `${ct.color}15` : 'transparent',
                borderColor: isActive ? ct.color : 'transparent',
                color: isActive ? ct.color : theme.text,
              }}
              onMouseEnter={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
              }}
              onMouseLeave={(e) => {
                if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              <span style={{ ...s.dot, background: ct.color }} />
              <span style={{ flex: 1 }}>{ct.label}</span>
              {isActive && (
                <span style={s.sourceLabel}>
                  {isDefined ? 'defined' : 'inferred'}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {isDefined && (
        <button style={s.clearBtn} onClick={onClear}>
          Clear definition
        </button>
      )}
    </div>
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
    sourceLabel: {
      fontSize: 9,
      fontWeight: 500,
      opacity: 0.6,
      fontFamily: "'JetBrains Mono', monospace",
    },
    clearBtn: {
      display: 'block',
      width: '100%',
      padding: '5px 10px',
      marginTop: 8,
      paddingTop: 8,
      borderTop: `1px solid ${t.border}`,
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
