/**
 * Inline formula editor popover for defining computed columns.
 *
 * Supports Airtable-style formula syntax:
 *   {Field Name} references, functions like IF(), SUM(), CONCATENATE(),
 *   arithmetic operators, string concat (&), comparisons.
 *
 * Shows a live preview of the formula result using the first record's data.
 */

import { useState, useEffect, useRef } from 'react';
import { useTheme, type Theme } from '../theme';
import { evaluateFormula, extractFieldReferences } from '../db/formula-engine';
import type { ColumnDef } from './filter-types';

interface FormulaEditorProps {
  fieldKey: string;
  currentFormula?: string;
  columns: ColumnDef[];
  /** Sample field values from the first record, for live preview. */
  sampleFields?: Record<string, any>;
  onSave: (formula: string) => void;
  onClear?: () => void;
  onClose: () => void;
}

export function FormulaEditor({
  fieldKey,
  currentFormula,
  columns,
  sampleFields,
  onSave,
  onClear,
  onClose,
}: FormulaEditorProps) {
  const { theme } = useTheme();
  const [formula, setFormula] = useState(currentFormula || '');
  const [preview, setPreview] = useState<any>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [refs, setRefs] = useState<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Live preview
  useEffect(() => {
    if (!formula.trim()) {
      setPreview(null);
      setPreviewError(null);
      setRefs([]);
      return;
    }

    try {
      const fieldRefs = extractFieldReferences(formula);
      setRefs(fieldRefs);

      if (sampleFields) {
        const result = evaluateFormula(formula, { fields: sampleFields });
        if (result === '#ERROR!') {
          setPreviewError('Formula error');
          setPreview(null);
        } else {
          setPreview(result);
          setPreviewError(null);
        }
      }
    } catch (e: any) {
      setPreviewError(e.message || 'Parse error');
      setPreview(null);
    }
  }, [formula, sampleFields]);

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const s = makeStyles(theme);

  function insertFieldRef(fieldKey: string) {
    const ref = `{${fieldKey}}`;
    const el = inputRef.current;
    if (el) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const newVal = formula.slice(0, start) + ref + formula.slice(end);
      setFormula(newVal);
      // Restore cursor after the inserted ref
      setTimeout(() => {
        el.selectionStart = el.selectionEnd = start + ref.length;
        el.focus();
      }, 0);
    } else {
      setFormula(formula + ref);
    }
  }

  return (
    <div style={s.container}>
      <div style={s.header}>
        <span style={s.title}>Formula for "{fieldKey}"</span>
        <button onClick={onClose} style={s.closeBtn}>x</button>
      </div>

      {/* Formula input */}
      <textarea
        ref={inputRef}
        value={formula}
        onChange={(e) => setFormula(e.target.value)}
        placeholder='e.g. IF({Status} = "active", {Amount} * 1.1, 0)'
        rows={3}
        style={s.input}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (formula.trim()) onSave(formula.trim());
          }
          if (e.key === 'Escape') onClose();
        }}
      />

      {/* Field reference pills */}
      <div style={s.fieldList}>
        <div style={s.fieldListLabel}>Insert field:</div>
        <div style={s.fieldPills}>
          {columns
            .filter(c => c.key !== '_record' && c.key !== '_last_updated' && c.key !== fieldKey)
            .map(c => (
              <button
                key={c.key}
                onClick={() => insertFieldRef(c.key)}
                style={{
                  ...s.fieldPill,
                  ...(refs.includes(c.key) ? { borderColor: theme.accent, color: theme.accent } : {}),
                }}
              >
                {c.label}
              </button>
            ))
          }
        </div>
      </div>

      {/* Preview */}
      {(preview !== null || previewError) && (
        <div style={s.preview}>
          <span style={s.previewLabel}>Preview:</span>
          {previewError
            ? <span style={s.previewError}>{previewError}</span>
            : <span style={s.previewValue}>{typeof preview === 'object' ? JSON.stringify(preview) : String(preview)}</span>
          }
        </div>
      )}

      {/* Actions */}
      <div style={s.actions}>
        {onClear && currentFormula && (
          <button onClick={onClear} style={s.clearBtn}>Remove formula</button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={onClose} style={s.cancelBtn}>Cancel</button>
        <button
          onClick={() => { if (formula.trim()) onSave(formula.trim()); }}
          disabled={!formula.trim()}
          style={{
            ...s.saveBtn,
            opacity: formula.trim() ? 1 : 0.5,
          }}
        >
          Save
        </button>
      </div>

      {/* Quick reference */}
      <div style={s.help}>
        <span style={s.helpTitle}>Quick reference</span>
        <div style={s.helpGrid}>
          <span>IF(cond, yes, no)</span>
          <span>SUM(a, b, ...)</span>
          <span>CONCATENATE(a, b)</span>
          <span>LEFT(text, n)</span>
          <span>ROUND(n, digits)</span>
          <span>TODAY()</span>
          <span>DATETIME_DIFF(d1, d2, "days")</span>
          <span>SWITCH(expr, val1, res1, ...)</span>
          <span>AND() / OR() / NOT()</span>
          <span>UPPER() / LOWER() / TRIM()</span>
          <span>LEN() / FIND() / SUBSTITUTE()</span>
          <span>MIN() / MAX() / AVERAGE()</span>
        </div>
        <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 4 }}>
          Use {'{'}<em>Field Name</em>{'}'} to reference fields. Cmd+Enter to save.
        </div>
      </div>
    </div>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      padding: 16,
      minWidth: 380,
      maxWidth: 480,
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    title: {
      fontSize: 13,
      fontWeight: 600,
      color: t.textHeading,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 14,
      color: t.textMuted,
      cursor: 'pointer',
      padding: '2px 6px',
    },
    input: {
      width: '100%',
      padding: '8px 10px',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      background: t.bg,
      color: t.text,
      outline: 'none',
      resize: 'vertical' as const,
      boxSizing: 'border-box' as const,
      lineHeight: 1.5,
    },
    fieldList: {
      marginTop: 8,
    },
    fieldListLabel: {
      fontSize: 10,
      color: t.textMuted,
      marginBottom: 4,
    },
    fieldPills: {
      display: 'flex',
      flexWrap: 'wrap' as const,
      gap: 4,
      maxHeight: 80,
      overflowY: 'auto' as const,
    },
    fieldPill: {
      padding: '2px 8px',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      border: `1px solid ${t.borderLight}`,
      borderRadius: 4,
      background: t.bgMuted,
      color: t.textSecondary,
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
    },
    preview: {
      marginTop: 8,
      padding: '6px 10px',
      borderRadius: 4,
      background: t.bgMuted,
      fontSize: 12,
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
    },
    previewLabel: {
      fontSize: 10,
      color: t.textMuted,
      fontWeight: 500,
    },
    previewValue: {
      fontFamily: "'JetBrains Mono', monospace",
      color: t.teal,
      fontSize: 12,
    },
    previewError: {
      color: t.dangerText,
      fontSize: 11,
    },
    actions: {
      display: 'flex',
      gap: 8,
      marginTop: 12,
      alignItems: 'center',
    },
    cancelBtn: {
      padding: '4px 12px',
      fontSize: 12,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.text,
      cursor: 'pointer',
    },
    saveBtn: {
      padding: '4px 12px',
      fontSize: 12,
      border: 'none',
      borderRadius: 4,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      fontWeight: 500,
    },
    clearBtn: {
      padding: '4px 12px',
      fontSize: 11,
      border: `1px solid ${t.dangerBorder}`,
      borderRadius: 4,
      background: 'transparent',
      color: t.dangerText,
      cursor: 'pointer',
    },
    help: {
      marginTop: 12,
      paddingTop: 8,
      borderTop: `1px solid ${t.border}`,
    },
    helpTitle: {
      fontSize: 10,
      fontWeight: 600,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
    },
    helpGrid: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '2px 12px',
      marginTop: 4,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
    },
  };
}
