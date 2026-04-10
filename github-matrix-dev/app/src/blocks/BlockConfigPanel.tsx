import { useState, useEffect, useMemo } from 'react';
import { useBuilderStore } from '../store/builder-store';
import { useEoStore } from '../store/eo-store';
import { getRegistration } from './registry';
import { useTheme, type Theme } from '../theme';
import type { BlockNode, BlockId, DataBinding } from './types';
import type { EoState } from '../db/types';
import { ScopePicker } from '../components/ScopePicker';
import { useDataBindingContext } from '../contexts/DataBindingContext';

// ---------------------------------------------------------------------------
// Find block in tree by ID
// ---------------------------------------------------------------------------

function findBlockById(blocks: BlockNode[], id: BlockId): BlockNode | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    if (b.children) {
      const found = findBlockById(b.children, id);
      if (found) return found;
    }
    if (b.slots) {
      for (const slotBlocks of Object.values(b.slots)) {
        const found = findBlockById(slotBlocks, id);
        if (found) return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Config panel — dispatches to per-type config forms
// ---------------------------------------------------------------------------

export function BlockConfigPanel() {
  const selectedBlockId = useBuilderStore((s) => s.selectedBlockId);
  const blocks = useBuilderStore((s) => s.blocks);
  const updateBlockProps = useBuilderStore((s) => s.updateBlockProps);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  if (!selectedBlockId) {
    return (
      <div style={s.empty}>
        <div style={s.emptyText}>Select a block to edit its settings</div>
      </div>
    );
  }

  const block = findBlockById(blocks, selectedBlockId);
  if (!block) return null;

  const reg = getRegistration(block.type);
  const label = reg?.label || block.type;

  const update = (key: string, value: any) => {
    updateBlockProps(block.id, { [key]: value });
  };

  return (
    <div style={s.panel}>
      <div style={s.header}>{label}</div>
      <div style={s.body}>
        <ConfigForm block={block} update={update} theme={theme} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-type config forms
// ---------------------------------------------------------------------------

interface ConfigFormProps {
  block: BlockNode;
  update: (key: string, value: any) => void;
  theme: Theme;
}

function ConfigForm({ block, update, theme }: ConfigFormProps) {
  const s = makeFieldStyles(theme);

  switch (block.type) {
    case 'section':
      return (
        <>
          <Field label="Title" s={s}>
            <input style={s.input} value={block.props.title || ''} onChange={(e) => update('title', e.target.value)} />
          </Field>
          <DataSourceField
            label="Data Context (@)"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            theme={theme}
          />
          <Field label="Border" s={s}>
            <Checkbox checked={block.props.borderVisible !== false} onChange={(v) => update('borderVisible', v)} theme={theme} />
          </Field>
          <Field label="Padding" s={s}>
            <input style={s.input} type="number" value={block.props.padding || 16} onChange={(e) => update('padding', Number(e.target.value))} />
          </Field>
        </>
      );

    case 'columns':
      return (
        <>
          <Field label="Columns" s={s}>
            <select style={s.select} value={block.props.count || 2} onChange={(e) => {
              const count = Number(e.target.value);
              const ratios = Array(count).fill(1);
              const slots: Record<string, any[]> = {};
              for (let i = 0; i < count; i++) slots[`col-${i}`] = block.props.slots?.[`col-${i}`] || [];
              update('count', count);
              update('ratios', ratios);
            }}>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </Field>
          <Field label="Gap (px)" s={s}>
            <input style={s.input} type="number" value={block.props.gap || 16} onChange={(e) => update('gap', Number(e.target.value))} />
          </Field>
        </>
      );

    case 'divider':
      return (
        <>
          <Field label="Thickness" s={s}>
            <input style={s.input} type="number" value={block.props.thickness || 1} onChange={(e) => update('thickness', Number(e.target.value))} />
          </Field>
          <Field label="Margin" s={s}>
            <input style={s.input} type="number" value={block.props.margin || 16} onChange={(e) => update('margin', Number(e.target.value))} />
          </Field>
        </>
      );

    case 'spacer':
      return (
        <Field label="Height (px)" s={s}>
          <input style={s.input} type="number" value={block.props.height || 24} onChange={(e) => update('height', Number(e.target.value))} />
        </Field>
      );

    case 'heading':
      return (
        <>
          <Field label="Level" s={s}>
            <select style={s.select} value={block.props.level || 2} onChange={(e) => update('level', Number(e.target.value))}>
              <option value={1}>H1 — Page title</option>
              <option value={2}>H2 — Section title</option>
              <option value={3}>H3 — Sub-section</option>
            </select>
          </Field>
          <Field label="Text" s={s}>
            <input style={s.input} value={block.props.text || ''} placeholder="Static text or leave empty for binding" onChange={(e) => update('text', e.target.value)} />
          </Field>
          <DataSourceField
            label="Bind text from"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            theme={theme}
          />
          <Field label="Alignment" s={s}>
            <select style={s.select} value={block.props.alignment || 'left'} onChange={(e) => update('alignment', e.target.value)}>
              <option value="left">Left</option>
              <option value="center">Center</option>
            </select>
          </Field>
        </>
      );

    case 'paragraph':
      return (
        <>
          <Field label="Text" s={s}>
            <textarea
              style={{ ...s.input, minHeight: 60, resize: 'vertical' }}
              value={block.props.text || ''}
              placeholder="Static text or leave empty for binding"
              onChange={(e) => update('text', e.target.value)}
            />
          </Field>
          <DataSourceField
            label="Bind text from"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            theme={theme}
          />
          <Field label="Alignment" s={s}>
            <select style={s.select} value={block.props.alignment || 'left'} onChange={(e) => update('alignment', e.target.value)}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </Field>
        </>
      );

    case 'table':
      return (
        <>
          <DataSourceField
            label="Data Source"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => {
              update('binding', binding);
              // Also set scope for backward compatibility
              if (binding.mode === 'hierarchy' && binding.target) {
                update('scope', binding.target);
              }
            }}
            theme={theme}
          />
          <Field label="Scope (legacy)" s={s}>
            <input style={s.input} placeholder="e.g. demo_space.clients" value={block.props.scope || ''} onChange={(e) => update('scope', e.target.value)} />
          </Field>
          <Field label="Search" s={s}>
            <Checkbox checked={block.props.searchEnabled !== false} onChange={(v) => update('searchEnabled', v)} theme={theme} />
          </Field>
          <Field label="Page Size" s={s}>
            <select style={s.select} value={block.props.pageSize || 25} onChange={(e) => update('pageSize', Number(e.target.value))}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </Field>
          <Field label="Empty Text" s={s}>
            <input style={s.input} value={block.props.emptyText || ''} onChange={(e) => update('emptyText', e.target.value)} />
          </Field>
        </>
      );

    case 'calendar':
      return (
        <>
          <DataSourceField
            label="Data Source"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => {
              update('binding', binding);
              if (binding.mode === 'hierarchy' && binding.target) {
                update('scope', binding.target);
              }
            }}
            theme={theme}
          />
          <Field label="Scope (legacy)" s={s}>
            <input
              style={s.input}
              placeholder="e.g. google_calendar.primary_user_gmail_com"
              value={block.props.scope || ''}
              onChange={(e) => update('scope', e.target.value)}
            />
          </Field>
          <Field label="Date Field" s={s}>
            <input
              style={s.input}
              placeholder="e.g. start"
              value={block.props.dateField || 'start'}
              onChange={(e) => update('dateField', e.target.value)}
            />
          </Field>
          <Field label="End Date Field" s={s}>
            <input
              style={s.input}
              placeholder="e.g. end"
              value={block.props.endDateField || 'end'}
              onChange={(e) => update('endDateField', e.target.value)}
            />
          </Field>
          <Field label="Title Field" s={s}>
            <input
              style={s.input}
              placeholder="e.g. summary"
              value={block.props.titleField || 'summary'}
              onChange={(e) => update('titleField', e.target.value)}
            />
          </Field>
          <Field label="Color Field (optional)" s={s}>
            <input
              style={s.input}
              placeholder="Field holding CSS color"
              value={block.props.colorField || ''}
              onChange={(e) => update('colorField', e.target.value)}
            />
          </Field>
          <Field label="Initial View" s={s}>
            <select
              style={s.select}
              value={block.props.viewMode || 'month'}
              onChange={(e) => update('viewMode', e.target.value)}
            >
              <option value="month">Month</option>
              <option value="week">Week</option>
              <option value="day">Day</option>
              <option value="agenda">Agenda</option>
            </select>
          </Field>
          <Field label="Week Starts On" s={s}>
            <select
              style={s.select}
              value={block.props.startDay ?? 0}
              onChange={(e) => update('startDay', Number(e.target.value))}
            >
              <option value={0}>Sunday</option>
              <option value={1}>Monday</option>
            </select>
          </Field>
          <Field label="Empty Text" s={s}>
            <input
              style={s.input}
              value={block.props.emptyText || ''}
              onChange={(e) => update('emptyText', e.target.value)}
            />
          </Field>
        </>
      );

    case 'record':
      return (
        <>
          <Field label="Record Target" s={s}>
            <input
              style={s.input}
              placeholder="e.g. app.tblClients.rec_001"
              value={block.props.recordTarget || ''}
              onChange={(e) => update('recordTarget', e.target.value)}
            />
          </Field>
          <DataSourceField
            label="Or select via binding"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            theme={theme}
          />
          <Field label="Show Header" s={s}>
            <Checkbox checked={block.props.showHeader !== false} onChange={(v) => update('showHeader', v)} theme={theme} />
          </Field>
        </>
      );

    case 'button':
      return (
        <>
          <Field label="Label" s={s}>
            <input style={s.input} value={block.props.label || ''} onChange={(e) => update('label', e.target.value)} />
          </Field>
          <Field label="Style" s={s}>
            <select style={s.select} value={block.props.style || 'primary'} onChange={(e) => update('style', e.target.value)}>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
              <option value="danger">Danger</option>
              <option value="ghost">Ghost</option>
            </select>
          </Field>
          <Field label="Size" s={s}>
            <select style={s.select} value={block.props.size || 'default'} onChange={(e) => update('size', e.target.value)}>
              <option value="small">Small</option>
              <option value="default">Default</option>
              <option value="large">Large</option>
            </select>
          </Field>
          <Field label="Action" s={s}>
            <select style={s.select} value={block.props.action || 'navigate'} onChange={(e) => update('action', e.target.value)}>
              <option value="navigate">Navigate to view</option>
              <option value="open-form">Open form</option>
              <option value="create-record">Create record</option>
              <option value="open-url">Open URL</option>
            </select>
          </Field>
          <Field label="Target" s={s}>
            <input style={s.input} placeholder="View ID or URL" value={block.props.actionTarget || ''} onChange={(e) => update('actionTarget', e.target.value)} />
          </Field>
          <DataSourceField
            label="Action Binding"
            binding={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            theme={theme}
          />
        </>
      );

    default:
      return <div style={{ color: theme.textMuted, fontSize: 12, padding: 8 }}>No settings for this block type.</div>;
  }
}

// ---------------------------------------------------------------------------
// Field + Checkbox helpers
// ---------------------------------------------------------------------------

function Field({ label, s, children }: { label: string; s: Record<string, React.CSSProperties>; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <label style={s.label}>{label}</label>
      {children}
    </div>
  );
}

function Checkbox({ checked, onChange, theme }: { checked: boolean; onChange: (v: boolean) => void; theme: Theme }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ color: theme.text }}>{checked ? 'Yes' : 'No'}</span>
    </label>
  );
}

