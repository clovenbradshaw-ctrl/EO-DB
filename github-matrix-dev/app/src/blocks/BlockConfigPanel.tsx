import { useBuilderStore } from '../store/builder-store';
import { getRegistration } from './registry';
import { useTheme, type Theme } from '../theme';
import type { BlockNode, BlockId, DataBinding } from './types';
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
  const { contextItem } = useDataBindingContext();

  switch (block.type) {
    case 'section':
      return (
        <>
          <Field label="Title" s={s}>
            <input style={s.input} value={block.props.title || ''} onChange={(e) => update('title', e.target.value)} />
          </Field>
          <ScopePicker
            label="Data Context (@)"
            value={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            context={contextItem}
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
          <ScopePicker
            label="Bind text from"
            value={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            context={contextItem}
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
          <ScopePicker
            label="Bind text from"
            value={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            context={contextItem}
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
          <ScopePicker
            label="Data Source"
            value={block.props.binding}
            onChange={(binding: DataBinding) => {
              update('binding', binding);
              // Also set scope for backward compatibility
              if (binding.mode === 'hierarchy' && binding.target) {
                update('scope', binding.target);
              }
            }}
            context={contextItem}
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
          <ScopePicker
            label="Action Binding"
            value={block.props.binding}
            onChange={(binding: DataBinding) => update('binding', binding)}
            context={contextItem}
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
