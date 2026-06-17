/**
 * BranchExplorerPanel — top-level wrapper for the BranchExplorer view.
 *
 * Lists all SYN events in the current log, lets the user pick one, and
 * automatically creates the three branch records (canonical / never-merged /
 * always-merged) on first selection. Renders the BranchExplorer for the
 * active subject.
 */

import { useEffect, useMemo, useState } from 'react';
import { useEoStore } from '../../store/eo-store';
import {
  useBranchStore,
  listSynEvents,
  isDemoSeq,
} from '../../store/branch-store';
import { useTheme, type Theme } from '../../theme';
import { BranchExplorer } from './BranchExplorer';
import type { EoEvent } from '../../db/types';
import type { WorldType } from '../../types/branch';

const WORLD_PREVIEW_COLOR: Record<WorldType, string> = {
  canonical: '#EF9F27',
  'never-merged': '#1D9E75',
  'always-merged': '#7F77DD',
};

export function BranchExplorerPanel() {
  const { theme } = useTheme();
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const branches = useBranchStore((s) => s.branches);
  const activeBranchSubject = useBranchStore((s) => s.activeBranchSubject);
  const loadBranchesForSubject = useBranchStore((s) => s.loadBranchesForSubject);
  const createBranchSet = useBranchStore((s) => s.createBranchSet);
  const setActiveBranchSubject = useBranchStore((s) => s.setActiveBranchSubject);

  const demoEnabled = useBranchStore((s) => s.demoEnabled);
  const loadDemo = useBranchStore((s) => s.loadCounterfactualDemo);
  const unloadDemo = useBranchStore((s) => s.unloadCounterfactualDemo);

  const [synEvents, setSynEvents] = useState<EoEvent[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh SYN events when the log changes or the demo overlay toggles.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    listSynEvents()
      .then((events) => {
        if (!cancelled) setSynEvents(events);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ready, lastSeq, demoEnabled]);

  // Filter the loaded branches to those whose subject matches the active subject.
  const visibleBranches = useMemo(
    () => (activeBranchSubject ? branches.filter((b) => b.subject === activeBranchSubject) : []),
    [branches, activeBranchSubject],
  );

  async function selectSyn(event: EoEvent) {
    setError(null);
    const operand = event.operand as { merge?: unknown[]; into?: unknown } | null;
    const sources = Array.isArray(operand?.merge) ? operand.merge.map((x) => String(x)) : [];
    if (sources.length < 2) {
      setError('SYN event has fewer than two source entities — cannot branch.');
      return;
    }
    const subject = sources.join(',');

    setActiveBranchSubject(subject);
    await loadBranchesForSubject(subject);

    // Demo SYNs already have synthesized branches — never dispatch INS+DEF
    // for them, since the whole point of the overlay is that it stays out
    // of the real log.
    if (isDemoSeq(event.seq)) return;

    const after = useBranchStore.getState().branches.filter((b) => b.subject === subject);
    if (after.length === 0) {
      setCreating(true);
      try {
        await createBranchSet(event);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreating(false);
      }
    }
  }

  if (!ready) {
    return (
      <div style={{ padding: 32, color: theme.textSecondary }}>
        Loading store…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <header
        style={{
          padding: '16px 24px 8px',
          borderBottom: `0.5px solid ${theme.borderLight}`,
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, color: theme.text, margin: 0 }}>
          Branch Explorer
        </h2>
        <span style={{ fontSize: 11, color: theme.textMuted, fontFamily: 'monospace' }}>
          replay the Given-Log under alternative world policies — projection-sketch only
        </span>
      </header>

      <div style={{ display: 'flex', minHeight: 0 }}>
        {/* SYN event picker */}
        <aside
          style={{
            width: 240,
            borderRight: `0.5px solid ${theme.borderLight}`,
            padding: '12px 12px 24px',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: theme.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 8,
              fontFamily: 'monospace',
            }}
          >
            SYN events
          </div>
          {synEvents.length === 0 && (
            <div style={{ fontSize: 11, color: theme.textMuted, fontFamily: 'monospace' }}>
              No merge events in the log yet.
            </div>
          )}
          {synEvents.map((event) => {
            const operand = event.operand as { merge?: unknown[] } | null;
            const sources = Array.isArray(operand?.merge) ? operand.merge.map((x) => String(x)) : [];
            const subject = sources.join(',');
            const isActive = subject === activeBranchSubject;
            const isDemo = isDemoSeq(event.seq);
            return (
              <button
                key={event.seq}
                type="button"
                onClick={() => selectSyn(event)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: isActive ? theme.bgActive : 'transparent',
                  border: 'none',
                  borderLeft: `2px solid ${isActive ? '#EF9F27' : 'transparent'}`,
                  padding: '6px 8px',
                  color: theme.text,
                  cursor: 'pointer',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  marginBottom: 2,
                }}
              >
                <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>{isDemo ? 'demo SYN' : `seq #${event.seq}`}</span>
                  {isDemo && (
                    <span
                      style={{
                        fontSize: 9,
                        padding: '1px 5px',
                        borderRadius: 3,
                        background: theme.bgMuted,
                        color: theme.textMuted,
                        letterSpacing: '0.04em',
                        textTransform: 'uppercase',
                      }}
                    >
                      sample
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: theme.textSecondary }}>{subject || '(empty merge)'}</div>
                <div style={{ fontSize: 9, color: theme.textMuted }}>
                  {new Date(event.ts).toLocaleString()}
                </div>
              </button>
            );
          })}
          {error && (
            <div style={{ marginTop: 12, padding: 8, fontSize: 11, color: theme.dangerText, fontFamily: 'monospace' }}>
              {error}
            </div>
          )}
          {creating && (
            <div style={{ marginTop: 12, fontSize: 11, color: theme.textSecondary, fontFamily: 'monospace' }}>
              creating branch set…
            </div>
          )}
        </aside>

        {/* Explorer area */}
        <section style={{ flex: 1, minWidth: 0 }}>
          {visibleBranches.length === 0 ? (
            <BranchExplorerIntro
              theme={theme}
              hasSynEvents={synEvents.length > 0}
              demoEnabled={demoEnabled}
              onToggleDemo={() => {
                if (demoEnabled) unloadDemo();
                else loadDemo();
              }}
            />
          ) : (
            <BranchExplorer branches={visibleBranches} />
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Empty-state intro ──────────────────────────────────────────────────────

interface IntroProps {
  theme: Theme;
  hasSynEvents: boolean;
  demoEnabled: boolean;
  onToggleDemo: () => void;
}

/**
 * Empty-state panel shown when no branch set is selected. Explains the three
 * worlds, shows a miniature schematic of the fork, and gives step-by-step
 * guidance for producing the SYN event that opens a branch set.
 */
function BranchExplorerIntro({
  theme,
  hasSynEvents,
  demoEnabled,
  onToggleDemo,
}: IntroProps) {
  const worlds: Array<{
    world: WorldType;
    title: string;
    tagline: string;
    body: string;
  }> = [
    {
      world: 'canonical',
      title: 'W-0  canonical',
      tagline: 'the merge happened',
      body: 'Straight replay of the log. Pre-SYN the sources live separately; post-SYN the survivor carries their union.',
    },
    {
      world: 'never-merged',
      title: 'W-1  never merged',
      tagline: 'pretend it didn\u2019t',
      body: 'SYN and every survivor-targeted event are suppressed. Post-branch fields fade to shadow — the log still moved, this world didn\u2019t.',
    },
    {
      world: 'always-merged',
      title: 'W-2  always merged',
      tagline: 'pretend it always was',
      body: 'Every source event is retrojected onto the survivor from t=0. Cross-source collisions resolved by the chosen EVA stance.',
    },
  ];

  return (
    <div
      style={{
        padding: '32px 40px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        maxWidth: 920,
      }}
    >
      <section>
        <div
          style={{
            fontSize: 10,
            color: theme.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'monospace',
            marginBottom: 6,
          }}
        >
          projection-sketch
        </div>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: theme.text }}>
          Replay the log under alternative world policies
        </h3>
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            lineHeight: 1.7,
            color: theme.textSecondary,
            fontFamily: 'monospace',
            maxWidth: 720,
          }}
        >
          Every SYN merge event is a fork in the Given-Log. The Branch Explorer
          replays the same log through three readings — the merge that happened,
          the merge that didn't, and the merge that always had — and renders
          the resulting entity state as you drag the scrubber across time.
        </p>
      </section>

      {/* Miniature fork schematic */}
      <ForkSchematic theme={theme} />

      {/* Three world cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        {worlds.map((w) => (
          <div
            key={w.world}
            style={{
              border: `0.5px solid ${theme.borderLight}`,
              borderLeft: `2px solid ${WORLD_PREVIEW_COLOR[w.world]}`,
              borderRadius: 6,
              padding: '12px 14px',
              background: theme.bgCard,
            }}
          >
            <div
              style={{
                fontSize: 10.5,
                fontFamily: 'monospace',
                color: WORLD_PREVIEW_COLOR[w.world],
                fontWeight: 600,
                marginBottom: 2,
              }}
            >
              {w.title}
            </div>
            <div
              style={{
                fontSize: 10,
                color: theme.textMuted,
                fontFamily: 'monospace',
                fontStyle: 'italic',
                marginBottom: 8,
              }}
            >
              {w.tagline}
            </div>
            <div
              style={{
                fontSize: 11,
                color: theme.textSecondary,
                lineHeight: 1.6,
                fontFamily: 'monospace',
              }}
            >
              {w.body}
            </div>
          </div>
        ))}
      </div>

      {/* Sample counterfactual data toggle (ephemeral, not persisted) */}
      <SampleDataToggle
        theme={theme}
        enabled={demoEnabled}
        onToggle={onToggleDemo}
      />

      {/* How to open a branch set */}
      <section
        style={{
          border: `0.5px dashed ${theme.borderLight}`,
          borderRadius: 6,
          padding: '14px 18px',
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: theme.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'monospace',
            marginBottom: 8,
          }}
        >
          {hasSynEvents ? 'next step' : 'how to enable this view'}
        </div>
        {hasSynEvents ? (
          <div
            style={{
              fontSize: 12,
              color: theme.textSecondary,
              fontFamily: 'monospace',
              lineHeight: 1.7,
            }}
          >
            Select a SYN event from the sidebar. The first time you pick one,
            three branch records (W-0, W-1, W-2) are written to the log and
            synced to your peers — thereafter they persist and reopen instantly.
          </div>
        ) : (
          <ol
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: theme.textSecondary,
              fontFamily: 'monospace',
              lineHeight: 1.8,
            }}
          >
            <li>
              Open the <strong style={{ color: theme.text }}>Compose</strong>{' '}
              view from the actions menu.
            </li>
            <li>
              Choose op <strong style={{ color: theme.text }}>SYN</strong>,
              pick two or more source entities, and name the survivor.
            </li>
            <li>
              Dispatch. The SYN event appears in this sidebar, ready to branch.
            </li>
          </ol>
        )}
      </section>

      <div
        style={{
          fontSize: 10.5,
          color: theme.textMuted,
          fontFamily: 'monospace',
          lineHeight: 1.6,
          borderTop: `0.5px solid ${theme.borderLight}`,
          paddingTop: 14,
        }}
      >
        Branches are first-class log entities (created via INS + DEF), so they
        survive reloads and sync to your peers. Projections are recomputed on
        read and cached in memory only.
      </div>
    </div>
  );
}