/**
 * DataSourceField — Simplified data source picker for record pages.
 *
 * On a record page: shows "Source: Page Record (@)" with a field dropdown
 * and a "Custom source" toggle to reveal the full ScopePicker.
 *
 * On other pages: shows the full ScopePicker directly.
 */
function DataSourceField({ label, binding, onChange, theme }: {
  label: string;
  binding?: DataBinding;
  onChange: (binding: DataBinding) => void;
  theme: Theme;
}) {
  const { pageRecord, pageType } = useDataBindingContext();
  const pageTypeStore = useBuilderStore((s) => s.pageType);
  const recordSource = useBuilderStore((s) => s.recordSource);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const ready = useEoStore((s) => s.ready);
  const [customMode, setCustomMode] = useState(false);
  const [fields, setFields] = useState<string[]>([]);
  const s = makeFieldStyles(theme);
  const isRecordPage = pageTypeStore === 'record';

  // Discover available fields from the collection
  useEffect(() => {
    if (!ready || !isRecordPage || !recordSource?.scope) return;
    getStateByPrefix(recordSource.scope + '.').then((states: EoState[]) => {
      const fieldSet = new Set<string>();
      for (const st of states) {
        if (!st.value || typeof st.value !== 'object') continue;
        for (const key of Object.keys(st.value)) {
          if (!key.startsWith('_')) fieldSet.add(key);
        }
        // Also check fields sub-object
        if (st.value.fields && typeof st.value.fields === 'object') {
          for (const key of Object.keys(st.value.fields)) {
            fieldSet.add(key);
          }
        }
      }
      setFields([...fieldSet].sort());
    });
  }, [ready, isRecordPage, recordSource?.scope, getStateByPrefix]);

  // On a record page, show simplified UI
  if (isRecordPage && !customMode) {
    const currentField = binding?.field || binding?.fieldChain?.replace(/^@\./, '') || '';

    return (
      <div style={s.field}>
        <label style={s.label}>{label}</label>

        {/* Source indicator */}
        <div style={{
          fontSize: 11,
          color: theme.accent,
          background: theme.accentBg,
          padding: '4px 8px',
          borderRadius: 4,
          marginBottom: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span>Source: Page Record (@)</span>
          <button
            type="button"
            onClick={() => setCustomMode(true)}
            style={{
              fontSize: 10,
              color: theme.textMuted,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Custom source
          </button>
        </div>

        {/* Field picker */}
        <select
          style={s.select}
          value={currentField}
          onChange={(e) => {
            const field = e.target.value;
            if (field) {
              onChange({ mode: 'connection', fieldChain: `@.${field}`, field });
            } else {
              onChange({ mode: 'connection', fieldChain: undefined, field: undefined });
            }
          }}
        >
          <option value="">— select field —</option>
          {fields.map(f => (
            <option key={f} value={f}>@.{f}</option>
          ))}
        </select>
      </div>
    );
  }

  // Full ScopePicker (non-record pages or custom mode)
  return (
    <div style={s.field}>
      {isRecordPage && customMode && (
        <button
          type="button"
          onClick={() => setCustomMode(false)}
          style={{
            fontSize: 10,
            color: theme.accent,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            marginBottom: 4,
          }}
        >
          ← Back to page record
        </button>
      )}
      <ScopePicker
        label={label}
        value={binding}
        onChange={onChange}
        context={pageRecord}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    panel: {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    },
    header: {
      padding: '10px 12px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      color: t.textSecondary,
      borderBottom: `1px solid ${t.borderLight}`,
    },
    body: {
      padding: 12,
      overflowY: 'auto',
      flex: 1,
    },
    empty: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      padding: 24,
    },
    emptyText: {
      color: t.textMuted,
      fontSize: 12,
      textAlign: 'center',
    },
  };
}

function makeFieldStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    field: {
      marginBottom: 12,
    },
    label: {
      display: 'block',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
      color: t.textMuted,
      marginBottom: 4,
    },
    input: {
      width: '100%',
      padding: '6px 8px',
      fontSize: 13,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      fontFamily: "'Outfit', sans-serif",
      boxSizing: 'border-box',
    },
    select: {
      width: '100%',
      padding: '6px 8px',
      fontSize: 13,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      background: t.bg,
      color: t.text,
      outline: 'none',
      fontFamily: "'Outfit', sans-serif",
    },
  };
}
