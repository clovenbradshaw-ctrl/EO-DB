/**
 * BranchExplorer — temporal branch visualizer for EO///DB.
 *
 * Renders a draggable scrubber across a shared time axis, three world tracks
 * (W-0 canonical, W-1 never-merged, W-2 always-merged), a world / stance
 * selector, and three entity-state cards that update as the scrubber moves.
 *
 * The component is self-contained: it accepts a BranchRecord[] for one merge
 * subject and manages its own projection state via the branch-store.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useBranchStore } from '../../store/branch-store';
import { useEoStore } from '../../store/eo-store';
import { useTheme, type Theme } from '../../theme';
import { warmProjectionCache } from '../../projection/ProjectionEngine';
import {
  findNearestDivergence,
  findNextDivergence,
  findPrevDivergence,
  mergeDivergencePoints,
  sortDivergencePoints,
  tAtTs,
} from './branch-navigation';
import type {
  BranchRecord,
  DivergencePoint,
  EvaStance,
  ProjectedField,
  ProjectedState,
  WorldType,
} from '../../types/branch';

// ─── Constants ──────────────────────────────────────────────────────────────

const VIEW_WIDTH = 760;
const VIEW_HEIGHT = 230;

const W2_Y = 50;
const TRUNK_Y = 130;
const W0_Y = 95;
const W1_Y = 168;

/** Cubic-bezier P0 (forkX,130) → P1 (+40,130) → P2 (+60,target) → P3 (+96,target) */
const FORK_RUN = 96;
const FORK_CTRL_1_DX = 40;
const FORK_CTRL_2_DX = 60;

const WORLD_COLORS: Record<WorldType, string> = {
  canonical: '#BA7517',
  'never-merged': '#0F6E56',
  'always-merged': '#534AB7',
};

const WORLD_TRACK_COLORS: Record<WorldType, string> = {
  canonical: '#EF9F27',
  'never-merged': '#1D9E75',
  'always-merged': '#7F77DD',
};

const WORLD_LABELS: Record<WorldType, string> = {
  canonical: 'W-0  canonical',
  'never-merged': 'W-1  never merged',
  'always-merged': 'W-2  always merged',
};

const STANCES: EvaStance[] = ['clearing', 'binding', 'dissecting', 'composing', 'tracing'];

const OP_DOT_COLOR: Record<string, string> = {
  EVA: '#EF9F27',
  DEF: '#D4537E',
  REC: '#7F77DD',
  INS: '#1D9E75',
  SEG: '#888780',
  CON: '#888780',
  NUL: '#888780',
  SIG: '#888780',
};

// ─── Time utilities ─────────────────────────────────────────────────────────

interface TimeWindow {
  minTs: string;
  maxTs: string;
  minMs: number;
  maxMs: number;
  branchTs: string;
  branchMs: number;
}

