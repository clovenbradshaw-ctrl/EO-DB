import { useEffect, useState } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';

interface ClientListProps {
  selected: string | null;
  onSelect: (target: string) => void;
}

export function ClientList({ selected, onSelect }: ClientListProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const [records, setRecords] = useState<EoState[]>([]);

  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('app.').then((states) => {
      // Show record-level entries (3 segments: app.table.rec)
      // Filter out aliases and sub-field entries
      const filtered = states.filter((s) => {
        const parts = s.target.split('.');
        return parts.length === 3 && !s.value?._alias;
      });
      setRecords(filtered);
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
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Records</span>
        <span style={styles.count}>{records.length}</span>
      </div>
      <div style={styles.scroll}>
        {records.length === 0 && (
          <div style={styles.empty}>No records yet</div>
        )}
        {Array.from(grouped.entries()).map(([collection, items]) => (
          <div key={collection}>
            <div style={styles.groupHeader}>{collection}</div>
            {items.map((rec) => {
              const isActive = rec.target === selected;
              const value = rec.value || {};
              return (
                <div
                  key={rec.target}
                  style={{
                    ...styles.item,
                    ...(isActive ? styles.itemActive : {}),
                  }}
                  onClick={() => onSelect(rec.target)}
                >
                  <div style={styles.name}>
                    {value.name || rec.target.split('.').pop()}
                  </div>
                  <div style={styles.meta}>
                    <span style={styles.statusDot(value.status === 'active')}>
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

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
  },
  header: {
    padding: '16px 18px',
    borderBottom: '1px solid #e5e2dd',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontWeight: 600, fontSize: 13, color: '#1a1816' },
  count: {
    fontSize: 11,
    color: '#aba69e',
    fontFamily: "'JetBrains Mono', monospace",
  },
  scroll: { flex: 1, overflowY: 'auto' as const },
  empty: { padding: 18, fontSize: 13, color: '#aba69e' },
  groupHeader: {
    padding: '10px 18px 4px',
    fontSize: 10,
    fontWeight: 600,
    color: '#aba69e',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    fontFamily: "'JetBrains Mono', monospace",
  },
  item: {
    padding: '14px 18px',
    cursor: 'pointer',
    borderBottom: '1px solid #e5e2dd',
    transition: 'background .1s',
  } as React.CSSProperties,
  itemActive: {
    background: '#eef5fd',
    borderLeft: '3px solid #1a6dd4',
  } as React.CSSProperties,
  name: { fontWeight: 500, fontSize: 14, color: '#1a1816', marginBottom: 2 },
  meta: { fontSize: 11, color: '#7a756d', display: 'flex', alignItems: 'center', gap: 6 },
  statusDot: (active: boolean): React.CSSProperties => ({
    color: active ? '#16a34a' : '#aba69e',
  }),
};
