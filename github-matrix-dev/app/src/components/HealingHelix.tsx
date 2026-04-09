import { useTheme } from '../theme';
import type { HealingRecord } from '../db/types';

// The nine operators in helix order
const HELIX_OPS = ['NUL', 'SIG', 'INS', 'SEG', 'CON', 'SYN', 'DEF', 'EVA', 'REC'] as const;

// Failure class descriptions
const FAILURE_DESCRIPTIONS: Record<HealingRecord['failure_class'], string> = {
  'F1.1': 'Silent overwrite — field present without INS entry in G',
  'F1.2': 'Absence collapse — NUL states conflated',
  'F2.1': 'Partition — node offline, writes context-bounded',
  'F2.2': 'Partition heal — remote G entries arriving, merge in progress',
  'F2.3': 'Topology corruption — CON without SEG boundary',
  'F3.1': 'Ungrounded interpretation — M entry lacks G provenance',
  'F3.2': 'Semantic drift — EVA output diverging from DEF frame',
  'F3.3': 'Frozen frame — interpretation immune to supersession',
  'F3.4': 'Schema migration mid-partition — frame divergence on rejoin',
};

// Which operator is the "energy concentration" point for each failure class
const FAILURE_ENERGY: Record<HealingRecord['failure_class'], string> = {
  'F1.1': 'INS',
  'F1.2': 'NUL',
  'F2.1': 'SIG',
  'F2.2': 'DEF',
  'F2.3': 'CON',
  'F3.1': 'DEF',
  'F3.2': 'EVA',
  'F3.3': 'REC',
  'F3.4': 'REC',
};

// Color by failure class category
const CLASS_COLORS: Record<string, string> = {
  'F1': '#f59e0b',  // amber — existence failures
  'F2': '#3b82f6',  // blue — structure failures
  'F3': '#8b5cf6',  // purple — significance failures
};

function getClassColor(failureClass: HealingRecord['failure_class']): string {
  const cat = failureClass.slice(0, 2);
  return CLASS_COLORS[cat] ?? '#6b7280';
}

interface HealingHelixProps {
  failureClass: HealingRecord['failure_class'];
  helixOps: HealingRecord['helix_ops'];
  resolved?: boolean;
  resolutionTier?: 1 | 2 | 3;
}

const TIER_LABELS: Record<number, string> = {
  1: 'Tier 1 — Temporal LWW',
  2: 'Tier 2 — Domain rule',
  3: 'Tier 3 — Human-in-the-loop',
};

export function HealingHelix({ failureClass, helixOps, resolved, resolutionTier }: HealingHelixProps) {
  const { theme: t } = useTheme();
  const energyOp = FAILURE_ENERGY[failureClass];
  const accentColor = getClassColor(failureClass);
  const activeOpNames = new Set(helixOps.map(h => h.op));

  return (
    <div style={{
      fontFamily: "'JetBrains Mono', monospace",
      background: t.bg,
      border: `1px solid ${t.border}`,
      borderRadius: 8,
      padding: 16,
      maxWidth: 420,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{
          background: accentColor, color: '#fff',
          borderRadius: 4, fontSize: 11, fontWeight: 700,
          padding: '2px 8px',
        }}>
          {failureClass}
        </span>
        <span style={{ fontSize: 11, color: t.textSecondary, flex: 1 }}>
          {FAILURE_DESCRIPTIONS[failureClass]}
        </span>
        {resolved !== undefined && (
          <span style={{
            fontSize: 10, fontWeight: 600,
            color: resolved ? '#22c55e' : '#f59e0b',
          }}>
            {resolved ? '✓ resolved' : '⟳ active'}
          </span>
        )}
      </div>

      {/* Helix — vertical operator timeline */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
        {HELIX_OPS.map((op, idx) => {
          const isEnergy = op === energyOp;
          const isActive = activeOpNames.has(op);
          const activeStep = helixOps.find(h => h.op === op);

          return (
            <div key={op} style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
              {/* Connector line */}
              <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                width: 28, flexShrink: 0,
              }}>
                {idx > 0 && (
                  <div style={{
                    width: 2, height: 8, flexShrink: 0,
                    background: isActive ? accentColor : `${accentColor}30`,
                  }} />
                )}
                {/* Node circle */}
                <div style={{
                  width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                  background: isEnergy ? accentColor : isActive ? `${accentColor}40` : t.bgHover,
                  border: `2px solid ${isActive ? accentColor : t.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: isEnergy ? `0 0 0 3px ${accentColor}30` : 'none',
                  zIndex: 1,
                }} />
                {idx < HELIX_OPS.length - 1 && (
                  <div style={{
                    width: 2, flex: 1, minHeight: 8,
                    background: isActive ? accentColor : `${accentColor}30`,
                  }} />
                )}
              </div>

              {/* Op label + reason */}
              <div style={{
                flex: 1, paddingBottom: idx < HELIX_OPS.length - 1 ? 4 : 0,
                paddingLeft: 10, display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: isActive ? 700 : 400,
                    color: isEnergy ? accentColor : isActive ? t.text : t.textMuted,
                  }}>
                    {op}
                  </span>
                  {isEnergy && (
                    <span style={{
                      fontSize: 9, color: accentColor,
                      border: `1px solid ${accentColor}`,
                      borderRadius: 3, padding: '0 4px',
                    }}>
                      ⚡ energy
                    </span>
                  )}
                </div>
                {activeStep && (
                  <div style={{ fontSize: 10, color: t.textSecondary, marginTop: 1 }}>
                    {activeStep.reason}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* σ Resolution tier */}
      {resolutionTier !== undefined && (
        <div style={{
          marginTop: 12, paddingTop: 10,
          borderTop: `1px solid ${t.border}`,
          fontSize: 10, color: t.textSecondary,
        }}>
          <span style={{ color: t.text, fontWeight: 600 }}>σ </span>
          {TIER_LABELS[resolutionTier] ?? `Tier ${resolutionTier}`}
        </div>
      )}
    </div>
  );
}

/** Compact row variant for use inside a list or table. */
export function HealingHelixRow({ record }: { record: HealingRecord }) {
  const { theme: t } = useTheme();
  const accentColor = getClassColor(record.failure_class);
  const energyOp = FAILURE_ENERGY[record.failure_class];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px',
      borderBottom: `1px solid ${t.borderLight}`,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
    }}>
      <span style={{
        background: accentColor, color: '#fff',
        borderRadius: 3, fontSize: 9, fontWeight: 700,
        padding: '1px 5px', flexShrink: 0,
      }}>
        {record.failure_class}
      </span>
      <span style={{ color: t.accent, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {record.target}
      </span>
      <span style={{ color: accentColor, fontSize: 10, fontWeight: 600 }}>
        ⚡{energyOp}
      </span>
      <span style={{ color: record.resolved ? '#22c55e' : '#f59e0b', fontSize: 10 }}>
        {record.resolved ? '✓' : '⟳'}
      </span>
    </div>
  );
}
