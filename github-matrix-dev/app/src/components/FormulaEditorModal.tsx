import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { useTheme, type Theme } from '../theme';

interface FormulaEditorModalProps {
  open: boolean;
  onClose: () => void;
  formula: string;
  onSave: (formula: string) => void;
  target?: string;
  dependencies?: string[];
}

const QUICK_FUNCTIONS = [
  { label: 'Math.min()', snippet: 'Math.min(' },
  { label: 'Math.max()', snippet: 'Math.max(' },
  { label: 'Math.abs()', snippet: 'Math.abs(' },
  { label: 'Math.round()', snippet: 'Math.round(' },
  { label: 'NOW()', snippet: 'NOW()' },
  { label: 'TODAY()', snippet: 'TODAY()' },
];

export function FormulaEditorModal({
  open,
  onClose,
  formula,
  onSave,
  target,
  dependencies,
}: FormulaEditorModalProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const [draft, setDraft] = useState(formula);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep draft in sync when the modal re-opens with a new formula
  const prevOpen = useRef(false);
  if (open && !prevOpen.current) {
    setDraft(formula);
  }
  prevOpen.current = open;

  function insertAtCursor(snippet: string) {
    const el = textareaRef.current;
    if (!el) {
      setDraft(d => d + snippet);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + snippet + draft.slice(end);
    setDraft(next);
    // Restore focus and move cursor after snippet
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function handleSave() {
    onSave(draft.trim());
    onClose();
  }

  const footer = (
    <div style={s.footerRow}>
      <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
      <button style={s.saveBtn} onClick={handleSave} disabled={!draft.trim()}>
        Save Formula
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit Formula"
      width={620}
      closeOnBackdrop={false}
      footer={footer}
    >
      <div style={s.root}>
        {target && (
          <div style={s.targetLine}>
            <span style={s.targetLabel}>Target</span>
            <span style={s.targetValue}>{target}</span>
          </div>
        )}

        <textarea
          ref={textareaRef}
          style={s.textarea}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          spellCheck={false}
          rows={10}
          placeholder="e.g. inputs['revenue'] - inputs['cost']"
        />

        <div style={s.hint}>
          Reference connected fields as{' '}
          <code style={s.code}>inputs['target/path']</code>
        </div>

        <div style={s.section}>
          <div style={s.sectionLabel}>Insert function</div>
          <div style={s.chipRow}>
            {QUICK_FUNCTIONS.map(fn => (
              <button
                key={fn.label}
                style={s.chip}
                onClick={() => insertAtCursor(fn.snippet)}
                title={`Insert ${fn.snippet}`}
              >
                {fn.label}
              </button>
            ))}
          </div>
        </div>

        {dependencies && dependencies.length > 0 && (
          <div style={s.section}>
            <div style={s.sectionLabel}>Available fields — click to insert</div>
            <div style={s.chipRow}>
              {dependencies.map(dep => (
                <button
                  key={dep}
                  style={s.fieldChip}
                  onClick={() => insertAtCursor(`inputs['${dep}']`)}
                  title={`Insert inputs['${dep}']`}
                >
                  {dep}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    root: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    },
    targetLine: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    targetLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
    },
    targetValue: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textSecondary,
    },
    textarea: {
      width: '100%',
      padding: '10px 12px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      lineHeight: 1.6,
      outline: 'none',
      resize: 'vertical' as const,
      boxSizing: 'border-box' as const,
      minHeight: 140,
    },
    hint: {
      fontSize: 11,
      color: t.textMuted,
      marginTop: -4,
    },
    code: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 3,
      padding: '1px 4px',
      color: t.accent,
    },
    section: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 6,
    },
    sectionLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
    },
    chipRow: {
      display: 'flex',
      flexWrap: 'wrap' as const,
      gap: 6,
    },
    chip: {
      padding: '4px 10px',
      background: t.accentBg,
      border: `1px solid ${t.accentBorder}`,
      borderRadius: 4,
      color: t.accent,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      cursor: 'pointer',
      lineHeight: 1.4,
    },
    fieldChip: {
      padding: '4px 10px',
      background: t.goldBg,
      border: `1px solid ${t.goldBorder}`,
      borderRadius: 4,
      color: t.gold,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      cursor: 'pointer',
      lineHeight: 1.4,
      maxWidth: 240,
      overflow: 'hidden' as const,
      textOverflow: 'ellipsis' as const,
      whiteSpace: 'nowrap' as const,
    },
    footerRow: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
    },
    cancelBtn: {
      padding: '8px 18px',
      background: 'transparent',
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      cursor: 'pointer',
    },
    saveBtn: {
      padding: '8px 20px',
      background: t.success,
      border: 'none',
      borderRadius: 6,
      color: '#fff',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
    },
  };
}
