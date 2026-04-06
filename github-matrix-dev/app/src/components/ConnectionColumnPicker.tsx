/**
 * ConnectionColumnPicker — field picker for connection table columns.
 *
 * Two sections:
 *   1. Fields from the connected entity type (read from its schema DEFs)
 *   2. Edge metadata (edge type, edge created, edge seq) — italicized
 *
 * Checkboxes add/remove columns. The picker reads fields from
 * the connected entity's schema DEFs via getStateByPrefix.
 */

import { useEffect, useState, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { groupSchemaStates, type FieldSchema } from '../db/schema-rules';
import { useTheme, type Theme } from '../theme';
import { formatName } from './scope-picker-utils';
import type { ConnectionColumnDef } from './ConnectionsPanel';

interface ConnectionColumnPickerProps {
  /** The scope path of the connected entity type (e.g. "import.cases") */
  entityScope: string;
  /** Currently active columns */
  activeColumns: ConnectionColumnDef[];
  onToggle: (col: ConnectionColumnDef) => void;
  onClose: () => void;
}

const EDGE_META_OPTIONS: ConnectionColumnDef[] = [
  { key: '_edge.type', label: 'edge type', isEdgeMeta: true },
  { key: '_edge.created', label: 'edge created', isEdgeMeta: true },
  { key: '_edge.seq', label: 'edge seq', isEdgeMeta: true },
];

export function ConnectionColumnPicker({
  entityScope,
  activeColumns,
  onToggle,
  onClose,
}: ConnectionColumnPickerProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  const [entityFields, setEntityFields] = useState<Array<{ key: string; label: string }>>([]);
  const [loading, setLoading] = useState(true);

  const activeKeys = useMemo(() => new Set(activeColumns.map(c => c.key)), [activeColumns]);

  // Load entity schema fields — reads the schema prefix once.
  // Falls back to sampling the first entity's value keys if no schema exists.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      const fields: Array<{ key: string; label: string }> = [];

      try {
        // Try schema DEFs first
        const schemaPrefix = `${entityScope}._schema.`;
        const schemaStates = await getStateByPrefix(schemaPrefix);

        if (schemaStates.length > 0) {
          const grouped = groupSchemaStates(schemaStates, schemaPrefix);
          for (const [fieldKey, fs] of grouped) {
            fields.push({
              key: fieldKey,
              label: fs.name || formatName(fieldKey),
            });
          }
        }

        // If no schema, sample the first entity's keys
        if (fields.length === 0) {
          const entities = await getStateByPrefix(entityScope + '.');
          const sample = entities.find(e =>
            !e.target.includes('._schema.') &&
            !e.value?._alias &&
            e.value && typeof e.value === 'object',
          );
          if (sample) {
            for (const key of Object.keys(sample.value)) {
              if (!key.startsWith('_')) {
                fields.push({ key, label: formatName(key) });
              }
            }
          }
        }
      } catch { /* use empty fields */ }

      if (!cancelled) {
        // Sort: name first, then alphabetical
        fields.sort((a, b) => {
          if (a.key === 'name') return -1;
          if (b.key === 'name') return 1;
          return a.label.localeCompare(b.label);
        });
        setEntityFields(fields);
        setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [entityScope, getStateByPrefix]);

  const collectionLabel = formatName(entityScope.split('.').pop() || entityScope);

  return (
    <>
      <div style={s.backdrop} onClick={onClose} />
      <div style={s.panel}>
        {/* Entity fields section */}
        <div style={s.sectionHeader}>Fields from {collectionLabel}</div>
        {loading ? (
          <div style={s.loadingText}>Loading fields...</div>
        ) : entityFields.length === 0 ? (
          <div style={s.loadingText}>No fields found</div>
        ) : (
          <div style={s.list}>
            {entityFields.map((field) => (
              <label key={field.key} style={s.row}>
                <input
                  type="checkbox"
                  checked={activeKeys.has(field.key)}
                  onChange={() => onToggle({ key: field.key, label: field.label })}
                  style={s.checkbox}
                />
                <span>{field.label}</span>
              </label>
            ))}
          </div>
        )}

        {/* Edge metadata section */}
        <div style={{ ...s.sectionHeader, marginTop: 12 }}>Edge metadata</div>
        <div style={s.list}>
          {EDGE_META_OPTIONS.map((col) => (
            <label key={col.key} style={{ ...s.row, fontStyle: 'italic' }}>
              <input
                type="checkbox"
                checked={activeKeys.has(col.key)}
                onChange={() => onToggle(col)}
                style={s.checkbox}
              />
              <span>{col.label}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    backdrop: {
      position: 'fixed' as const,
      inset: 0,
      zIndex: 9998,
    },
    panel: {
      position: 'absolute' as const,
      right: 0,
      top: '100%',
      marginTop: 4,
      zIndex: 9999,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      boxShadow: `0 8px 30px ${t.shadow}`,
      padding: 12,
      minWidth: 220,
      maxHeight: 360,
      overflowY: 'auto' as const,
    },
    sectionHeader: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
      marginBottom: 6,
    },
    list: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 2,
    },
    row: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '4px 4px',
      borderRadius: 4,
      fontSize: 12,
      color: t.text,
      cursor: 'pointer',
    },
    checkbox: {
      accentColor: t.accent,
    },
    loadingText: {
      fontSize: 11,
      color: t.textMuted,
      padding: '4px 0',
    },
  };
}
