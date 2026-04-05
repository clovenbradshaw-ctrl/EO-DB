/**
 * RecordBlock — Pins a specific record as the @ context for child blocks.
 *
 * When placed on a page, it fetches a specific record by target path and
 * provides it as the DataBindingContext for all nested child blocks.
 * This means child blocks (tables, lists, headings, etc.) that use
 * connection-mode bindings like @.cases will automatically draw from
 * this record's connections.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTheme, type Theme } from '../../theme';
import { useEoStore } from '../../store/eo-store';
import { DataBindingProvider } from '../../contexts/DataBindingContext';
import { resolveBinding } from '../../components/query-engine';
import type { BlockNode, DataBinding } from '../types';
import type { BuilderMode } from '../../store/builder-store';
import type { EoState } from '../../db/types';
import { BlockList } from '../BlockRenderer';

interface Props {
  block: BlockNode;
  mode: BuilderMode;
}

export function RecordBlock({ block, mode }: Props) {
  const { recordTarget, showHeader = true, headerFields = [], binding } = block.props;
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const getState = useEoStore((st) => st.getState);
  const getStateByPrefix = useEoStore((st) => st.getStateByPrefix);
  const ready = useEoStore((st) => st.ready);

  const [record, setRecord] = useState<EoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve the record — either from a direct target or via a binding
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // If a binding is provided, resolve it to find the record
      if (binding && binding.mode) {
        const allStates = await getStateByPrefix('');
        const result = resolveBinding(binding, allStates);
        if (!cancelled) {
          setRecord(result.records[0] || null);
          setLoading(false);
        }
        return;
      }

      // Otherwise, use the direct target path
      if (recordTarget) {
        const state = await getState(recordTarget);
        if (!cancelled) {
          setRecord(state);
          setLoading(false);
        }
        return;
      }

      if (!cancelled) {
        setRecord(null);
        setLoading(false);
      }
    }

    load().catch(err => {
      if (cancelled) return;
      console.error('[RecordBlock] load failed', err);
      setError(err?.message ?? String(err));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [ready, recordTarget, binding, getState, getStateByPrefix]);

  // Derive display fields from the record
  const displayFields = useMemo(() => {
    if (!record?.value || typeof record.value !== 'object') return [];
    const fields = headerFields.length > 0
      ? headerFields
      : Object.keys(record.value).filter(k => !k.startsWith('_')).slice(0, 4);
    return fields.map((f: string) => ({
      key: f,
      value: record.value[f] ?? record.value?.fields?.[f] ?? '—',
    }));
  }, [record, headerFields]);

  const recordName = record?.value?.name || record?.target?.split('.').pop() || 'Record';

  // Build-mode placeholder when no record is configured
  if (!recordTarget && !binding && mode === 'build') {
    return (
      <div style={s.placeholder}>
        <span style={s.placeholderIcon}>&#9673;</span>
        <span style={s.placeholderText}>Record Block — select a record in the config panel</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={s.container}>
        <div style={s.loading}>Loading record...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={s.container}>
        <div style={s.empty}>Failed to load record: {error}</div>
      </div>
    );
  }

  if (!record) {
    return (
      <div style={s.container}>
        <div style={s.empty}>Record not found: {recordTarget || 'no target'}</div>
      </div>
    );
  }

  return (
    <DataBindingProvider contextItem={record} pageType="record">
      <div style={s.container}>
        {showHeader && (
          <div style={s.header}>
            <div style={s.headerLeft}>
              <span style={s.recordIcon}>&#9673;</span>
              <span style={s.recordName}>{recordName}</span>
            </div>
            <div style={s.targetPath}>{record.target}</div>
          </div>
        )}
        {showHeader && displayFields.length > 0 && (
          <div style={s.fieldsRow}>
            {displayFields.map(({ key, value }: { key: string; value: any }) => (
              <div key={key} style={s.fieldChip}>
                <span style={s.fieldKey}>{key}</span>
                <span style={s.fieldValue}>{String(value)}</span>
              </div>
            ))}
          </div>
        )}
        <div style={s.body}>
          <BlockList
            blocks={block.children || []}
            mode={mode}
            droppableId={`record-${block.id}`}
          />
        </div>
      </div>
    </DataBindingProvider>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 12px',
      borderBottom: `1px solid ${t.borderLight}`,
      background: t.accentBg,
    },
    headerLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    recordIcon: {
      fontSize: 16,
      color: t.accent,
    },
    recordName: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      fontWeight: 600,
      color: t.text,
    },
    targetPath: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
    },
    fieldsRow: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      padding: '6px 12px',
      borderBottom: `1px solid ${t.borderLight}`,
    },
    fieldChip: {
      display: 'flex',
      gap: 4,
      fontSize: 11,
      background: t.bg,
      padding: '2px 8px',
      borderRadius: 4,
      border: `1px solid ${t.borderLight}`,
    },
    fieldKey: {
      color: t.textMuted,
      fontFamily: "'JetBrains Mono', monospace",
    },
    fieldValue: {
      color: t.text,
    },
    body: {
      padding: 12,
    },
    loading: {
      padding: 16,
      color: t.textMuted,
      fontSize: 12,
      textAlign: 'center',
    },
    empty: {
      padding: 16,
      color: t.textMuted,
      fontSize: 12,
      textAlign: 'center',
      fontStyle: 'italic',
    },
    placeholder: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: 16,
      border: `1px dashed ${t.border}`,
      borderRadius: 8,
      background: t.bgCard,
    },
    placeholderIcon: {
      fontSize: 18,
      color: t.textMuted,
    },
    placeholderText: {
      fontSize: 12,
      color: t.textMuted,
    },
  };
}