/**
 * Toggle that loads a ready-made counterfactual merge scenario into the
 * Branch Explorer. The fixture events live in memory only — they never hit
 * the Given-Log, never sync to peers, and vanish when the toggle is flipped
 * off or the space is switched.
 */
function SampleDataToggle({
  theme,
  enabled,
  onToggle,
}: {
  theme: Theme;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <section
      style={{
        border: `0.5px solid ${enabled ? theme.successBorder : theme.borderLight}`,
        background: enabled ? theme.successBg : 'transparent',
        borderRadius: 6,
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 10,
            color: theme.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontFamily: 'monospace',
            marginBottom: 6,
          }}
        >
          sample data — ephemeral
        </div>
        <div
          style={{
            fontSize: 12,
            color: theme.textSecondary,
            fontFamily: 'monospace',
            lineHeight: 1.6,
          }}
        >
          Load a CRM contact-merge scenario (<code>contact:jordan_w</code> +{' '}
          <code>contact:j_walker_alt</code> → <code>contact:j_walker</code>) so
          you can drag the scrubber and see the three worlds diverge in real
          time. Events are held in memory only — nothing is written to the log
          or synced to peers.
        </div>
      </div>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
          userSelect: 'none',
          fontFamily: 'monospace',
          fontSize: 11,
          color: theme.textSecondary,
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={onToggle}
          style={{ display: 'none' }}
        />
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            position: 'relative',
            width: 36,
            height: 20,
            borderRadius: 10,
            background: enabled ? theme.success : theme.bgMuted,
            border: `0.5px solid ${enabled ? theme.successBorder : theme.border}`,
            transition: 'background 0.15s',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#fff',
              transform: enabled ? 'translateX(16px)' : 'translateX(0)',
              transition: 'transform 0.15s',
              boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            }}
          />
        </span>
        <span>{enabled ? 'on' : 'off'}</span>
      </label>
    </section>
  );
}

