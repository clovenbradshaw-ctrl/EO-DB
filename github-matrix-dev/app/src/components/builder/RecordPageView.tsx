/**
 * RecordPageView — Renders a record page with its blocks in live mode,
 * wrapping everything in a DataBindingProvider so all blocks automatically
 * get @ = the current record.
 *
 * Used when navigating from a list page to a record page,
 * or when previewing a record page in the builder.
 */

import { useEffect, useState, useRef } from 'react';
import { useEoStore } from '../../store/eo-store';
import { useBuilderStore } from '../../store/builder-store';
import { BlockRenderer } from '../../blocks/BlockRenderer';
import { DataBindingProvider } from '../../contexts/DataBindingContext';
import { useTheme, type Theme } from '../../theme';
import type { EoState } from '../../db/types';
import type { ViewDefinition } from '../../blocks/types';
import { formatName } from '../scope-picker-utils';

interface RecordPageViewProps {
  /** The record target to display (e.g., "app.tblClients.rec001") */
  recordTarget: string;
  /** Callback to navigate to another record */
  onNavigate?: (target: string) => void;
  /** Callback to go back */
  onBack?: () => void;
}

export function RecordPageView({ recordTarget, onNavigate, onBack }: RecordPageViewProps) {
  const getState = useEoStore((s) => s.getState);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const pageType = useBuilderStore((s) => s.pageType);
  const blocks = useBuilderStore((s) => s.blocks);
  const viewName = useBuilderStore((s) => s.viewName);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [record, setRecord] = useState<EoState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevRecordKeyRef = useRef<string>('');

  // Load the record state
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    getState(recordTarget)
      .then(state => {
        if (cancelled) return;
        const key = state ? state.target + ':' + state.last_seq : '';
        if (key !== prevRecordKeyRef.current) {
          prevRecordKeyRef.current = key;
          setRecord(state);
        }
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('[RecordPageView] getState failed', err);
        setError(err?.message ?? String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ready, lastSeq, getState, recordTarget]);

  if (loading) {
    return <div style={s.loading}>Loading record...</div>;
  }

  if (error) {
    return <div style={s.error}>Failed to load record: {error}</div>;
  }

  if (!record) {
    return (
      <div style={s.error}>
        <div>Record not found: <code>{recordTarget}</code></div>
        {onBack && <button style={s.backBtn} onClick={onBack}>Back</button>}
      </div>
    );
  }

  const displayName = record.value?.name || formatName(recordTarget.split('.').pop() || '');

  return (
    <DataBindingProvider
      contextItem={record}
      pageRecord={record}
      pageType="record"
    >
      <div style={s.container}>
        {/* Header */}
        <div style={s.header}>
          {onBack && (
            <button style={s.backBtn} onClick={onBack}>
              &#8592; Back
            </button>
          )}
          <div style={s.headerInfo}>
            <div style={s.recordName}>{displayName}</div>
            <div style={s.recordPath}>{recordTarget}</div>
          </div>
          <span style={s.badge}>RECORD</span>
        </div>

        {/* Rendered blocks */}
        <div style={s.content}>
          <div style={s.contentInner}>
            {blocks.length > 0 ? (
              <BlockRenderer />
            ) : (
              <div style={s.empty}>
                This record page has no blocks yet. Open the builder to add blocks.
              </div>
            )}
          </div>
        </div>
      </div>
    </DataBindingProvider>
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
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '14px 24px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
    },
    headerInfo: {
      flex: 1,
    },
    recordName: {
      fontSize: 16,
      fontWeight: 600,
      color: t.text,
    },
    recordPath: {
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      marginTop: 2,
    },
    badge: {
      fontSize: 9,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      padding: '3px 8px',
      borderRadius: 4,
      background: '#E6F1FB',
      color: '#185FA5',
      flexShrink: 0,
    },
    backBtn: {
      padding: '6px 12px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: 'transparent',
      color: t.textSecondary,
      cursor: 'pointer',
      fontFamily: "'Outfit', sans-serif",
      flexShrink: 0,
    },
    content: {
      flex: 1,
      overflowY: 'auto' as const,
      padding: 24,
    },
    contentInner: {
      maxWidth: 960,
      margin: '0 auto',
    },
    loading: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      color: t.textMuted,
      fontSize: 14,
    },
    error: {
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      height: '100%',
      color: t.danger,
      fontSize: 14,
    },
    empty: {
      padding: 40,
      textAlign: 'center' as const,
      color: t.textMuted,
      fontSize: 14,
    },
  };
}