function computeTimeWindow(branch: BranchRecord, eventTimes: string[]): TimeWindow {
  const branchMs = Date.parse(branch.policy.branch_point_ts);
  let minMs = branchMs - 60_000;
  let maxMs = branchMs + 60_000;
  for (const ts of eventTimes) {
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if (maxMs <= minMs) {
    maxMs = minMs + 1;
  }
  // Add a little headroom on either side so the branch point isn't pinned.
  const span = maxMs - minMs;
  minMs -= span * 0.05;
  maxMs += span * 0.05;
  return {
    minTs: new Date(minMs).toISOString(),
    maxTs: new Date(maxMs).toISOString(),
    minMs,
    maxMs,
    branchTs: branch.policy.branch_point_ts,
    branchMs,
  };
}

function tsAtT(window: TimeWindow, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  return new Date(window.minMs + (window.maxMs - window.minMs) * clamped).toISOString();
}

function xAtTs(window: TimeWindow, ts: string): number {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return 0;
  if (window.maxMs === window.minMs) return 0;
  return ((ms - window.minMs) / (window.maxMs - window.minMs)) * VIEW_WIDTH;
}

/** Cubic-bezier y at parameter u given control y values y0..y3. */
function bezY(u: number, y0: number, y1: number, y2: number, y3: number): number {
  const m = 1 - u;
  return m * m * m * y0 + 3 * m * m * u * y1 + 3 * m * u * u * y2 + u * u * u * y3;
}

/** Find y-coordinate of a track at a given x position. */
function trackYAt(world: WorldType, xPx: number, forkX: number): number {
  if (world === 'always-merged') return W2_Y;
  if (xPx <= forkX) return TRUNK_Y;
  const forkEnd = forkX + FORK_RUN;
  if (xPx >= forkEnd) return world === 'canonical' ? W0_Y : W1_Y;
  const u = (xPx - forkX) / FORK_RUN;
  if (world === 'canonical') return bezY(u, TRUNK_Y, TRUNK_Y, W0_Y, W0_Y);
  return bezY(u, TRUNK_Y, TRUNK_Y, W1_Y, W1_Y);
}

// ─── Component ──────────────────────────────────────────────────────────────

interface BranchExplorerProps {
  /** All branches for one merge subject — typically the three world variants. */
  branches: BranchRecord[];
}

export function BranchExplorer({ branches }: BranchExplorerProps) {
  const { theme } = useTheme();
  const recentEvents = useEoStore((s) => s.recentEvents);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const selectedWorld = useBranchStore((s) => s.selectedWorld);
  const selectedStance = useBranchStore((s) => s.selectedStance);
  const scrubberT = useBranchStore((s) => s.scrubberT);
  const setWorld = useBranchStore((s) => s.setWorld);
  const setStance = useBranchStore((s) => s.setStance);
  const setScrubberT = useBranchStore((s) => s.setScrubberT);
  const getProjection = useBranchStore((s) => s.getProjection);
  const ensureEngine = useBranchStore((s) => s.ensureEngine);
  const projectionCache = useBranchStore((s) => s.projectionCache);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef(false);
  const [divergencePoints, setDivergencePoints] = useState<DivergencePoint[]>([]);

  // Pick one canonical branch for time-window computation.
  const branch = useMemo(() => {
    return (
      branches.find((b) => b.policy.world === 'canonical') ??
      branches[0] ??
      null
    );
  }, [branches]);

  // Build a TimeWindow from all events that touch the branch's source / survivor.
  const timeWindow = useMemo<TimeWindow | null>(() => {
    if (!branch) return null;
    const sources = branch.subject.split(',').map((s) => s.trim()).filter(Boolean);
    const targets = new Set([...sources, branch.survivor_id]);
    const relevantTimes: string[] = [];
    for (const e of recentEvents) {
      if (
        targets.has(e.target) ||
        [...targets].some((t) => e.target.startsWith(t + '.'))
      ) {
        relevantTimes.push(e.ts);
      }
    }
    return computeTimeWindow(branch, relevantTimes);
  }, [branch, recentEvents, lastSeq]);

  // Warm the projection cache once per branch / window combination.
  useEffect(() => {
    if (!branch || !timeWindow) return;
    const engine = ensureEngine();
    if (!engine) return;
    const branchesToWarm = branches;
    void Promise.all(
      branchesToWarm.map((b) =>
        warmProjectionCache(engine, b, timeWindow.minTs, timeWindow.maxTs, 11),
      ),
    );
  }, [branch, branches, timeWindow, ensureEngine]);

  // Compute the divergence map so we can render ticks on the tracks at every
  // point where a world's state diverges from its neighbours.
  useEffect(() => {
    if (!branch) {
      setDivergencePoints([]);
      return;
    }
    const engine = ensureEngine();
    if (!engine) return;
    let cancelled = false;
    engine
      .divergenceMap(branch)
      .then((points) => {
        if (!cancelled) setDivergencePoints(points);
      })
      .catch((e) => {
        if (!cancelled) {
          console.warn('[branch-explorer] divergenceMap failed', e);
          setDivergencePoints([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [branch, lastSeq, ensureEngine]);

  if (!branch || !timeWindow) {
    return (
      <div style={{ padding: 24, color: theme.textSecondary, fontFamily: 'monospace' }}>
        No branches loaded. Open a SYN event from the log to create a branch set.
      </div>
    );
  }

  const forkX = xAtTs(timeWindow, timeWindow.branchTs);
  const scrubberX = scrubberT * VIEW_WIDTH;
  const scrubberTs = tsAtT(timeWindow, scrubberT);

  // ─── Drag handling ───
  function onPointerEvent(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setScrubberT(t);
  }

  function onMouseDown(e: React.MouseEvent) {
    dragRef.current = true;
    onPointerEvent(e.clientX);
  }

  function onTouchStart(e: React.TouchEvent) {
    dragRef.current = true;
    onPointerEvent(e.touches[0].clientX);
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      onPointerEvent(e.clientX);
    }
    function onTouchMove(e: TouchEvent) {
      if (!dragRef.current) return;
      onPointerEvent(e.touches[0].clientX);
    }
    function onUp() {
      dragRef.current = false;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove);
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pull projections for each world. They populate asynchronously the first
  // time and from cache afterward.
  const projections: Record<WorldType, ProjectedState | null> = {
    canonical: getProjection('canonical', scrubberTs),
    'never-merged': getProjection('never-merged', scrubberTs),
    'always-merged': getProjection('always-merged', scrubberTs),
  };
  // projectionCache subscription forces re-render once async fetches resolve.
  void projectionCache;

  // Filter events to dots that fall within the time window AND involve the
  // branch subject — keep the visualization focused.
  const relevantEvents = useMemo(() => {
    if (!branch) return [];
    const sources = branch.subject.split(',').map((s) => s.trim()).filter(Boolean);
    const targets = new Set([...sources, branch.survivor_id]);
    return recentEvents.filter((e) => {
      if (e.ts < timeWindow.minTs || e.ts > timeWindow.maxTs) return false;
      if (targets.has(e.target)) return true;
      for (const t of targets) {
        if (e.target.startsWith(t + '.')) return true;
      }
      return false;
    });
  }, [branch, recentEvents, timeWindow, lastSeq]);

  // Filter divergence points to those that fall inside the visible window —
  // out-of-window ticks would render off-canvas.
  const visibleDivergence = useMemo(() => {
    return divergencePoints.filter(
      (p) => p.ts >= timeWindow.minTs && p.ts <= timeWindow.maxTs,
    );
  }, [divergencePoints, timeWindow]);

  // Dedupe + stable-sort for the navigation list. Two points at the same
  // (ts, field) collapse into a single jump target — a single field that
  // diverges in multiple worlds should not force the user to press "next"
  // twice to get past it.
  const navigablePoints = useMemo(
    () => sortDivergencePoints(mergeDivergencePoints(visibleDivergence)),
    [visibleDivergence],
  );

  // Which point is currently closest to the scrubber — used to highlight
  // the active row in the DivergenceList as the user drags.
  const nearestPoint = useMemo(
    () => findNearestDivergence(navigablePoints, scrubberTs),
    [navigablePoints, scrubberTs],
  );

  function jumpToDivergence(point: DivergencePoint) {
    setScrubberT(tAtTs(timeWindow!, point.ts));
  }

  function jumpPrevDivergence() {
    const p = findPrevDivergence(navigablePoints, scrubberTs);
    if (p) jumpToDivergence(p);
  }

  function jumpNextDivergence() {
    const p = findNextDivergence(navigablePoints, scrubberTs);
    if (p) jumpToDivergence(p);
  }

  // Keyboard shortcuts: `[` / `]` step through divergences. Bound globally
  // rather than on the svg element so the user doesn't have to click into
  // the timeline first.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Skip when typing in an input / textarea — don't hijack normal text entry.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === '[') {
        jumpPrevDivergence();
        e.preventDefault();
      } else if (e.key === ']') {
        jumpNextDivergence();
        e.preventDefault();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigablePoints, scrubberTs, timeWindow]);

  // Count W-2 divergences for the meta row.
  const w2DivergenceCount = useMemo(
    () => divergencePoints.filter((p) => p.worlds_diverge.includes('always-merged')).length,
    [divergencePoints],
  );

  const sources = branch.subject
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Branch meta row */}
      <BranchMetaRow
        theme={theme}
        branch={branch}
        sources={sources}
        w2DivergenceCount={w2DivergenceCount}
        eventCount={relevantEvents.length}
      />

      {/* Top bar — world pills */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {(['canonical', 'never-merged', 'always-merged'] as WorldType[]).map((w) => (
          <WorldPill
            key={w}
            world={w}
            active={selectedWorld === w}
            onClick={() => setWorld(w)}
          />
        ))}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: 'monospace',
          }}
        >
          <DivergenceStepper
            theme={theme}
            totalPoints={navigablePoints.length}
            hasPrev={!!findPrevDivergence(navigablePoints, scrubberTs)}
            hasNext={!!findNextDivergence(navigablePoints, scrubberTs)}
            onPrev={jumpPrevDivergence}
            onNext={jumpNextDivergence}
          />
          <span style={{ fontSize: 10, color: theme.textMuted }}>
            {formatTimeFull(scrubberTs)}
          </span>
          <span style={{ fontSize: 12, fontWeight: 500, color: theme.text }}>
            t = {Math.round(scrubberT * 100)
              .toString()
              .padStart(2, '0')}
          </span>
        </div>
      </div>

      {/* EVA stance row — only when W-2 active */}
      {selectedWorld === 'always-merged' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            border: `0.5px solid ${theme.borderLight}`,
            borderRadius: 6,
          }}
        >
          <span style={{ fontSize: 10, color: theme.textSecondary, fontFamily: 'monospace' }}>
            EVA stance:
          </span>
          {STANCES.map((s) => (
            <StanceButton
              key={s}
              stance={s}
              active={selectedStance === s}
              onClick={() => setStance(s)}
            />
          ))}
        </div>
      )}

      {/* SVG timeline */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        width="100%"
        style={{ display: 'block', cursor: 'crosshair', overflow: 'visible' }}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
      >
        <defs>
          <pattern
            id="branch-hatch"
            patternUnits="userSpaceOnUse"
            width="7"
            height="7"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="7" stroke="#1D9E75" strokeWidth="1.2" opacity="0.4" />
          </pattern>
        </defs>

        {/* Background dim tracks */}
        <line
          x1="0"
          y1={W2_Y}
          x2={VIEW_WIDTH}
          y2={W2_Y}
          stroke={WORLD_TRACK_COLORS['always-merged']}
          strokeWidth={selectedWorld === 'always-merged' ? 3 : 1.5}
          opacity={selectedWorld === 'always-merged' ? 0.95 : 0.18}
        />
        <line
          x1="0"
          y1={TRUNK_Y}
          x2={forkX}
          y2={TRUNK_Y}
          stroke="#888780"
          strokeWidth={selectedWorld !== 'always-merged' ? 3 : 1.5}
          opacity={selectedWorld !== 'always-merged' ? 0.9 : 0.22}
        />
        <path
          d={`M${forkX},${TRUNK_Y} C${forkX + FORK_CTRL_1_DX},${TRUNK_Y} ${forkX + FORK_CTRL_2_DX},${W0_Y} ${forkX + FORK_RUN},${W0_Y} L${VIEW_WIDTH},${W0_Y}`}
          fill="none"
          stroke={WORLD_TRACK_COLORS.canonical}
          strokeWidth={selectedWorld === 'canonical' ? 3 : 1.5}
          opacity={selectedWorld === 'canonical' ? 0.9 : 0.18}
        />
        <path
          d={`M${forkX},${TRUNK_Y} C${forkX + FORK_CTRL_1_DX},${TRUNK_Y} ${forkX + FORK_CTRL_2_DX},${W1_Y} ${forkX + FORK_RUN},${W1_Y} L${VIEW_WIDTH},${W1_Y}`}
          fill="none"
          stroke={WORLD_TRACK_COLORS['never-merged']}
          strokeWidth={selectedWorld === 'never-merged' ? 3 : 1.5}
          opacity={selectedWorld === 'never-merged' ? 0.9 : 0.18}
        />

        {/* Indeterminate hatch on W-1 post-merge */}
        {selectedWorld === 'never-merged' && scrubberTs >= timeWindow.branchTs && (
          <rect
            x={forkX}
            y={W1_Y - 16}
            width={VIEW_WIDTH - forkX}
            height={32}
            fill="url(#branch-hatch)"
            opacity={0.85}
            rx={3}
          />
        )}

        {/* Event dots */}
        {relevantEvents.map((e) => {
          const x = xAtTs(timeWindow, e.ts);
          const color = OP_DOT_COLOR[e.op] ?? '#888780';
          if (e.op === 'SYN') {
            return (
              <rect
                key={`${e.seq}-syn`}
                x={x - 9}
                y={TRUNK_Y - 9}
                width="18"
                height="18"
                rx="2"
                transform={`rotate(45,${x},${TRUNK_Y})`}
                fill={WORLD_TRACK_COLORS.canonical}
                opacity={0.9}
              />
            );
          }
          // Stamp the dot on every track that exists at this x.
          const ys: Array<{ y: number; world: WorldType }> = [];
          ys.push({ y: W2_Y, world: 'always-merged' });
          if (x <= forkX) {
            ys.push({ y: TRUNK_Y, world: 'canonical' });
          } else {
            ys.push({ y: trackYAt('canonical', x, forkX), world: 'canonical' });
            ys.push({ y: trackYAt('never-merged', x, forkX), world: 'never-merged' });
          }
          return ys.map(({ y }, idx) => (
            <circle
              key={`${e.seq}-${idx}`}
              cx={x}
              cy={y}
              r="3.5"
              fill={color}
              opacity={0.55}
            />
          ));
        })}

        {/* Divergence ticks — a small mark on the tracks where the
            projection engine detected field-level divergence. W-2 divergences
            hit the top track; W-0/W-1 divergences straddle the fork. Each
            tick is clickable and snaps the scrubber to its timestamp. */}
        {visibleDivergence.map((d, idx) => {
          const x = xAtTs(timeWindow, d.ts);
          if (d.field_path === '_syn') {
            // Already rendered as the SYN diamond; skip.
            return null;
          }
          const ticks: Array<{ y: number; color: string }> = [];
          if (d.worlds_diverge.includes('always-merged')) {
            ticks.push({ y: W2_Y, color: WORLD_TRACK_COLORS['always-merged'] });
          }
          if (d.worlds_diverge.includes('canonical') || d.worlds_diverge.includes('never-merged')) {
            const y = x <= forkX ? TRUNK_Y : trackYAt('canonical', x, forkX);
            ticks.push({ y, color: WORLD_TRACK_COLORS.canonical });
            if (x > forkX) {
              ticks.push({ y: trackYAt('never-merged', x, forkX), color: WORLD_TRACK_COLORS['never-merged'] });
            }
          }
          const isNearest =
            nearestPoint !== null &&
            nearestPoint.ts === d.ts &&
            nearestPoint.field_path === d.field_path;
          return (
            <g
              key={`div-${idx}`}
              onClick={(e) => {
                e.stopPropagation();
                jumpToDivergence(d);
              }}
              onMouseDown={(e) => {
                // Prevent the svg's onMouseDown (drag scrubber) from firing
                // when the user clicks directly on a tick.
                e.stopPropagation();
              }}
              style={{ cursor: 'pointer' }}
            >
              {/* Invisible fat hit target for easier clicking. */}
              <rect
                x={x - 6}
                y={ticks.reduce((min, t) => Math.min(min, t.y - 10), Infinity)}
                width={12}
                height={ticks.reduce((max, t) => Math.max(max, t.y + 10), 0) -
                  ticks.reduce((min, t) => Math.min(min, t.y - 10), Infinity)}
                fill="transparent"
              />
              {ticks.map((t, j) => (
                <line
                  key={`div-${idx}-${j}`}
                  x1={x}
                  y1={t.y - 7}
                  x2={x}
                  y2={t.y + 7}
                  stroke={t.color}
                  strokeWidth={isNearest ? 2.2 : 1.2}
                  opacity={isNearest ? 1 : 0.75}
                >
                  <title>
                    {`divergence @ ${formatTimeShort(d.ts)} — field ${d.field_path} (click to jump)`}
                  </title>
                </line>
              ))}
            </g>
          );
        })}

        {/* SYN diamond at fork */}
        <rect
          x={forkX - 9}
          y={TRUNK_Y - 9}
          width="18"
          height="18"
          rx="2"
          transform={`rotate(45,${forkX},${TRUNK_Y})`}
          fill={WORLD_TRACK_COLORS.canonical}
          opacity={0.9}
        />
        <text
          x={forkX}
          y={TRUNK_Y - 18}
          fontSize="9"
          fill={WORLD_TRACK_COLORS.canonical}
          textAnchor="middle"
          fontFamily="monospace"
          opacity={0.9}
        >
          {'\u2B25 SYN'}
        </text>

        {/* Track labels */}
        <text x="6" y="43" fontSize="9.5" fill={WORLD_TRACK_COLORS['always-merged']} opacity={0.75} fontFamily="monospace">
          W-2  always merged
        </text>
        <text x="6" y="123" fontSize="9.5" fill="#888780" opacity={0.55} fontFamily="monospace">
          shared trunk  (W-0 = W-1 here)
        </text>
        <text x={Math.min(VIEW_WIDTH - 120, forkX + 100)} y="89" fontSize="9.5" fill={WORLD_TRACK_COLORS.canonical} opacity={0.85} fontFamily="monospace">
          W-0  canonical
        </text>
        <text x={Math.min(VIEW_WIDTH - 120, forkX + 100)} y="183" fontSize="9.5" fill={WORLD_TRACK_COLORS['never-merged']} opacity={0.85} fontFamily="monospace">
          W-1  never merged
        </text>

        {/* Time axis */}
        <line x1="0" y1="210" x2={VIEW_WIDTH} y2="210" stroke={theme.borderLight} strokeWidth="0.5" />
        <line x1="0" y1="207" x2="0" y2="213" stroke={theme.borderLight} strokeWidth="1" />
        <line x1={forkX} y1="207" x2={forkX} y2="213" stroke={WORLD_TRACK_COLORS.canonical} strokeWidth="1" opacity={0.7} />
        <line x1={VIEW_WIDTH} y1="207" x2={VIEW_WIDTH} y2="213" stroke={theme.borderLight} strokeWidth="1" />
        <text x="2" y="223" fontSize="9" fill="#888780" fontFamily="monospace" opacity={0.5}>
          {formatTimeShort(timeWindow.minTs)}
        </text>
        <text x={forkX - 14} y="223" fontSize="9" fill={WORLD_TRACK_COLORS.canonical} fontFamily="monospace" opacity={0.75}>
          SYN
        </text>
        <text x={VIEW_WIDTH - 30} y="223" fontSize="9" fill="#888780" fontFamily="monospace" opacity={0.5}>
          {formatTimeShort(timeWindow.maxTs)}
        </text>

        {/* Scrubber */}
        <line
          x1={scrubberX}
          y1="18"
          x2={scrubberX}
          y2="208"
          stroke={theme.text}
          strokeWidth="1"
          opacity={0.4}
          strokeDasharray="4,3"
          pointerEvents="none"
        />
        <circle cx={scrubberX} cy="18" r="5" fill={theme.text} opacity={0.55} pointerEvents="none" />

        {/* Scrubber timestamp callout — flips to the left side of the line once
            the scrubber passes the halfway mark so the label stays in view. */}
        {(() => {
          const flip = scrubberX > VIEW_WIDTH * 0.6;
          const tx = flip ? scrubberX - 6 : scrubberX + 6;
          const anchor = flip ? 'end' : 'start';
          return (
            <text
              x={tx}
              y="14"
              fontSize="9"
              fill={theme.text}
              fontFamily="monospace"
              opacity={0.75}
              textAnchor={anchor}
              pointerEvents="none"
            >
              {formatTimeShort(scrubberTs)}
            </text>
          );
        })()}

        {/* Scrubber intersect rings */}
        <ScrubberRing
          world="always-merged"
          x={scrubberX}
          y={W2_Y}
          active={selectedWorld === 'always-merged'}
        />
        {scrubberTs < timeWindow.branchTs ? (
          <ScrubberRing
            world="canonical"
            x={scrubberX}
            y={TRUNK_Y}
            active={selectedWorld === 'canonical' || selectedWorld === 'never-merged'}
          />
        ) : (
          <>
            <ScrubberRing
              world="canonical"
              x={scrubberX}
              y={trackYAt('canonical', scrubberX, forkX)}
              active={selectedWorld === 'canonical'}
            />
            <ScrubberRing
              world="never-merged"
              x={scrubberX}
              y={trackYAt('never-merged', scrubberX, forkX)}
              active={selectedWorld === 'never-merged'}
            />
          </>
        )}
      </svg>

      {/* Entity state cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {(['canonical', 'never-merged', 'always-merged'] as WorldType[]).map((w) => (
          <EntityCard
            key={w}
            world={w}
            active={selectedWorld === w}
            projection={projections[w]}
          />
        ))}
      </div>

      {/* Divergence list — click any row to snap the scrubber there.
          Nearest row to the current scrubber position is highlighted. */}
      {navigablePoints.length > 0 && (
        <DivergenceList
          theme={theme}
          points={navigablePoints}
          nearest={nearestPoint}
          onJump={jumpToDivergence}
        />
      )}

      {/* Legend */}
      <LegendRow theme={theme} />
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function WorldPill({ world, active, onClick }: { world: WorldType; active: boolean; onClick: () => void }) {
  const { theme } = useTheme();
  const color = WORLD_COLORS[world];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: active ? `1px solid ${color}` : `0.5px solid ${theme.borderLight}`,
        borderRadius: 20,
        padding: '4px 14px',
        fontSize: 11,
        cursor: 'pointer',
        background: active ? theme.bgMuted : theme.bgCard,
        color: active ? color : theme.textSecondary,
        fontFamily: 'monospace',
      }}
    >
      {WORLD_LABELS[world]}
    </button>
  );
}