/**
 * A small SVG illustrating the trunk → fork shape used by the full explorer,
 * so the empty state previews what the scrubber will eventually look like.
 */
function ForkSchematic({ theme }: { theme: Theme }) {
  const W = 520;
  const H = 120;
  const forkX = 230;
  const trunkY = 70;
  const w0Y = 42;
  const w1Y = 98;
  const w2Y = 16;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      style={{
        display: 'block',
        maxWidth: 560,
        opacity: 0.9,
      }}
      aria-hidden="true"
    >
      {/* W-2 always-merged sits above the trunk for the full range */}
      <line
        x1="0"
        y1={w2Y}
        x2={W}
        y2={w2Y}
        stroke={WORLD_PREVIEW_COLOR['always-merged']}
        strokeWidth="2"
        opacity="0.85"
      />
      <text
        x="6"
        y={w2Y - 4}
        fontSize="9"
        fontFamily="monospace"
        fill={WORLD_PREVIEW_COLOR['always-merged']}
        opacity="0.85"
      >
        W-2 always merged
      </text>

      {/* Shared trunk */}
      <line
        x1="0"
        y1={trunkY}
        x2={forkX}
        y2={trunkY}
        stroke={theme.textMuted}
        strokeWidth="2"
        opacity="0.6"
      />
      <text x="6" y={trunkY - 6} fontSize="9" fontFamily="monospace" fill={theme.textMuted}>
        shared trunk
      </text>

      {/* Canonical fork up */}
      <path
        d={`M${forkX},${trunkY} C${forkX + 30},${trunkY} ${forkX + 45},${w0Y} ${forkX + 80},${w0Y} L${W},${w0Y}`}
        fill="none"
        stroke={WORLD_PREVIEW_COLOR.canonical}
        strokeWidth="2"
        opacity="0.85"
      />
      <text
        x={forkX + 90}
        y={w0Y - 5}
        fontSize="9"
        fontFamily="monospace"
        fill={WORLD_PREVIEW_COLOR.canonical}
        opacity="0.9"
      >
        W-0 canonical
      </text>

      {/* Never-merged fork down */}
      <path
        d={`M${forkX},${trunkY} C${forkX + 30},${trunkY} ${forkX + 45},${w1Y} ${forkX + 80},${w1Y} L${W},${w1Y}`}
        fill="none"
        stroke={WORLD_PREVIEW_COLOR['never-merged']}
        strokeWidth="2"
        opacity="0.85"
      />
      <text
        x={forkX + 90}
        y={w1Y + 12}
        fontSize="9"
        fontFamily="monospace"
        fill={WORLD_PREVIEW_COLOR['never-merged']}
        opacity="0.9"
      >
        W-1 never merged
      </text>

      {/* SYN diamond at the fork */}
      <rect
        x={forkX - 7}
        y={trunkY - 7}
        width="14"
        height="14"
        transform={`rotate(45,${forkX},${trunkY})`}
        fill={WORLD_PREVIEW_COLOR.canonical}
        opacity="0.95"
      />
      <text
        x={forkX}
        y={trunkY + 24}
        fontSize="9"
        textAnchor="middle"
        fontFamily="monospace"
        fill={WORLD_PREVIEW_COLOR.canonical}
      >
        SYN
      </text>
    </svg>
  );
}
