import { useEffect, useState, useRef } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';

interface ClientListProps {
  selected: string | null;
  onSelect: (target: string) => void;
}

export function ClientList({ selected, onSelect }: ClientListProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [records, setRecords] = useState<EoState[]>([]);
  const prevRecordsKeyRef = useRef<string>('');
  const { theme } = useTheme();
  const s = makeStyles(theme);

  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('app.').then((states) => {
      // Show record-level entries (3 segments: app.table.rec)
      // Filter out aliases and sub-field entries
      const filtered = states.filter((st) => {
        const parts = st.target.split('.');
        return parts.length === 3 && !st.value?._alias;
      });
      const key = filtered.map(r => r.target + ':' + r.last_seq).join('|');
      if (key !== prevRecordsKeyRef.current) {
        prevRecordsKeyRef.current = key;
        setRecords(filtered);
      }
    });
  }, [ready, lastSeq, getStateByPrefix]);

  // Group by collection (second segment)
  const grouped = new Map<string, EoState[]>();
  for (const rec of records) {
    const collection = rec.target.split('.').slice(0, 2).join('.');
    const list = grouped.get(collection) || [];
    list.push(rec);
    grouped.set(collection, list);
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>Records</span>
        <span style={s.count}>{records.length}</span>
      </div>
      <div style={s.scroll}>
        {records.length === 0 && (
          <div style={s.empty}>No records yet</div>
        )}
        {Array.from(grouped.entries()).map(([collection, items]) => (
          <div key={collection}>
            <div style={s.groupHeader}>{collection}</div>
            {items.map((rec) => {
              const isActive = rec.target === selected;
              const value = rec.value || {};
              return (
                <div
                  key={rec.target}
                  style={{
                    ...s.item,
                    ...(isActive ? s.itemActive : {}),
                  }}
                  onClick={() => onSelect(rec.target)}
                >
                  <div style={s.name}>
                    {value.name || rec.target.split('.').pop()}
                  </div>
                  <div style={s.meta}>
                    <span style={{ color: value.status === 'active' ? theme.success : theme.textMuted }}>
                      {value.status === 'active' ? '\u25cf' : '\u25cb'}
                    </span>
                    {value.status || rec.last_op}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column' as const,
      height: '100%',
    },
    header: {
      padding: '16px 18px',
      borderBottom: `1px solid ${t.border}`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: { fontWeight: 600, fontSize: 13, color: t.textHeading },
    count: {
      fontSize: 11,
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    scroll: { flex: 1, overflowY: 'auto' as const },
    empty: { padding: 18, fontSize: 13, color: t.textMuted },
    groupHeader: {
      padding: '10px 18px 4px',
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      fontFamily: "'JetBrains Mono', monospace",
    },
    item: {
      padding: '14px 18px',
      cursor: 'pointer',
      borderBottom: `1px solid ${t.border}`,
      transition: 'background .1s',
    } as React.CSSProperties,
    itemActive: {
      background: t.accentBg,
      borderLeft: `3px solid ${t.accent}`,
    } as React.CSSProperties,
    name: { fontWeight: 500, fontSize: 14, color: t.textHeading, marginBottom: 2 },
    meta: { fontSize: 11, color: t.textSecondary, display: 'flex', alignItems: 'center', gap: 6 },
  };
}
