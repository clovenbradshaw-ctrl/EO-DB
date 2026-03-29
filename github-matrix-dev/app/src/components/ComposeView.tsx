import { useState, useEffect } from 'react';
import { useEoStore } from '../store/eo-store';
import { useTheme, type Theme } from '../theme';
import type { ExternalOperator, EoState } from '../db/types';

const OPERATORS: ExternalOperator[] = ['INS', 'DEF', 'CON', 'SEG', 'SYN', 'EVA', 'NUL'];

const OP_COLORS: Record<string, string> = {
  INS: '#4ade80', DEF: '#38bdf8', CON: '#a78bfa', SEG: '#f472b6',
  SYN: '#fbbf24', EVA: '#34d399', NUL: '#5c5f7a',
};

interface KvRow { key: string; value: string }

export function ComposeView() {
  const { theme } = useTheme();
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const s = styles(theme);

  const [op, setOp] = useState<ExternalOperator>('INS');
  const [target, setTarget] = useState('');
  const [logging, setLogging] = useState(true);
  const [result, setResult] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Autocomplete
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [allTargets, setAllTargets] = useState<string[]>([]);

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

  // NUL
  const [nulLabel, setNulLabel] = useState('');

  useEffect(() => {
    if (!ready) return;
    getStateByPrefix('app.').then((states: EoState[]) => {
      setAllTargets(states.map((s) => s.target));
    });
  }, [ready, getStateByPrefix]);

  function onTargetChange(val: string) {
    setTarget(val);
    if (val.length > 1) {
      setSuggestions(allTargets.filter((t) => t.toLowerCase().includes(val.toLowerCase())).slice(0, 8));
    } else {
      setSuggestions([]);
    }
  }

  function buildOperand(): any {
    switch (op) {
      case 'INS':
      case 'DEF': {
        const fields: Record<string, any> = {};
        for (const row of kvFields) {
          if (row.key) fields[row.key] = row.value;
          else if (row.value) return row.value; // raw value
        }
        return fields;
      }
      case 'CON': {
        if (conDirection === 'two-way') {
          const targets = conTargets.filter(Boolean);
          return { added: targets };
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
    if (!target && op !== 'NUL') {
      setResult({ type: 'err', msg: 'Target is required' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      const actualOp = logging ? op : 'SIG';
      const seq = await dispatch({
        op: actualOp as any,
        target: op === 'NUL' ? `nul.${Date.now()}` : target,
        operand: buildOperand(),
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setResult({ type: 'ok', msg: `Event sent — seq ${seq}` });
      setTarget('');
      setKvFields([{ key: '', value: '' }]);
    } catch (e: any) {
      setResult({ type: 'err', msg: e.message || 'Failed to send event' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.container}>
      <div style={s.form}>
        {/* Operator selector */}
        <div style={s.row}>
          <div style={s.label}>Operator</div>
          <div style={s.opGroup}>
            {OPERATORS.map((o) => (
              <button
                key={o}
                onClick={() => setOp(o)}
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
          </div>
        </div>

        {/* CON Direction */}
        {op === 'CON' && (
          <div style={s.row}>
            <div style={s.label}>Direction</div>
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
                ? 'All targets are mutually connected'
                : 'Source → added targets (directional)'}
            </div>
          </div>
        )}

        {/* Target (single) — hidden for CON two-way */}
        {!(op === 'CON' && conDirection === 'two-way') && (
          <div style={s.row}>
            <div style={s.label}>Target</div>
            <div style={{ position: 'relative' as const }}>
              <input
                style={s.input}
                value={target}
                onChange={(e) => onTargetChange(e.target.value)}
                placeholder="app.tblClients.rec001.fldEmail"
                onBlur={() => setTimeout(() => setSuggestions([]), 200)}
              />
              {suggestions.length > 0 && (
                <div style={s.autocomplete}>
                  {suggestions.map((sg) => (
                    <div
                      key={sg}
                      style={s.autocompleteItem}
                      onMouseDown={() => { setTarget(sg); setSuggestions([]); }}
                    >
                      {sg}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* CON Two-way targets */}
        {op === 'CON' && conDirection === 'two-way' && (
          <div style={s.row}>
            <div style={s.label}>Targets</div>
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

        {/* Operand fields per operator */}
        <div style={s.row}>
          <div style={s.label}>Operand</div>

          {/* INS / DEF: key-value fields */}
          {(op === 'INS' || op === 'DEF') && (
            <div>
              <div style={s.subLabel}>Fields</div>
              {kvFields.map((row, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <input
                    style={{ ...s.input, flex: 1 }}
                    placeholder={op === 'DEF' ? 'key (blank for raw)' : 'key'}
                    value={row.key}
                    onChange={(e) => {
                      const next = [...kvFields];
                      next[i] = { ...next[i], key: e.target.value };
                      setKvFields(next);
                    }}
                  />
                  <input
                    style={{ ...s.input, flex: 1 }}
                    placeholder="value"
                    value={row.value}
                    onChange={(e) => {
                      const next = [...kvFields];
                      next[i] = { ...next[i], value: e.target.value };
                      setKvFields(next);
                    }}
                  />
                  {kvFields.length > 1 && (
                    <button
                      style={s.removeBtn}
                      onClick={() => setKvFields(kvFields.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  )}
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
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <input
                    style={{ ...s.input, flex: 1 }}
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
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <input
                    style={{ ...s.input, flex: 1 }}
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
                  <input style={s.input} value={evaFormula} onChange={(e) => setEvaFormula(e.target.value)} placeholder="e.g. SUM(field1, field2)" />
                </>
              )}
            </div>
          )}

          {/* NUL */}
          {op === 'NUL' && (
            <div>
              <div style={s.subLabel}>Label (optional)</div>
              <input style={s.input} value={nulLabel} onChange={(e) => setNulLabel(e.target.value)} placeholder="e.g. pre-migration, daily snapshot" />
            </div>
          )}
        </div>

        {/* Logging toggle */}
        <div style={s.row}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
            </label>
            <div>
              <div style={{ fontSize: 11, color: theme.text }}>
                Logging {logging ? 'ON' : 'OFF'} — event {logging ? 'will be persisted to log' : 'sent as SIG (ephemeral)'}
              </div>
              <div style={s.hint}>When OFF, event is sent as SIG (ephemeral, not logged)</div>
            </div>
          </div>
        </div>

        {/* Submit */}
        <div style={{ ...s.row, flexDirection: 'row' as const, gap: 12, alignItems: 'center' }}>
          <button style={s.submitBtn} onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Sending...' : 'Send Event'}
          </button>
          {result && (
            <div style={{
              fontSize: 11,
              fontFamily: "'JetBrains Mono', monospace",
              color: result.type === 'ok' ? theme.success : theme.danger,
            }}>
              {result.msg}
            </div>
          )}
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
    row: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '14px 0',
      borderBottom: `1px solid ${t.border}`,
    },
    label: {
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
      color: t.danger,
      cursor: 'pointer',
      fontSize: 14,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    autocomplete: {
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
    autocompleteItem: {
      padding: '6px 10px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.text,
      cursor: 'pointer',
    },
    toggle: { cursor: 'pointer', display: 'flex', alignItems: 'center' },
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
      padding: '8px 24px',
      background: t.success,
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
      letterSpacing: '0.05em',
    },
  };
}
