import { useState, useEffect, useMemo } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { ExternalOperator, EoState } from '../db/types';
import type { ResolvedPermissions } from '../permissions/types';
import { FormulaEditorModal } from './FormulaEditorModal';

const OPERATORS: ExternalOperator[] = ['INS', 'DEF', 'CON', 'SEG', 'SYN', 'EVA', 'NUL'];

const OP_DESCRIPTIONS: Record<string, string> = {
  INS: 'INS — Insert a new record with fields',
  DEF: 'DEF — Define/update fields on an existing target',
  CON: 'CON — Connect targets with graph edges',
  SEG: 'SEG — Segment: mark a boundary (archive, exclude)',
  SYN: 'SYN — Synonymize: merge multiple targets into one',
  EVA: 'EVA — Evaluate: set a computation strategy',
  NUL: 'NUL — Null marker (checkpoint/snapshot)',
};

function filterOperatorsByPermissions(
  operators: ExternalOperator[],
  permissions?: ResolvedPermissions | null,
): ExternalOperator[] {
  if (!permissions) return operators;
  if (permissions.powerLevel < 10) return [];
  if (permissions.powerLevel < 25) {
    return operators.filter(op => ['INS', 'DEF', 'NUL'].includes(op));
  }
  return operators;
}

const OP_COLORS: Record<string, string> = {
  INS: '#4ade80', DEF: '#38bdf8', CON: '#a78bfa', SEG: '#f472b6',
  SYN: '#fbbf24', EVA: '#34d399', NUL: '#5c5f7a',
};

interface KvRow { key: string; value: string }

/** Parse an EoState.value into user-visible fields, filtering _ prefixed system keys */
function extractFields(state: EoState | null): Record<string, any> {
  if (!state?.value || typeof state.value !== 'object') return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(state.value)) {
    if (!k.startsWith('_')) out[k] = v;
  }
  return out;
}