function StanceButton({ stance, active, onClick }: { stance: EvaStance; active: boolean; onClick: () => void }) {
  const { theme } = useTheme();
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: 'monospace',
        fontSize: 10,
        border: active ? '0.5px solid #7F77DD' : `0.5px solid ${theme.borderLight}`,
        borderRadius: 3,
        padding: '2px 8px',
        cursor: 'pointer',
        background: active ? theme.bgMuted : theme.bgCard,
        color: active ? '#7F77DD' : theme.textSecondary,
      }}
    >
      {stance}
    </button>
  );
}

function ScrubberRing({
  world,
  x,
  y,
  active,
}: {
  world: WorldType;
  x: number;
  y: number;
  active: boolean;
}) {
  return (
    <circle
      cx={x}
      cy={y}
      r={active ? 6 : 4}
      fill={WORLD_TRACK_COLORS[world]}
      opacity={active ? 1 : 0.25}
      stroke="white"
      strokeWidth="1.5"
      pointerEvents="none"
    />
  );
}

function EntityCard({
  world,
  active,
  projection,
}: {
  world: WorldType;
  active: boolean;
  projection: ProjectedState | null;
}) {
  const { theme } = useTheme();
  const color = WORLD_COLORS[world];

  return (
    <div
      style={{
        border: active ? `1px solid ${color}` : `0.5px solid ${theme.borderLight}`,
        borderRadius: 6,
        padding: '8px 12px',
        opacity: active ? 1 : 0.45,
        transition: 'opacity 0.2s, border-color 0.15s',
      }}
    >
      <div
        style={{
          fontSize: 9.5,
          marginBottom: 5,
          letterSpacing: '0.05em',
          color,
          fontFamily: 'monospace',
        }}
      >
        {WORLD_LABELS[world]}
      </div>
      {projection === null ? (
        <div style={{ fontSize: 11, color: theme.textMuted, fontFamily: 'monospace' }}>
          loading…
        </div>
      ) : (
        <CardBody projection={projection} active={active} />
      )}
    </div>
  );
}

