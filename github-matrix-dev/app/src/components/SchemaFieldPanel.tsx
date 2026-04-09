/**
 * SchemaFieldPanel — Right-side panel for editing a schema field.
 *
 * Shows when a row is clicked in SchemaView. Embeds ConstraintComposer
 * and ResolutionPolicyComposer inline (no popups) with horizontal scroll.
 */

import { useState } from 'react';
import { ConstraintComposer } from './ConstraintComposer';
import { ResolutionPolicyComposer, summarizePolicy, type ResolvePolicy } from './ResolutionPolicyComposer';
import { useTheme } from '../theme';
import { formatName } from './scope-picker-utils';
import { getAirtableTypeIcon, getAirtableTypeColor } from './field-type-icons';
import type { FieldSchema } from '../db/schema-rules';

interface SchemaFieldPanelProps {
  fieldKey: string;
  fieldSchema: FieldSchema | undefined;
  onClose: () => void;
  onSaveLabel: (newLabel: string) => void;
  onAddConstraint: (name: string, value: any) => void;
  onRemoveConstraint: (name: string) => void;
  onSetResolution: (policy: ResolvePolicy) => void;
  onClearResolution: () => void;
}

type ActiveSection = 'constraints' | 'resolution' | null;

export function SchemaFieldPanel({
  fieldKey,
  fieldSchema,
  onClose,
  onSaveLabel,
  onAddConstraint,
  onRemoveConstraint,
  onSetResolution,
  onClearResolution,
}: SchemaFieldPanelProps) {
  const { theme } = useTheme();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(fieldSchema?.name || '');
  const [activeSection, setActiveSection] = useState<ActiveSection>('constraints');

  const typeDisplay = fieldSchema?.typeDef?.value?.type || fieldSchema?.ingestedType || '—';
  const formatDisplay = fieldSchema?.typeDef?.value?.format ? ` (${fieldSchema.typeDef.value.format})` : '';
  const displayName = fieldSchema?.name || formatName(fieldKey);

  const currentPolicy: ResolvePolicy | null = fieldSchema?.resolve?.value?.stances
    ? (fieldSchema.resolve.value as ResolvePolicy)
    : fieldSchema?.resolve?.value?.strategy
      ? { stances: [{ stance: 'dissecting', subType: fieldSchema.resolve.value.strategy }] }
      : null;

  const constraintCount = fieldSchema?.constraints.length ?? 0;
  const resolveLabel = currentPolicy ? summarizePolicy(currentPolicy) : 'none';

  function handleNameSubmit(val: string) {
    setEditingName(false);
    onSaveLabel(val.trim());
  }

  function toggleSection(s: 'constraints' | 'resolution') {
    setActiveSection(prev => (prev === s ? null : s));
  }

  return (
    <div style={{
      width: 460,
      minWidth: 460,
      borderLeft: `1px solid ${theme.border}`,
      display: 'flex',
      flexDirection: 'column',
      background: theme.bgCard,
      overflow: 'hidden',
    }}>
      {/* ── Panel header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        borderBottom: `1px solid ${theme.border}`,
        flexShrink: 0,
      }}>
        {/* Type icon chip */}
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 20,
          borderRadius: 4,
          fontSize: 9,
          fontFamily: "'JetBrains Mono', monospace",
          background: theme.bgMuted,
          color: getAirtableTypeColor(typeDisplay),
          flexShrink: 0,
          letterSpacing: '-0.5px',
          border: `1px solid ${theme.borderLight}`,
        }} title={typeDisplay}>
          {getAirtableTypeIcon(typeDisplay)}
        </span>

        {/* Display name — double-click to edit */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingName ? (
            <form
              onSubmit={(e) => { e.preventDefault(); handleNameSubmit(nameValue); }}
              style={{ display: 'flex', gap: 4 }}
            >
              <input
                autoFocus
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onBlur={() => handleNameSubmit(nameValue)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setEditingName(false); setNameValue(fieldSchema?.name || ''); } }}
                style={{
                  flex: 1,
                  padding: '2px 6px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: `1px solid ${theme.accent}`,
                  borderRadius: 3,
                  background: theme.bg,
                  color: theme.textHeading,
                  outline: 'none',
                }}
              />
            </form>
          ) : (
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: theme.textHeading,
                cursor: 'text',
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title="Double-click to edit display name"
              onDoubleClick={() => { setEditingName(true); setNameValue(fieldSchema?.name || ''); }}
            >
              {displayName}
            </span>
          )}
          <span style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: theme.textMuted,
          }}>
            {fieldKey}
          </span>
        </div>

        {/* Type badge */}
        <span style={{
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          background: theme.bgMuted,
          color: getAirtableTypeColor(typeDisplay),
          padding: '2px 6px',
          borderRadius: 4,
          border: `1px solid ${theme.borderLight}`,
          flexShrink: 0,
        }}>
          {typeDisplay}{formatDisplay}
        </span>

        {/* Close */}
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 16,
            color: theme.textMuted,
            padding: '0 2px',
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          &times;
        </button>
      </div>

      {/* ── Scrollable body ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── Constraints section ── */}
        <div style={{ borderBottom: `1px solid ${theme.border}` }}>
          <button
            onClick={() => toggleSection('constraints')}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: theme.textMuted,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              ⊢ CONSTRAINTS
            </span>
            {constraintCount > 0 ? (
              <span style={{
                fontSize: 10,
                fontFamily: "'JetBrains Mono', monospace",
                background: `${theme.accent}15`,
                color: theme.accent,
                padding: '1px 6px',
                borderRadius: 4,
              }}>
                {constraintCount} set
              </span>
            ) : (
              <span style={{ fontSize: 10, color: theme.textMuted }}>none</span>
            )}
            <span style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: theme.textMuted,
            }}>
              {activeSection === 'constraints' ? '▾' : '▸'}
            </span>
          </button>

          {activeSection === 'constraints' && (
            <div style={{ overflowX: 'auto' }}>
              <ConstraintComposer
                embedded
                fieldKey={fieldKey}
                existingConstraints={fieldSchema?.constraints ?? []}
                onAdd={onAddConstraint}
                onRemove={onRemoveConstraint}
                onClose={() => setActiveSection(null)}
              />
            </div>
          )}
        </div>

        {/* ── Resolution section ── */}
        <div>
          <button
            onClick={() => toggleSection('resolution')}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 16px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: theme.textMuted,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              ⊨ RESOLUTION
            </span>
            <span style={{
              fontSize: 10,
              color: currentPolicy ? theme.text : theme.textMuted,
              fontFamily: currentPolicy ? "'JetBrains Mono', monospace" : 'inherit',
            }}>
              {resolveLabel}
            </span>
            <span style={{
              marginLeft: 'auto',
              fontSize: 10,
              color: theme.textMuted,
            }}>
              {activeSection === 'resolution' ? '▾' : '▸'}
            </span>
          </button>

          {activeSection === 'resolution' && (
            <div style={{ overflowX: 'auto' }}>
              <ResolutionPolicyComposer
                embedded
                currentPolicy={currentPolicy}
                onApply={onSetResolution}
                onClear={onClearResolution}
                onClose={() => setActiveSection(null)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
