import { useState, useRef, useEffect } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme } from '../theme';
import { schemaFieldTarget, schemaTypeTarget } from '../db/schema-rules';
import { COLUMN_TYPE_DEFS } from './ColumnTypeSelector';
import type { ColumnType } from './filter-types';

// ─── helpers ────────────────────────────────────────────────────────────────

function labelToKey(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 40);
}

// Only show these groups in the quick-pick grid (Computed/Metadata rarely needed on creation)
const QUICK_GROUPS = ['Basic', 'Numeric', 'Select', 'Date & Time', 'Other'];

// ─── Component ───────────────────────────────────────────────────────────────

interface AddColumnDialogProps {
  scope: string;
  onClose: () => void;
}

export function AddColumnDialog({ scope, onClose }: AddColumnDialogProps) {
  const { theme: t } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);

  const [label, setLabel] = useState('');
  const [keyOverride, setKeyOverride] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<ColumnType>('text');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => { labelRef.current?.focus(); }, []);

  const derivedKey = keyOverride ?? labelToKey(label);
  const canCreate = derivedKey.length > 0 && label.trim().length > 0;

  async function handleCreate() {
    if (!canCreate || saving) return;
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await dispatch({
        op: 'INS',
        target: schemaFieldTarget(scope, derivedKey),
        operand: { _label: label.trim() },
        agent: 'user',
        ts: now,
        acquired_ts: now,
      });
      await dispatch({
        op: 'DEF',
        target: schemaTypeTarget(scope, derivedKey),
        operand: { type: selectedType },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create field');
      setSaving(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && canCreate) handleCreate();
    if (e.key === 'Escape') onClose();
  }

  const quickTypes = COLUMN_TYPE_DEFS.filter(d => QUICK_GROUPS.includes(d.group));
  const groupedQuick: Array<{ group: string; items: typeof COLUMN_TYPE_DEFS }> = [];
  for (const group of QUICK_GROUPS) {
    const items = quickTypes.filter(d => d.group === group);
    if (items.length) groupedQuick.push({ group, items });
  }

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10000,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 10001,
          background: t.bgCard,
          border: `1px solid ${t.border}`,
          borderRadius: 10,
          boxShadow: `0 16px 48px ${t.shadow}`,
          width: 400,
          maxWidth: 'calc(100vw - 32px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
        }}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div style={{
          padding: '14px 16px 10px',
          borderBottom: `1px solid ${t.border}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: t.textHeading }}>Add field</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 16, color: t.textMuted, cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}
          >
            &times;
          </button>
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Label */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: t.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Label
            </label>
            <input
              ref={labelRef}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setKeyOverride(null); // reset override when label changes
              }}
              placeholder="e.g. Budget Amount"
              style={{
                width: '100%',
                height: 32,
                fontSize: 13,
                padding: '0 10px',
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                background: t.bgCard,
                color: t.text,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Field key (derived, editable) */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: t.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Field key
            </label>
            <input
              value={derivedKey}
              onChange={(e) => setKeyOverride(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40))}
              placeholder="auto-derived from label"
              style={{
                width: '100%',
                height: 32,
                fontSize: 12,
                padding: '0 10px',
                border: `1px solid ${t.border}`,
                borderRadius: 6,
                background: t.bgMuted,
                color: t.textSecondary,
                outline: 'none',
                boxSizing: 'border-box',
                fontFamily: "'JetBrains Mono', monospace",
              }}
            />
          </div>

          {/* Type picker */}
          <div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: t.textMuted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              Type
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {groupedQuick.map(({ group, items }) => (
                <div key={group}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: t.textMuted, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: "'JetBrains Mono', monospace", marginBottom: 3 }}>
                    {group}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {items.map((ct) => {
                      const isActive = selectedType === ct.value;
                      const IconComp = ct.icon;
                      return (
                        <button
                          key={ct.value}
                          onClick={() => setSelectedType(ct.value)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '4px 8px',
                            borderRadius: 5,
                            border: `1px solid ${isActive ? ct.color : t.border}`,
                            background: isActive ? `${ct.color}18` : 'transparent',
                            color: isActive ? ct.color : t.text,
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            transition: 'all 0.1s',
                          }}
                        >
                          <IconComp size={12} weight="regular" color={isActive ? ct.color : t.textMuted} />
                          {ct.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div style={{ fontSize: 11, color: t.danger, padding: '6px 10px', background: t.dangerBg, borderRadius: 5, border: `1px solid ${t.dangerBorder}` }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px 14px',
          borderTop: `1px solid ${t.border}`,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
        }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              border: `1px solid ${t.border}`,
              borderRadius: 6,
              background: 'transparent',
              color: t.textMuted,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate || saving}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              border: 'none',
              borderRadius: 6,
              background: canCreate && !saving ? t.accent : t.bgMuted,
              color: canCreate && !saving ? '#fff' : t.textMuted,
              cursor: canCreate && !saving ? 'pointer' : 'default',
              fontFamily: 'inherit',
              fontWeight: 500,
            }}
          >
            {saving ? 'Creating…' : 'Create field'}
          </button>
        </div>
      </div>
    </>
  );
}