function CardBody({ projection, active }: { projection: ProjectedState; active: boolean }) {
  const { theme } = useTheme();
  if (projection.entities.length === 0) {
    return (
      <div style={{ fontSize: 11, color: theme.textMuted, fontFamily: 'monospace' }}>
        — no projection —
      </div>
    );
  }
  return (
    <>
      {projection.entities.map((entity) => (
        <div key={entity.target}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: theme.text,
              marginBottom: 4,
              fontFamily: 'monospace',
            }}
          >
            {entity.target}
          </div>
          {Object.entries(entity.fields).map(([key, field]) => (
            <FieldRow key={key} fieldKey={key} field={field} active={active} />
          ))}
        </div>
      ))}
    </>
  );
}

function FieldRow({
  fieldKey,
  field,
  active,
}: {
  fieldKey: string;
  field: ProjectedField;
  active: boolean;
}) {
  const { theme } = useTheme();
  let color = theme.text;
  let fontStyle: 'italic' | 'normal' = 'normal';
  let display = formatValue(field.value);

  if (field.epistemic === 'shadow') {
    color = theme.textSecondary;
    fontStyle = 'italic';
    display = '— shadow';
  } else if (field.epistemic === 'conflict') {
    color = '#D4537E';
    const list = (field.conflict_values ?? []).map(formatValue).join(', ');
    display = `\u22A2 [${list}]`;
  } else if (field.epistemic === 'policy-sensitive' && active) {
    color = '#7F77DD';
  }

  return (
    <div
      style={{
        fontSize: 11,
        color: theme.textSecondary,
        lineHeight: 1.7,
        fontFamily: 'monospace',
      }}
    >
      {fieldKey}: <span style={{ color, fontStyle }}>{display}</span>
      {field.epistemic === 'policy-sensitive' && active && (
        <span
          style={{
            display: 'inline-block',
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#7F77DD',
            marginLeft: 6,
            verticalAlign: 'middle',
          }}
        />
      )}
      {field.provenance && (
        <span style={{ color: theme.textMuted, marginLeft: 6 }}>({field.provenance})</span>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatTimeShort(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

function formatTimeFull(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-US', {
    hour12: false,
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ─── Branch meta row ────────────────────────────────────────────────────────

function BranchMetaRow({
  theme,
  branch,
  sources,
  w2DivergenceCount,
  eventCount,
}: {
  theme: Theme;
  branch: BranchRecord;
  sources: string[];
  w2DivergenceCount: number;
  eventCount: number;
}) {
  const items: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: 'subject', value: sources.join(' + ') || '(none)', mono: true },
    { label: 'survivor', value: branch.survivor_id, mono: true },
    { label: 'forked at', value: formatTimeFull(branch.policy.branch_point_ts) },
    { label: 'events in window', value: String(eventCount) },
    { label: 'W-2 collisions', value: String(w2DivergenceCount) },
  ];
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 18px',
        padding: '6px 10px',
        border: `0.5px solid ${theme.borderLight}`,
        borderLeft: '2px solid #EF9F27',
        borderRadius: 4,
        background: theme.bgMuted,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            fontFamily: 'monospace',
            fontSize: 10.5,
            minWidth: 0,
          }}
        >
          <span
            style={{
              color: theme.textMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: 9,
            }}
          >
            {item.label}
          </span>
          <span
            style={{
              color: theme.text,
              fontWeight: item.mono ? 500 : 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 260,
            }}
            title={item.value}
          >
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Legend ─────────────────────────────────────────────────────────────────

function LegendRow({ theme }: { theme: Theme }) {
  const items: Array<{ swatch: JSX.Element; label: string }> = [
    {
      swatch: <Swatch color={WORLD_TRACK_COLORS.canonical} />,
      label: 'W-0 canonical',
    },
    {
      swatch: <Swatch color={WORLD_TRACK_COLORS['never-merged']} />,
      label: 'W-1 never merged',
    },
    {
      swatch: <Swatch color={WORLD_TRACK_COLORS['always-merged']} />,
      label: 'W-2 always merged',
    },
    {
      swatch: (
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            background: WORLD_TRACK_COLORS.canonical,
            transform: 'rotate(45deg)',
            opacity: 0.9,
          }}
        />
      ),
      label: 'SYN event',
    },
    {
      swatch: (
        <span
          style={{
            display: 'inline-block',
            width: 1.5,
            height: 12,
            background: WORLD_TRACK_COLORS.canonical,
            opacity: 0.8,
          }}
        />
      ),
      label: 'divergence tick',
    },
    {
      swatch: (
        <span
          style={{
            display: 'inline-block',
            width: 14,
            height: 8,
            background:
              'repeating-linear-gradient(45deg, #1D9E75 0 2px, transparent 2px 5px)',
            opacity: 0.85,
          }}
        />
      ),
      label: 'shadow / indeterminate',
    },
    {
      swatch: (
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#D4537E',
            opacity: 0.9,
          }}
        />
      ),
      label: 'DEF conflict',
    },
    {
      swatch: (
        <span
          style={{
            display: 'inline-block',
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: '#7F77DD',
            opacity: 0.9,
          }}
        />
      ),
      label: 'policy-sensitive',
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 14px',
        paddingTop: 8,
        borderTop: `0.5px solid ${theme.borderLight}`,
        fontFamily: 'monospace',
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            color: theme.textMuted,
          }}
        >
          {item.swatch}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 3,
        background: color,
        borderRadius: 1,
        opacity: 0.9,
      }}
    />
  );
}

