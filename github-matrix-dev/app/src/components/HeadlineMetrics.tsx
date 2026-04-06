/**
 * HeadlineMetrics — type-scoped metric cards displayed above the table.
 *
 * Each UserTypeDefinition can configure headline_metrics that show
 * aggregate values (count, sum, avg, etc.) computed from current records.
 */

import { useMemo } from 'react';
import { useTheme, type Theme } from '../theme';
import type { HeadlineMetric } from '../permissions/types';
import type { EoState } from '../db/types';
import { getFieldValue, hasFieldsSubObject } from './filter-types';

interface HeadlineMetricsProps {
  metrics: HeadlineMetric[];
  records: EoState[];
  /** Color of the active user type (for accent styling) */
  typeColor?: string;
}

function computeMetric(
  metric: HeadlineMetric,
  records: EoState[],
  useFieldsSub: boolean,
): string {
  // Apply optional filter
  let filtered = records;
  if (metric.filter_field && metric.filter_value !== undefined) {
    filtered = records.filter(rec => {
      const val = getFieldValue(rec, metric.filter_field!, useFieldsSub);
      return String(val) === metric.filter_value;
    });
  }

  switch (metric.aggregation) {
    case 'count':
      return filtered.length.toLocaleString();

    case 'count_distinct': {
      const seen = new Set<string>();
      for (const rec of filtered) {
        const val = getFieldValue(rec, metric.field, useFieldsSub);
        if (val != null) seen.add(String(val));
      }
      return seen.size.toLocaleString();
    }

    case 'sum': {
      let total = 0;
      for (const rec of filtered) {
        const val = getFieldValue(rec, metric.field, useFieldsSub);
        const num = typeof val === 'number' ? val : parseFloat(String(val));
        if (!isNaN(num)) total += num;
      }
      return formatNumber(total);
    }

    case 'avg': {
      let total = 0;
      let count = 0;
      for (const rec of filtered) {
        const val = getFieldValue(rec, metric.field, useFieldsSub);
        const num = typeof val === 'number' ? val : parseFloat(String(val));
        if (!isNaN(num)) { total += num; count++; }
      }
      return count > 0 ? formatNumber(total / count) : '—';
    }

    case 'min': {
      let min = Infinity;
      for (const rec of filtered) {
        const val = getFieldValue(rec, metric.field, useFieldsSub);
        const num = typeof val === 'number' ? val : parseFloat(String(val));
        if (!isNaN(num) && num < min) min = num;
      }
      return min === Infinity ? '—' : formatNumber(min);
    }

    case 'max': {
      let max = -Infinity;
      for (const rec of filtered) {
        const val = getFieldValue(rec, metric.field, useFieldsSub);
        const num = typeof val === 'number' ? val : parseFloat(String(val));
        if (!isNaN(num) && num > max) max = num;
      }
      return max === -Infinity ? '—' : formatNumber(max);
    }

    default:
      return '—';
  }
}

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function HeadlineMetrics({ metrics, records, typeColor }: HeadlineMetricsProps) {
  const { theme } = useTheme();
  const mono = "'JetBrains Mono', monospace";
  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);
  const accentColor = typeColor || theme.accent;

  const values = useMemo(() =>
    metrics.map(m => computeMetric(m, records, useFieldsSub)),
    [metrics, records, useFieldsSub],
  );

  if (metrics.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '10px 16px',
      overflowX: 'auto',
      borderBottom: `1px solid ${theme.border}`,
      background: theme.bgCard,
    }}>
      {metrics.map((m, i) => (
        <div
          key={`${m.label}-${i}`}
          style={{
            display: 'flex',
            flexDirection: 'column' as const,
            padding: '10px 16px',
            borderRadius: 8,
            background: theme.bg,
            border: `1px solid ${theme.border}`,
            minWidth: 140,
            flexShrink: 0,
          }}
        >
          <span style={{
            fontFamily: mono,
            fontSize: 10,
            fontWeight: 500,
            color: theme.textMuted,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.5px',
            marginBottom: 4,
          }}>
            {m.label}
          </span>
          <span style={{
            fontFamily: mono,
            fontSize: 22,
            fontWeight: 700,
            color: accentColor,
            lineHeight: 1.2,
          }}>
            {values[i]}
          </span>
        </div>
      ))}
    </div>
  );
}
