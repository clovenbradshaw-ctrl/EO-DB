import type { GovernanceEntry } from '../db/types';
import { useTheme, type Theme } from '../theme';

const SCOPE_ICONS: Record<string, string> = {
  direct: '\u22a8',
  collection: '\u0192',
  ancestor: '|',
};

interface GovernanceProps {
  entries: GovernanceEntry[];
  onEdit?: (entry: GovernanceEntry) => void;
}

export function Governance({ entries, onEdit }: GovernanceProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);

  return (
    <div style={s.list}>
      {entries.map((r, i) => (
        <div key={i} style={s.rule}>
          <div style={s.icon}>{SCOPE_ICONS[r.scope] || '\u22a8'}</div>
          <div style={s.text}>
            <div style={s.descRow}>
              <span style={s.desc}>
                {r.formula
                  ? `Formula: ${typeof r.formula === 'string' ? r.formula : JSON.stringify(r.formula)}`
                  : `Strategy: ${r.strategy || 'default'}`}
              </span>
              {r.formula && onEdit && (
                <button style={s.editBtn} onClick={() => onEdit(r)} title="Edit formula">
                  ✎ Edit
                </button>
              )}
            </div>
            <div style={s.scope}>
              {r.scope} scope · {r.target} · {r.mode || 'fold'}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    list: { display: 'flex', flexDirection: 'column', gap: 8 },
    rule: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 12,
      padding: '10px 14px',
      background: t.bgCard,
      border: `1px solid ${t.goldBorder}`,
      borderRadius: 8,
    },
    icon: {
      width: 28,
      height: 28,
      borderRadius: 6,
      background: t.goldBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12,
      flexShrink: 0,
      marginTop: 2,
    },
    text: { flex: 1 },
    descRow: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    desc: { fontSize: 12, color: t.text, fontWeight: 400 },
    editBtn: {
      padding: '2px 8px',
      background: 'transparent',
      border: `1px solid ${t.goldBorder}`,
      borderRadius: 4,
      color: t.gold,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      cursor: 'pointer',
      flexShrink: 0,
    },
    scope: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      marginTop: 2,
    },
  };
}