// ─── Divergence navigation ──────────────────────────────────────────────────

/**
 * Prev / next stepper that snaps the scrubber to the adjacent divergence
 * point. Shown next to the scrubber time readout in the top bar. Buttons
 * disable when there's nothing to step to. Also surfaces the in-window
 * divergence count so the user sees "3 points" before deciding to step.
 */
function DivergenceStepper({
  theme,
  totalPoints,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  theme: Theme;
  totalPoints: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const disabledStyle = {
    opacity: 0.3,
    cursor: 'not-allowed' as const,
  };
  const activeStyle = {
    opacity: 1,
    cursor: 'pointer' as const,
  };
  const baseButton: React.CSSProperties = {
    fontFamily: 'monospace',
    fontSize: 11,
    background: 'transparent',
    border: `0.5px solid ${theme.borderLight}`,
    borderRadius: 3,
    color: theme.textSecondary,
    padding: '2px 7px',
    lineHeight: 1.1,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button
        type="button"
        onClick={onPrev}
        disabled={!hasPrev}
        title="Previous divergence  [ "
        aria-label="Jump to previous divergence"
        style={{ ...baseButton, ...(hasPrev ? activeStyle : disabledStyle) }}
      >
        {'\u25C0'} prev
      </button>
      <span
        style={{
          fontSize: 10,
          color: theme.textMuted,
          fontFamily: 'monospace',
          minWidth: 46,
          textAlign: 'center',
        }}
      >
        {totalPoints} {totalPoints === 1 ? 'div' : 'divs'}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={!hasNext}
        title="Next divergence  ]"
        aria-label="Jump to next divergence"
        style={{ ...baseButton, ...(hasNext ? activeStyle : disabledStyle) }}
      >
        next {'\u25B6'}
      </button>
    </div>
  );
}

/**
 * Chronological list of every divergence inside the visible window. Each
 * row shows the timestamp, the field, and colored dots for every world
 * that diverges at this point. Clicking a row snaps the scrubber to its
 * timestamp. The row nearest to the current scrubber position is
 * highlighted so the user sees "where am I" at a glance while dragging.
 */
function DivergenceList({
  theme,
  points,
  nearest,
  onJump,
}: {
  theme: Theme;
  points: DivergencePoint[];
  nearest: DivergencePoint | null;
  onJump: (point: DivergencePoint) => void;
}) {
  return (
    <div
      style={{
        border: `0.5px solid ${theme.borderLight}`,
        borderRadius: 6,
        padding: '8px 10px',
        background: theme.bgCard,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: theme.textMuted,
            fontFamily: 'monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          divergences in window ({points.length})
        </span>
        <span
          style={{
            fontSize: 9,
            color: theme.textMuted,
            fontFamily: 'monospace',
          }}
        >
          {'['} prev  {']'} next
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          maxHeight: 140,
          overflowY: 'auto',
        }}
      >
        {points.map((point) => {
          const isActive =
            nearest !== null &&
            nearest.ts === point.ts &&
            nearest.field_path === point.field_path;
          const isSyn = point.field_path === '_syn';
          return (
            <button
              key={`${point.ts}-${point.field_path}`}
              type="button"
              onClick={() => onJump(point)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '4px 6px',
                border: 'none',
                background: isActive ? theme.bgActive : 'transparent',
                borderLeft: isActive
                  ? `2px solid ${WORLD_TRACK_COLORS.canonical}`
                  : '2px solid transparent',
                color: theme.text,
                fontFamily: 'monospace',
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
                borderRadius: 2,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: theme.textMuted,
                  minWidth: 48,
                  textAlign: 'right',
                }}
              >
                {formatTimeShort(point.ts)}
              </span>
              <span
                style={{
                  flex: 1,
                  color: isSyn ? WORLD_TRACK_COLORS.canonical : theme.textSecondary,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontStyle: isSyn ? 'italic' : 'normal',
                }}
              >
                {isSyn ? 'SYN fork point' : point.field_path}
              </span>
              <span style={{ display: 'flex', gap: 3 }}>
                {point.worlds_diverge.map((w) => (
                  <span
                    key={w}
                    title={`${w} diverges here`}
                    style={{
                      display: 'inline-block',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: WORLD_TRACK_COLORS[w],
                      opacity: 0.9,
                    }}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