export function ComposeView({ permissions }: { permissions?: ResolvedPermissions | null }) {
  const { theme } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const getStateFn = useEoStore((s) => s.getState);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const s = styles(theme);

  const [op, setOp] = useState<ExternalOperator>('INS');
  const [logging, setLogging] = useState(true);
  const [result, setResult] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Target — breadcrumb segments + picker
  const [targetSegments, setTargetSegments] = useState<string[]>([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  // All known targets for the picker
  const [allTargets, setAllTargets] = useState<string[]>([]);

  // Existing fields for current target
  const [existingFields, setExistingFields] = useState<Record<string, any>>({});
  const [loadingFields, setLoadingFields] = useState(false);

  // INS/DEF fields
  const [kvFields, setKvFields] = useState<KvRow[]>([{ key: '', value: '' }]);

  // CON
  const [conDirection, setConDirection] = useState<'two-way' | 'one-way'>('two-way');
  const [conTargets, setConTargets] = useState(['', '']);
  const [conAdded, setConAdded] = useState(['']);
  const [conRemoved, setConRemoved] = useState<string[]>([]);

  // SEG
  const [segBoundary, setSegBoundary] = useState('exclude');
  const [segReason, setSegReason] = useState('');

  // SYN
  const [synMerge, setSynMerge] = useState(['', '']);
  const [synInto, setSynInto] = useState('');

  // EVA
  const [evaStrategy, setEvaStrategy] = useState('latest');
  const [evaFormula, setEvaFormula] = useState('');
  const [formulaEditorOpen, setFormulaEditorOpen] = useState(false);

  // NUL
  const [nulLabel, setNulLabel] = useState('');

  const targetPath = targetSegments.join('.');

  // Load all targets for picker
  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('').then((states: EoState[]) => {
      setAllTargets(states.map((s) => s.target));
    });
  }, [ready, getStateByPrefix]);

  // Load existing fields when target changes
  useEffect(() => {
    if (!ready || !targetPath) {
      setExistingFields({});
      return;
    }
    let cancelled = false;
    setLoadingFields(true);
    getStateFn(targetPath).then((state) => {
      if (!cancelled) {
        setExistingFields(extractFields(state));
        setLoadingFields(false);
      }
    });
    return () => { cancelled = true; };
  }, [ready, targetPath, getStateFn]);

  // Children of current path for the picker
  const pickerItems = useMemo(() => {
    const prefix = targetPath ? targetPath + '.' : '';
    const children = new Set<string>();
    for (const t of allTargets) {
      if (prefix && !t.startsWith(prefix)) continue;
      const rest = prefix ? t.slice(prefix.length) : t;
      const segment = rest.split('.')[0];
      if (segment) children.add(segment);
    }
    let items = Array.from(children).sort();
    if (pickerQuery) {
      const q = pickerQuery.toLowerCase();
      items = items.filter((item) => item.toLowerCase().includes(q));
    }
    return items;
  }, [allTargets, targetPath, pickerQuery]);

  function handlePickerSelect(segment: string) {
    setTargetSegments([...targetSegments, segment]);
    setPickerQuery('');
    setPickerOpen(false);
  }

  function handleBreadcrumbClick(index: number) {
    setTargetSegments(targetSegments.slice(0, index + 1));
    setPickerQuery('');
  }

  function handlePickerInputChange(val: string) {
    setPickerQuery(val);
    if (!pickerOpen && val.length > 0) setPickerOpen(true);
  }

  function handlePickerFocus() {
    setPickerOpen(true);
  }

  function handlePickerKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Allow typing a full dot-path directly
    if (e.key === 'Enter') {
      e.preventDefault();
      if (pickerQuery.includes('.')) {
        // User typed a full path — set it directly
        setTargetSegments(pickerQuery.split('.').filter(Boolean));
        setPickerQuery('');
        setPickerOpen(false);
      } else if (pickerQuery) {
        handlePickerSelect(pickerQuery);
      }
    }
    if (e.key === 'Escape') {
      setPickerOpen(false);
    }
    // Backspace on empty clears last segment
    if (e.key === 'Backspace' && !pickerQuery && targetSegments.length > 0) {
      setTargetSegments(targetSegments.slice(0, -1));
    }
  }

  function buildOperand(): any {
    switch (op) {
      case 'INS':
      case 'DEF': {
        const fields: Record<string, any> = {};
        for (const row of kvFields) {
          if (row.key) {
            let parsed: any = row.value;
            try { parsed = JSON.parse(row.value); } catch { /* keep as string */ }
            fields[row.key] = parsed;
          } else if (row.value) return row.value; // raw value
        }
        return fields;
      }
      case 'CON': {
        if (conDirection === 'two-way') {
          return { added: conTargets.filter(Boolean) };
        }
        return {
          added: conAdded.filter(Boolean),
          removed: conRemoved.filter(Boolean),
        };
      }
      case 'SEG':
        return { boundary: segBoundary, reason: segReason };
      case 'SYN':
        return { merge: synMerge.filter(Boolean), into: synInto };
      case 'EVA':
        return evaStrategy === 'formula'
          ? { strategy: 'formula', formula: evaFormula }
          : { strategy: 'latest' };
      case 'NUL':
        return { ts: new Date().toISOString(), label: nulLabel || undefined };
      default:
        return {};
    }
  }

  async function handleSubmit() {
    if (!targetPath && op !== 'NUL') {
      setResult({ type: 'err', msg: 'Target is required' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const actualOp = logging ? op : 'SIG';
      const seq = await dispatch({
        op: actualOp as any,
        target: op === 'NUL' ? `nul.${Date.now()}` : targetPath,
        operand: buildOperand(),
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setResult({ type: 'ok', msg: `Event sent — seq ${seq}` });
      setTargetSegments([]);
      setKvFields([{ key: '', value: '' }]);
      setExistingFields({});
    } catch (e: any) {
      setResult({ type: 'err', msg: e.message || 'Failed to send event' });
    } finally {
      setSubmitting(false);
    }
  }

  const hasExistingFields = Object.keys(existingFields).length > 0;

  return (
    <div style={s.container}>
      <div style={s.form}>
        {/* Operator selector */}
        <div style={s.section}>
          <div style={s.sectionLabel}>OPERATOR</div>
          <div style={s.opGroup}>
            {filterOperatorsByPermissions(OPERATORS, permissions).map((o) => (
              <button
                key={o}
                onClick={() => setOp(o)}
                title={OP_DESCRIPTIONS[o]}
                style={{
                  ...s.opBtn,
                  background: op === o ? `${OP_COLORS[o]}18` : 'transparent',
                  color: op === o ? OP_COLORS[o] : theme.textMuted,
                  borderColor: op === o ? OP_COLORS[o] : theme.border,
                }}
              >
                {o}
              </button>
            ))}
            {permissions && permissions.powerLevel < 10 && (
              <span style={{ fontSize: 11, color: theme.textMuted, fontStyle: 'italic' }}>
                View-only access — cannot compose events
              </span>
            )}
          </div>
        </div>

        {/* Target with breadcrumb + picker */}
        {!(op === 'CON' && conDirection === 'two-way') && (
          <div style={s.section}>
            <div style={s.sectionLabel}>TARGET</div>

            {/* Breadcrumb */}
            {targetSegments.length > 0 && (
              <div style={s.breadcrumb}>
                {targetSegments.map((seg, i) => (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {i > 0 && <span style={s.breadcrumbSep}>&rsaquo;</span>}
                    <span
                      style={{
                        ...s.breadcrumbItem,
                        ...(i < targetSegments.length - 1 ? s.breadcrumbClickable : s.breadcrumbCurrent),
                      }}
                      onClick={i < targetSegments.length - 1 ? () => handleBreadcrumbClick(i) : undefined}
                    >
                      {seg}
                    </span>
                  </span>
                ))}
              </div>
            )}

            {/* Picker input */}
            <div style={{ position: 'relative' as const }}>
              <input
                style={s.input}
                value={pickerQuery}
                onChange={(e) => handlePickerInputChange(e.target.value)}
                onFocus={handlePickerFocus}
                onBlur={() => setTimeout(() => setPickerOpen(false), 200)}
                onKeyDown={handlePickerKeyDown}
                placeholder="Search or pick a target..."
                aria-label="Target picker"
              />
              {pickerOpen && pickerItems.length > 0 && (
                <div style={s.dropdown}>
                  {pickerItems.map((item) => (
                    <div
                      key={item}
                      style={s.dropdownItem}
                      onMouseDown={() => handlePickerSelect(item)}
                    >
                      {item}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Dot notation path */}
            {targetPath && (
              <div style={s.dotPath}>{targetPath}</div>
            )}
          </div>
        )}

        {/* CON Direction */}
        {op === 'CON' && (
          <div style={s.section}>
            <div style={s.sectionLabel}>DIRECTION</div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['two-way', 'one-way'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setConDirection(d)}
                  style={{
                    ...s.opBtn,
                    background: conDirection === d ? `${theme.accent}15` : 'transparent',
                    color: conDirection === d ? theme.accent : theme.textMuted,
                    borderColor: conDirection === d ? theme.accent : theme.border,
                  }}
                >
                  {d === 'two-way' ? 'Two-way' : 'One-way'}
                </button>
              ))}
            </div>
            <div style={s.hint}>
              {conDirection === 'two-way'
                ? 'All listed targets will be mutually connected (A\u2194B\u2194C)'
                : 'Source target connects to added targets directionally (A\u2192B, A\u2192C)'}
            </div>
          </div>
        )}

        {/* CON Two-way targets */}
        {op === 'CON' && conDirection === 'two-way' && (
          <div style={s.section}>
            <div style={s.sectionLabel}>TARGETS</div>
            {conTargets.map((t, i) => (
              <input
                key={i}
                style={{ ...s.input, marginBottom: 4 }}
                value={t}
                onChange={(e) => {
                  const next = [...conTargets];
                  next[i] = e.target.value;
                  setConTargets(next);
                }}
                placeholder={`app.tbl.rec${i + 1}`}
              />
            ))}
            <button style={s.addBtn} onClick={() => setConTargets([...conTargets, ''])}>+ Add target</button>
          </div>
        )}

        {/* Existing fields preview */}
        {hasExistingFields && (op === 'INS' || op === 'DEF') && (
          <div style={s.section}>
            <div style={s.sectionLabel}>EXISTING FIELDS</div>
            <div style={s.existingFieldsContainer}>
              {Object.entries(existingFields).map(([k, v]) => (
                <div key={k} style={s.existingFieldRow}>
                  <span style={s.existingFieldKey}>{k}</span>
                  <span style={s.existingFieldValue}>
                    {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Operand fields per operator */}
        <div style={s.section}>
          <div style={s.sectionLabel}>OPERAND FIELDS</div>

          {/* INS / DEF: key-value fields */}
          {(op === 'INS' || op === 'DEF') && (
            <div>
              {kvFields.map((row, i) => (
                <div key={i} style={s.fieldRow}>
                  <input
                    style={{ ...s.fieldInput, flex: 1 }}
                    placeholder={op === 'DEF' ? 'key (blank for raw)' : 'key'}
                    aria-label={`Field ${i + 1} key`}
                    value={row.key}
                    onChange={(e) => {
                      const next = [...kvFields];
                      next[i] = { ...next[i], key: e.target.value };
                      setKvFields(next);
                    }}
                  />
                  <input
                    style={{ ...s.fieldInput, flex: 1 }}
                    placeholder="value"
                    aria-label={`Field ${i + 1} value`}
                    value={row.value}
                    onChange={(e) => {
                      const next = [...kvFields];
                      next[i] = { ...next[i], value: e.target.value };
                      setKvFields(next);
                    }}
                  />
                  <button
                    style={s.removeBtn}
                    aria-label="Remove field"
                    onClick={() => {
                      if (kvFields.length > 1) {
                        setKvFields(kvFields.filter((_, j) => j !== i));
                      } else {
                        setKvFields([{ key: '', value: '' }]);
                      }
                    }}
                  >
                    &times;
                  </button>
                </div>
              ))}
              <button style={s.addBtn} onClick={() => setKvFields([...kvFields, { key: '', value: '' }])}>
                + Add field
              </button>
            </div>
          )}

          {/* CON one-way: added + removed */}
          {op === 'CON' && conDirection === 'one-way' && (
            <div>
              <div style={s.subLabel}>Added</div>
              {conAdded.map((t, i) => (
                <div key={i} style={s.fieldRow}>
                  <input
                    style={{ ...s.fieldInput, flex: 1 }}
                    value={t}
                    onChange={(e) => {
                      const next = [...conAdded];
                      next[i] = e.target.value;
                      setConAdded(next);
                    }}
                    placeholder="app.tbl.rec"
                  />
                </div>
              ))}
              <button style={s.addBtn} onClick={() => setConAdded([...conAdded, ''])}>+ Add</button>
              <div style={{ ...s.subLabel, marginTop: 8 }}>Removed</div>
              {conRemoved.map((t, i) => (
                <div key={i} style={s.fieldRow}>
                  <input
                    style={{ ...s.fieldInput, flex: 1 }}
                    value={t}
                    onChange={(e) => {
                      const next = [...conRemoved];
                      next[i] = e.target.value;
                      setConRemoved(next);
                    }}
                    placeholder="app.tbl.rec"
                  />
                </div>
              ))}
              <button style={s.addBtn} onClick={() => setConRemoved([...conRemoved, ''])}>+ Add</button>
            </div>
          )}

          {/* SEG */}
          {op === 'SEG' && (
            <div>
              <div style={s.subLabel}>Boundary</div>
              <select style={s.select} value={segBoundary} onChange={(e) => setSegBoundary(e.target.value)}>
                <option value="exclude">exclude</option>
                <option value="include">include</option>
              </select>
              <div style={{ ...s.subLabel, marginTop: 8 }}>Reason</div>
              <input style={s.input} value={segReason} onChange={(e) => setSegReason(e.target.value)} placeholder="e.g. archived, duplicate" />
            </div>
          )}

          {/* SYN */}
          {op === 'SYN' && (
            <div>
              <div style={s.subLabel}>Merge</div>
              {synMerge.map((t, i) => (
                <input
                  key={i}
                  style={{ ...s.input, marginBottom: 4 }}
                  value={t}
                  onChange={(e) => {
                    const next = [...synMerge];
                    next[i] = e.target.value;
                    setSynMerge(next);
                  }}
                  placeholder={`app.tblClients.rec${i + 1}`}
                />
              ))}
              <button style={s.addBtn} onClick={() => setSynMerge([...synMerge, ''])}>+ Add target</button>
              <div style={{ ...s.subLabel, marginTop: 8 }}>Into</div>
              <input style={s.input} value={synInto} onChange={(e) => setSynInto(e.target.value)} placeholder="app.tblClients.merged001" />
            </div>
          )}

          {/* EVA */}
          {op === 'EVA' && (
            <div>
              <div style={s.subLabel}>Strategy</div>
              <select style={s.select} value={evaStrategy} onChange={(e) => setEvaStrategy(e.target.value)}>
                <option value="latest">latest</option>
                <option value="formula">formula</option>
              </select>
              {evaStrategy === 'formula' && (
                <>
                  <div style={{ ...s.subLabel, marginTop: 8 }}>Formula</div>
                  <div style={s.formulaPreviewRow}>
                    <div style={s.formulaPreview}>
                      {evaFormula
                        ? evaFormula.length > 72
                          ? evaFormula.slice(0, 72) + '…'
                          : evaFormula
                        : <span style={{ color: s.formulaPlaceholder.color }}>No formula set</span>
                      }
                    </div>
                    <button style={s.editFormulaBtn} onClick={() => setFormulaEditorOpen(true)}>
                      Edit Formula
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <FormulaEditorModal
            open={formulaEditorOpen}
            onClose={() => setFormulaEditorOpen(false)}
            formula={evaFormula}
            onSave={(f) => { setEvaFormula(f); setFormulaEditorOpen(false); }}
            target={targetPath || undefined}
          />

          {/* NUL */}
          {op === 'NUL' && (
            <div>
              <div style={s.subLabel}>Label (optional)</div>
              <input style={s.input} value={nulLabel} onChange={(e) => setNulLabel(e.target.value)} placeholder="e.g. pre-migration, daily snapshot" />
            </div>
          )}
        </div>

        {/* Bottom bar: Persisted toggle + Send */}
        <div style={s.bottomBar}>
          <label style={s.toggle}>
            <input type="checkbox" checked={logging} onChange={(e) => setLogging(e.target.checked)} style={{ display: 'none' }} />
            <div style={{
              ...s.toggleTrack,
              background: logging ? theme.success : theme.bgMuted,
            }}>
              <div style={{
                ...s.toggleKnob,
                transform: logging ? 'translateX(16px)' : 'translateX(0)',
              }} />
            </div>
            <span style={{ marginLeft: 8, fontSize: 12, color: theme.text }}>
              {logging ? 'Persisted' : 'Ephemeral (SIG)'}
            </span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {result && (
              <div style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', monospace",
                color: result.type === 'ok' ? theme.success : theme.danger,
              }}>
                {result.msg}
              </div>
            )}
            <button style={s.submitBtn} onClick={handleSubmit} disabled={submitting}>
              {submitting ? 'Sending...' : 'Send event'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      justifyContent: 'center',
      padding: '24px 16px',
    },
    form: {
      width: '100%',
      maxWidth: 560,
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
    },
    section: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '16px 0',
      borderBottom: `1px solid ${t.border}`,
    },
    sectionLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      fontWeight: 700,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.08em',
      color: t.textMuted,
    },
    subLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      fontWeight: 600,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
      color: t.textSecondary,
      marginBottom: 4,
    },
    hint: {
      fontSize: 10,
      color: t.textMuted,
      marginTop: 2,
    },
    opGroup: {
      display: 'flex',
      gap: 4,
      flexWrap: 'wrap' as const,
    },
    opBtn: {
      padding: '5px 12px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 700,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      cursor: 'pointer',
      background: 'transparent',
      transition: 'all 0.1s',
    },

    // Breadcrumb
    breadcrumb: {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap' as const,
      gap: 2,
      marginBottom: 4,
    },
    breadcrumbItem: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      fontWeight: 600,
      padding: '2px 4px',
      borderRadius: 3,
    },
    breadcrumbClickable: {
      color: t.accent,
      cursor: 'pointer',
    },
    breadcrumbCurrent: {
      color: t.text,
    },
    breadcrumbSep: {
      color: t.textMuted,
      fontSize: 14,
      margin: '0 4px',
      userSelect: 'none' as const,
    },

    // Dot path
    dotPath: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      marginTop: 4,
    },

    // Input
    input: {
      width: '100%',
      padding: '8px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },

    // Formula preview row
    formulaPreviewRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    },
    formulaPreview: {
      flex: 1,
      padding: '8px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.text,
      overflow: 'hidden',
      whiteSpace: 'nowrap' as const,
      textOverflow: 'ellipsis',
    },
    formulaPlaceholder: {
      color: t.textMuted,
    },
    editFormulaBtn: {
      padding: '7px 12px',
      background: t.accentBg,
      border: `1px solid ${t.accentBorder}`,
      borderRadius: 4,
      color: t.accent,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
      flexShrink: 0,
    },
    select: {
      padding: '8px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      outline: 'none',
    },

    // Dropdown picker
    dropdown: {
      position: 'absolute' as const,
      top: 'calc(100% + 2px)',
      left: 0,
      right: 0,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      zIndex: 50,
      maxHeight: 200,
      overflowY: 'auto' as const,
      boxShadow: `0 4px 16px ${t.shadow}`,
    },
    dropdownItem: {
      padding: '7px 12px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.text,
      cursor: 'pointer',
    },

    // Existing fields
    existingFieldsContainer: {
      background: t.bgMuted,
      borderRadius: 6,
      padding: '8px 12px',
      display: 'flex',
      flexDirection: 'column' as const,
      gap: 4,
    },
    existingFieldRow: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      padding: '3px 0',
    },
    existingFieldKey: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      minWidth: 80,
      flexShrink: 0,
    },
    existingFieldValue: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.text,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap' as const,
    },

    // Field rows (key-value)
    fieldRow: {
      display: 'flex',
      gap: 6,
      marginBottom: 4,
      alignItems: 'center',
    },
    fieldInput: {
      padding: '8px 10px',
      background: t.bgMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.text,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      outline: 'none',
      boxSizing: 'border-box' as const,
    },

    addBtn: {
      padding: '4px 10px',
      background: 'transparent',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.accent,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      cursor: 'pointer',
      marginTop: 4,
    },
    removeBtn: {
      width: 28,
      height: 28,
      background: 'transparent',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      color: t.textMuted,
      cursor: 'pointer',
      fontSize: 16,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },

    // Bottom bar
    bottomBar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '16px 0',
      marginTop: 4,
    },
    toggle: {
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
    },
    toggleTrack: {
      width: 36,
      height: 20,
      borderRadius: 10,
      padding: 2,
      transition: 'background 0.15s',
    },
    toggleKnob: {
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: '#fff',
      transition: 'transform 0.15s',
    },
    submitBtn: {
      padding: '10px 28px',
      background: t.success,
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      fontWeight: 700,
      cursor: 'pointer',
      letterSpacing: '0.03em',
    },
  };
}
