/**
 * DesignerView — modal designer for configuring record detail layouts.
 *
 * Three sections:
 *   1. Layout type picker (drawer vs full modal)
 *   2. Fields configuration (show/hide, reorder)
 *   3. Connection sections (show/hide sections, configure columns)
 *
 * All changes auto-save via the onSave callback (same live-save pattern
 * as the existing inline edit mode).
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import { useEoStore } from '../store/eo-store';
import { groupSchemaStates } from '../db/schema-rules';
import { useTheme, type Theme } from '../theme';
import { formatName } from './scope-picker-utils';
import type { ConnectionColumnDef } from './ConnectionsPanel';
import {
  type DetailLayout,
  type LayoutDisplayType,
  type ConnectionSectionConfig,
  setLayoutType,
  setVisibleFields,
  addColumn,
  removeColumn,
  toggleSectionHidden,
} from './detail-layout';

interface DesignerViewProps {
  layout: DetailLayout;
  scope: string;
  connectionTypes: string[];
  onSave: (layout: DetailLayout) => void;
  onClose: () => void;
}

const EDGE_META_OPTIONS: ConnectionColumnDef[] = [
  { key: '_edge.type', label: 'edge type', isEdgeMeta: true },
  { key: '_edge.created', label: 'edge created', isEdgeMeta: true },
  { key: '_edge.seq', label: 'edge seq', isEdgeMeta: true },
];

export function DesignerView({ layout, scope, connectionTypes, onSave, onClose }: DesignerViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // ─── Entity fields discovery ────────────────────────────────────────
  const [entityFields, setEntityFields] = useState<Array<{ key: string; label: string }>>([]);
  const [fieldsLoading, setFieldsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setFieldsLoading(true);

    async function load() {
      const fields: Array<{ key: string; label: string }> = [];

      try {
        const schemaPrefix = `${scope}._schema.`;
        const schemaStates = await getStateByPrefix(schemaPrefix);

        if (schemaStates.length > 0) {
          const grouped = groupSchemaStates(schemaStates, schemaPrefix);
          for (const [fieldKey, fs] of grouped) {
            if (fieldKey.startsWith('_')) continue;
            fields.push({ key: fieldKey, label: fs.name || formatName(fieldKey) });
          }
        }

        if (fields.length === 0) {
          const entities = await getStateByPrefix(scope + '.');
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
      } catch { /* use empty */ }

      if (!cancelled) {
        fields.sort((a, b) => {
          if (a.key === 'name') return -1;
          if (b.key === 'name') return 1;
          return a.label.localeCompare(b.label);
        });
        setEntityFields(fields);
        setFieldsLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [scope, getStateByPrefix]);

  // ─── Connection field discovery (per entity) ────────────────────────
  const [connFields, setConnFields] = useState<Record<string, Array<{ key: string; label: string }>>>({});

  useEffect(() => {
    let cancelled = false;
    async function loadAll() {
      const result: Record<string, Array<{ key: string; label: string }>> = {};
      for (const entity of connectionTypes) {
        const fields: Array<{ key: string; label: string }> = [];
        try {
          const parentScope = scope.split('.').slice(0, -1).join('.');
          const entityScope = parentScope ? `${parentScope}.${entity}` : entity;
          const schemaPrefix = `${entityScope}._schema.`;
          const schemaStates = await getStateByPrefix(schemaPrefix);

          if (schemaStates.length > 0) {
            const grouped = groupSchemaStates(schemaStates, schemaPrefix);
            for (const [fieldKey, fs] of grouped) {
              if (fieldKey.startsWith('_')) continue;
              fields.push({ key: fieldKey, label: fs.name || formatName(fieldKey) });
            }
          }

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
        } catch { /* skip */ }

        fields.sort((a, b) => {
          if (a.key === 'name') return -1;
          if (b.key === 'name') return 1;
          return a.label.localeCompare(b.label);
        });
        result[entity] = fields;
      }
      if (!cancelled) setConnFields(result);
    }
    loadAll();
    return () => { cancelled = true; };
  }, [scope, connectionTypes, getStateByPrefix]);

  // ─── Current visible fields ─────────────────────────────────────────
  const fieldsSection = layout.sections.find(sec => sec.type === 'fields');
  const visibleFields = fieldsSection?.type === 'fields' ? fieldsSection.visible : undefined;
  const visibleSet = useMemo(() => visibleFields ? new Set(visibleFields) : null, [visibleFields]);

  const handleToggleField = useCallback((fieldKey: string) => {
    if (!visibleSet) {
      // Currently showing all — switch to showing all except this one
      const all = entityFields.map(f => f.key).filter(k => k !== fieldKey);
      onSave(setVisibleFields(layout, all));
    } else if (visibleSet.has(fieldKey)) {
      const next = visibleFields!.filter(k => k !== fieldKey);
      onSave(setVisibleFields(layout, next.length > 0 ? next : undefined));
    } else {
      onSave(setVisibleFields(layout, [...(visibleFields || []), fieldKey]));
    }
  }, [layout, visibleSet, visibleFields, entityFields, onSave]);

  const handleMoveField = useCallback((fieldKey: string, direction: 'up' | 'down') => {
    const current = visibleFields || entityFields.map(f => f.key);
    const idx = current.indexOf(fieldKey);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= current.length) return;
    const next = [...current];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    onSave(setVisibleFields(layout, next));
  }, [layout, visibleFields, entityFields, onSave]);

  // ─── Layout type ────────────────────────────────────────────────────
  const currentLayoutType = layout.layoutType || 'drawer';

  const handleSetLayoutType = useCallback((type: LayoutDisplayType) => {
    onSave(setLayoutType(layout, type));
  }, [layout, onSave]);

  // ─── Connection column toggle ───────────────────────────────────────
  const handleToggleColumn = useCallback((entity: string, col: ConnectionColumnDef) => {
    const section = layout.sections.find(
      (sec): sec is ConnectionSectionConfig =>
        sec.type === 'connection' && sec.entity === entity,
    );
    const hasCol = section?.columns.some(c => c.key === col.key);
    if (hasCol) {
      onSave(removeColumn(layout, entity, col.key));
    } else {
      onSave(addColumn(layout, entity, col));
    }
  }, [layout, onSave]);

  const handleToggleSection = useCallback((entity: string) => {
    onSave(toggleSectionHidden(layout, entity));
  }, [layout, onSave]);

  // ─── Collapsed sections for connection config ───────────────────────
  const [expandedConn, setExpandedConn] = useState<string | null>(null);

  // ─── Ordered fields list (respects visible ordering) ────────────────
  const orderedFields = useMemo(() => {
    if (!visibleFields) return entityFields;
    const order = [...visibleFields];
    // Add any entity fields not in the visible list at the end
    for (const f of entityFields) {
      if (!order.includes(f.key)) order.push(f.key);
    }
    return order.map(key => entityFields.find(f => f.key === key)).filter(Boolean) as Array<{ key: string; label: string }>;
  }, [visibleFields, entityFields]);

  return (
    <div style={s.container}>
      {/* Section 1: Layout Type */}
      <div style={s.designerSection}>
        <div style={s.sectionHeader}>Layout Type</div>
        <div style={s.layoutCards}>
          <button
            style={{
              ...s.layoutCard,
              ...(currentLayoutType === 'drawer' ? s.layoutCardActive : {}),
            }}
            onClick={() => handleSetLayoutType('drawer')}
          >
            <div style={s.layoutIcon}>
              <svg width="32" height="24" viewBox="0 0 32 24">
                <rect x="0.5" y="0.5" width="31" height="23" rx="2" fill="none" stroke={currentLayoutType === 'drawer' ? theme.accent : theme.textMuted} strokeWidth="1" />
                <rect x="18" y="1" width="13" height="22" rx="1" fill={currentLayoutType === 'drawer' ? theme.accentBg : theme.bgHover} />
              </svg>
            </div>
            <span style={s.layoutLabel}>Side Drawer</span>
          </button>
          <button
            style={{
              ...s.layoutCard,
              ...(currentLayoutType === 'modal' ? s.layoutCardActive : {}),
            }}
            onClick={() => handleSetLayoutType('modal')}
          >
            <div style={s.layoutIcon}>
              <svg width="32" height="24" viewBox="0 0 32 24">
                <rect x="0.5" y="0.5" width="31" height="23" rx="2" fill="none" stroke={currentLayoutType === 'modal' ? theme.accent : theme.textMuted} strokeWidth="1" />
                <rect x="4" y="3" width="24" height="18" rx="2" fill={currentLayoutType === 'modal' ? theme.accentBg : theme.bgHover} />
              </svg>
            </div>
            <span style={s.layoutLabel}>Full Modal</span>
          </button>
        </div>
      </div>

      {/* Section 2: Fields */}
      <div style={s.designerSection}>
        <div style={s.sectionHeader}>Fields</div>
        {fieldsLoading ? (
          <div style={s.loadingText}>Loading fields...</div>
        ) : entityFields.length === 0 ? (
          <div style={s.loadingText}>No fields found</div>
        ) : (
          <div style={s.fieldList}>
            {orderedFields.map((field, idx) => {
              const isVisible = !visibleSet || visibleSet.has(field.key);
              return (
                <div key={field.key} style={s.fieldRow}>
                  <input
                    type="checkbox"
                    checked={isVisible}
                    onChange={() => handleToggleField(field.key)}
                    style={s.checkbox}
                  />
                  <span style={{ ...s.fieldLabel, opacity: isVisible ? 1 : 0.5 }}>{field.label}</span>
                  <div style={s.reorderBtns}>
                    <button
                      style={s.arrowBtn}
                      disabled={idx === 0}
                      onClick={() => handleMoveField(field.key, 'up')}
                      title="Move up"
                    >{'\u25B2'}</button>
                    <button
                      style={s.arrowBtn}
                      disabled={idx === orderedFields.length - 1}
                      onClick={() => handleMoveField(field.key, 'down')}
                      title="Move down"
                    >{'\u25BC'}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 3: Connections */}
      <div style={s.designerSection}>
        <div style={s.sectionHeader}>Connections</div>
        {connectionTypes.length === 0 ? (
          <div style={s.loadingText}>No connections</div>
        ) : (
          <div style={s.connList}>
            {connectionTypes.map(entity => {
              const section = layout.sections.find(
                (sec): sec is ConnectionSectionConfig =>
                  sec.type === 'connection' && sec.entity === entity,
              );
              const isHidden = section?.hidden ?? false;
              const activeKeys = new Set(section?.columns.map(c => c.key) || ['name']);
              const isExpanded = expandedConn === entity;
              const entityFieldList = connFields[entity] || [];

              return (
                <div key={entity} style={s.connSection}>
                  <div style={s.connHeader}>
                    <button
                      style={s.connExpandBtn}
                      onClick={() => setExpandedConn(isExpanded ? null : entity)}
                    >
                      {isExpanded ? '\u25BC' : '\u25B6'} {formatName(entity)}
                    </button>
                    <button
                      style={{
                        ...s.toggleBtn,
                        color: isHidden ? theme.textMuted : theme.accent,
                      }}
                      onClick={() => handleToggleSection(entity)}
                      title={isHidden ? 'Show section' : 'Hide section'}
                    >
                      {isHidden ? '\u25CB' : '\u25C9'}
                    </button>
                  </div>
                  {isExpanded && (
                    <div style={s.connColumns}>
                      <div style={s.connSubHeader}>Columns</div>
                      {entityFieldList.map(field => (
                        <label key={field.key} style={s.connRow}>
                          <input
                            type="checkbox"
                            checked={activeKeys.has(field.key)}
                            onChange={() => handleToggleColumn(entity, { key: field.key, label: field.label })}
                            style={s.checkbox}
                          />
                          <span>{field.label}</span>
                        </label>
                      ))}
                      <div style={{ ...s.connSubHeader, marginTop: 8 }}>Edge metadata</div>
                      {EDGE_META_OPTIONS.map(col => (
                        <label key={col.key} style={{ ...s.connRow, fontStyle: 'italic' }}>
                          <input
                            type="checkbox"
                            checked={activeKeys.has(col.key)}
                            onChange={() => handleToggleColumn(entity, col)}
                            style={s.checkbox}
                          />
                          <span>{col.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 20,
    },
    designerSection: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 8,
    },
    sectionHeader: {
      fontSize: 11,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
    },
    layoutCards: {
      display: 'flex',
      gap: 10,
    },
    layoutCard: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column' as const,
      alignItems: 'center',
      gap: 6,
      padding: '12px 8px',
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      background: t.bgCard,
      cursor: 'pointer',
      transition: 'border-color 0.15s, background 0.15s',
    },
    layoutCardActive: {
      borderColor: t.accent,
      background: t.accentBg,
    },
    layoutIcon: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    layoutLabel: {
      fontSize: 12,
      fontWeight: 500,
      fontFamily: "'Outfit', sans-serif",
      color: t.text,
    },
    fieldList: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 2,
      maxHeight: 240,
      overflowY: 'auto' as const,
    },
    fieldRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 4px',
      borderRadius: 4,
      fontSize: 12,
      fontFamily: "'Outfit', sans-serif",
    },
    fieldLabel: {
      flex: 1,
      color: t.text,
    },
    reorderBtns: {
      display: 'flex',
      gap: 2,
    },
    arrowBtn: {
      background: 'none',
      border: 'none',
      fontSize: 10,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '2px 6px',
      borderRadius: 3,
      lineHeight: 1,
    },
    checkbox: {
      accentColor: t.accent,
    },
    loadingText: {
      fontSize: 11,
      fontFamily: "'Outfit', sans-serif",
      color: t.textMuted,
      padding: '4px 0',
    },
    connList: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    connSection: {
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      overflow: 'hidden',
    },
    connHeader: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '6px 10px',
      background: t.bgHover,
    },
    connExpandBtn: {
      background: 'none',
      border: 'none',
      fontSize: 13,
      fontWeight: 500,
      fontFamily: "'Outfit', sans-serif",
      color: t.text,
      cursor: 'pointer',
      padding: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    toggleBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
    },
    connColumns: {
      padding: '8px 10px',
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 2,
    },
    connSubHeader: {
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
      marginBottom: 4,
    },
    connRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '3px 4px',
      borderRadius: 4,
      fontSize: 12,
      fontFamily: "'Outfit', sans-serif",
      color: t.text,
      cursor: 'pointer',
    },
  };
}
