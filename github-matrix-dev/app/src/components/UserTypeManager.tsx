/**
 * UserTypeManager — admin panel for defining user types per space.
 *
 * Rendered inside SpaceMembers below field permissions.
 * Only visible to admin+ users.
 */

import { useState } from 'react';
import { useTheme, type Theme } from '../theme';
import type { UserTypeDefinition, HeadlineMetric } from '../permissions/types';
import { UserTypeBadge } from './UserTypeBadge';

interface UserTypeManagerProps {
  typeDefinitions: UserTypeDefinition[];
  availableFields: string[];
  onUpdate: (updated: UserTypeDefinition[]) => void;
  canManage: boolean;
}

const DEFAULT_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#06b6d4', '#84cc16',
];

const AGGREGATION_OPTIONS: { value: HeadlineMetric['aggregation']; label: string }[] = [
  { value: 'count', label: 'Count' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count_distinct', label: 'Count distinct' },
];

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
}

export function UserTypeManager({ typeDefinitions, availableFields, onUpdate, canManage }: UserTypeManagerProps) {
  const { theme } = useTheme();
  const mono = "'JetBrains Mono', monospace";
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState(DEFAULT_COLORS[0]);
  const [newDescription, setNewDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMetrics, setEditMetrics] = useState<HeadlineMetric[]>([]);

  if (!canManage && typeDefinitions.length === 0) return null;

  function handleAdd() {
    if (!newLabel.trim()) return;
    const id = slugify(newLabel);
    if (typeDefinitions.some(t => t.id === id)) return;
    const newDef: UserTypeDefinition = {
      id,
      label: newLabel.trim(),
      color: newColor,
      description: newDescription.trim() || undefined,
    };
    onUpdate([...typeDefinitions, newDef]);
    setNewLabel('');
    setNewDescription('');
    setNewColor(DEFAULT_COLORS[(typeDefinitions.length + 1) % DEFAULT_COLORS.length]);
    setAdding(false);
  }

  function handleDelete(id: string) {
    onUpdate(typeDefinitions.filter(t => t.id !== id));
  }

  function handleStartEditMetrics(def: UserTypeDefinition) {
    setEditingId(def.id);
    setEditMetrics(def.headline_metrics ? [...def.headline_metrics] : []);
  }

  function handleSaveMetrics() {
    if (!editingId) return;
    onUpdate(typeDefinitions.map(t =>
      t.id === editingId
        ? { ...t, headline_metrics: editMetrics.length > 0 ? editMetrics : undefined }
        : t
    ));
    setEditingId(null);
    setEditMetrics([]);
  }

  function addMetric() {
    setEditMetrics(prev => [
      ...prev,
      { label: '', field: availableFields[0] || '', aggregation: 'count' as const },
    ]);
  }

  function updateMetric(index: number, patch: Partial<HeadlineMetric>) {
    setEditMetrics(prev => prev.map((m, i) => i === index ? { ...m, ...patch } : m));
  }

  function removeMetric(index: number) {
    setEditMetrics(prev => prev.filter((_, i) => i !== index));
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: mono,
          fontSize: 11,
          fontWeight: 600,
          color: theme.textSecondary,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
          <path d="M3 1.5L7 5L3 8.5" stroke={theme.textMuted} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        User types
        <span style={{
          fontFamily: mono, fontSize: 10, fontWeight: 500,
          color: theme.textMuted, background: theme.bgMuted,
          padding: '1px 6px', borderRadius: 10,
        }}>
          {typeDefinitions.length}
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: 8 }}>
          {/* Existing types */}
          {typeDefinitions.map((def) => (
            <div key={def.id} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderBottom: `1px solid ${theme.border}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UserTypeBadge label={def.label} color={def.color} />
                {def.description && (
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>
                    {def.description}
                  </span>
                )}
                {def.headline_metrics && def.headline_metrics.length > 0 && (
                  <span style={{
                    fontFamily: mono, fontSize: 9, color: theme.accent,
                    background: theme.accentBg, padding: '1px 5px', borderRadius: 4,
                  }}>
                    {def.headline_metrics.length} metric{def.headline_metrics.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              {canManage && (
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={() => handleStartEditMetrics(def)}
                    style={{
                      fontFamily: mono, fontSize: 9, color: theme.accent,
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = theme.accentBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                  >
                    metrics
                  </button>
                  <button
                    onClick={() => handleDelete(def.id)}
                    style={{
                      fontFamily: mono, fontSize: 9, color: theme.danger,
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '2px 6px', borderRadius: 4,
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = theme.dangerBg}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                  >
                    remove
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Metrics editor */}
          {editingId && (
            <div style={{
              margin: '8px 0',
              padding: 10,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
            }}>
              <div style={{ fontFamily: mono, fontSize: 10, fontWeight: 600, color: theme.textSecondary, marginBottom: 6 }}>
                Headline metrics for "{typeDefinitions.find(t => t.id === editingId)?.label}"
              </div>
              {editMetrics.map((m, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                  <input
                    value={m.label}
                    onChange={(e) => updateMetric(i, { label: e.target.value })}
                    placeholder="Label..."
                    style={{
                      flex: 1, fontFamily: mono, fontSize: 10,
                      padding: '4px 6px', background: theme.bgCard,
                      border: `1px solid ${theme.border}`, borderRadius: 4,
                      color: theme.text, outline: 'none',
                    }}
                  />
                  <select
                    value={m.field}
                    onChange={(e) => updateMetric(i, { field: e.target.value })}
                    style={{
                      fontFamily: mono, fontSize: 10,
                      padding: '4px 6px', background: theme.bgCard,
                      border: `1px solid ${theme.border}`, borderRadius: 4,
                      color: theme.text,
                    }}
                  >
                    <option value="">—field—</option>
                    {availableFields.map(f => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </select>
                  <select
                    value={m.aggregation}
                    onChange={(e) => updateMetric(i, { aggregation: e.target.value as HeadlineMetric['aggregation'] })}
                    style={{
                      fontFamily: mono, fontSize: 10,
                      padding: '4px 6px', background: theme.bgCard,
                      border: `1px solid ${theme.border}`, borderRadius: 4,
                      color: theme.text,
                    }}
                  >
                    {AGGREGATION_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeMetric(i)}
                    style={{
                      fontFamily: mono, fontSize: 11, color: theme.danger,
                      background: 'none', border: 'none', cursor: 'pointer',
                    }}
                  >&times;</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                <button
                  onClick={addMetric}
                  style={{
                    fontFamily: mono, fontSize: 10, color: theme.accent,
                    background: theme.accentBg, border: `1px solid ${theme.accentBorder}`,
                    borderRadius: 4, padding: '3px 8px', cursor: 'pointer',
                  }}
                >
                  + Add metric
                </button>
                <button
                  onClick={handleSaveMetrics}
                  style={{
                    fontFamily: mono, fontSize: 10, color: '#fff',
                    background: theme.accent, border: 'none',
                    borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => { setEditingId(null); setEditMetrics([]); }}
                  style={{
                    fontFamily: mono, fontSize: 10, color: theme.textMuted,
                    background: 'none', border: 'none', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Add new type */}
          {canManage && !adding && (
            <button
              onClick={() => setAdding(true)}
              style={{
                fontFamily: mono, fontSize: 10, color: theme.accent,
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '6px 0',
              }}
            >
              + Add user type
            </button>
          )}

          {canManage && adding && (
            <div style={{
              margin: '8px 0',
              padding: 10,
              background: theme.bg,
              border: `1px solid ${theme.border}`,
              borderRadius: 8,
            }}>
              <input
                autoFocus
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }}
                placeholder="Type label (e.g. HR Manager)..."
                style={{
                  width: '100%', fontFamily: mono, fontSize: 11,
                  padding: '6px 8px', background: theme.bgCard,
                  border: `1px solid ${theme.border}`, borderRadius: 4,
                  color: theme.text, outline: 'none', marginBottom: 6,
                  boxSizing: 'border-box' as const,
                }}
              />
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional)..."
                style={{
                  width: '100%', fontFamily: mono, fontSize: 10,
                  padding: '4px 8px', background: theme.bgCard,
                  border: `1px solid ${theme.border}`, borderRadius: 4,
                  color: theme.text, outline: 'none', marginBottom: 6,
                  boxSizing: 'border-box' as const,
                }}
              />
              {/* Color picker */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                {DEFAULT_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    style={{
                      width: 20, height: 20, borderRadius: '50%',
                      background: c, border: newColor === c ? '2px solid #fff' : '2px solid transparent',
                      boxShadow: newColor === c ? `0 0 0 2px ${c}` : 'none',
                      cursor: 'pointer', padding: 0,
                    }}
                  />
                ))}
              </div>
              {newLabel.trim() && (
                <div style={{ marginBottom: 8 }}>
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted }}>Preview: </span>
                  <UserTypeBadge label={newLabel.trim()} color={newColor} />
                  <span style={{ fontFamily: mono, fontSize: 9, color: theme.textMuted, marginLeft: 6 }}>
                    id: {slugify(newLabel)}
                  </span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleAdd}
                  disabled={!newLabel.trim()}
                  style={{
                    fontFamily: mono, fontSize: 10, fontWeight: 600,
                    color: '#fff', background: newLabel.trim() ? theme.accent : theme.textMuted,
                    border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer',
                  }}
                >
                  Add type
                </button>
                <button
                  onClick={() => setAdding(false)}
                  style={{
                    fontFamily: mono, fontSize: 10, color: theme.textMuted,
                    background: 'none', border: 'none', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
