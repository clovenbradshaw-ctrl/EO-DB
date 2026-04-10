import { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import type { EoState } from '../db/types';
import { useTheme, type Theme } from '../theme';
import {
  type DateColumnOption,
  type TimeScrubberFilter,
  DEFAULT_FILTER,
  computeDateRange,
  buildAdaptiveFormatter,
} from './time-scrubber-utils';
import { hasFieldsSubObject } from './filter-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HorizonProps {
  records: EoState[];
  dateColumns: DateColumnOption[];
  filter: TimeScrubberFilter;
  onFilterChange: (filter: TimeScrubberFilter) => void;
}

interface DragState {
  lastX: number;
  startY: number;
  currentValue: number;
  trackWidth: number;
  pointerId: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function sensitivityLabel(dy: number): string | null {
  if (dy < 12) return null;
  const factor = 1 / (1 + dy / 60);
  if (factor > 0.7) return null;
  return `${Math.round(factor * 100)}%`;
}

// ---------------------------------------------------------------------------
// Global CSS (injected once for animation + panel transition)
// ---------------------------------------------------------------------------

const HORIZON_STYLE_ID = 'eo-horizon-v2';
if (typeof document !== 'undefined' && !document.getElementById(HORIZON_STYLE_ID)) {
  const el = document.createElement('style');
  el.id = HORIZON_STYLE_ID;
  el.textContent = `
    @keyframes eo-livepulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.3; }
    }
    .eo-horizon-live { animation: eo-livepulse 2.2s ease-in-out infinite; }
    .eo-horizon-panel {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.35s ease;
    }
    .eo-horizon-panel.open { max-height: 400px; }
  `;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEEDS = [0.5, 1, 2, 4];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Horizon({ records, dateColumns, filter, onFilterChange }: HorizonProps) {
  const { theme } = useTheme();
  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);

  const range = useMemo(
    () => computeDateRange(records, filter.dateField, useFieldsSub),
    [records, filter.dateField, useFieldsSub],
  );

  const sliderMin = range?.min ?? Date.now() - 365 * 86400000;
  const sliderMax = range?.max ?? Date.now();
  const buffer = Math.max((sliderMax - sliderMin) * 0.005, 60000);
  const trackMin = sliderMin - buffer;
  const trackMax = sliderMax + buffer;
  const trackRange = trackMax - trackMin;

  const currentPos = filter.rangeMax ?? trackMax;
  const isLive = filter.rangeMax == null;

  const formatDate = useMemo(() => buildAdaptiveFormatter(trackRange), [trackRange]);

  // ---- UI state ----
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1);

  // ---- Refs ----
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const rafRef = useRef<number | null>(null);
  const playPosRef = useRef(currentPos);
  // Always-current speed ref — lets us change speed without stopping playback
  const playSpeedRef = useRef(playSpeed);
  playSpeedRef.current = playSpeed;

  // ---- Local visual state (smooth during drag / playback) ----
  const [vizPos, setVizPos] = useState(currentPos);
  const [dragging, setDragging] = useState(false);
  const [precisionPct, setPrecisionPct] = useState<string | null>(null);

  // Sync visual position when filter changes externally
  useEffect(() => {
    if (!dragRef.current) {
      setVizPos(currentPos);
      playPosRef.current = currentPos;
    }
  }, [currentPos]);

  // ---- Value helpers ----
  const valueToFraction = useCallback(
    (v: number) => (v - trackMin) / trackRange,
    [trackMin, trackRange],
  );

  const commitValue = useCallback(
    (value: number) => {
      const clamped = clamp(value, trackMin, trackMax);
      setVizPos(clamped);
      const pos = clamped >= trackMax - buffer ? null : clamped;
      onFilterChange({ ...filter, rangeMin: null, rangeMax: pos });
    },
    [filter, onFilterChange, trackMin, trackMax, buffer],
  );

  // ---- Playback ----
  const stopPlay = useCallback(() => {
    setPlaying(false);
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startPlay = useCallback(() => {
    if (!range) return;
    setPlaying(true);
    let lastTs: number | null = null;
    const tick = (ts: number) => {
      if (lastTs == null) lastTs = ts;
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;
      // At 1× speed: traverses the full range in 30 s
      const advance = (trackRange * playSpeedRef.current * dt) / 30;
      playPosRef.current = clamp(playPosRef.current + advance, trackMin, trackMax);
      if (playPosRef.current >= trackMax - buffer) {
        commitValue(trackMax);
        stopPlay();
        return;
      }
      commitValue(playPosRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [range, trackRange, trackMin, trackMax, buffer, commitValue, stopPlay]);

  // Cancel RAF on unmount
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Stop playback when scrubber resets to live
  useEffect(() => { if (isLive) stopPlay(); }, [isLive, stopPlay]);

  // ---- Pointer handlers ----
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!trackRef.current || !range) return;
      stopPlay();
      const rect = trackRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const value = trackMin + fraction * trackRange;
      dragRef.current = {
        lastX: e.clientX,
        startY: e.clientY,
        currentValue: value,
        trackWidth: rect.width,
        pointerId: e.pointerId,
      };
      trackRef.current.setPointerCapture(e.pointerId);
      setDragging(true);
      setPrecisionPct(null);
      commitValue(value);
    },
    [range, trackMin, trackRange, commitValue, stopPlay],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.startY;
      // Drag down = finer precision
      const sensitivity = 1 / (1 + Math.max(0, dy) / 60);
      const timePerPixel = trackRange / drag.trackWidth;
      drag.currentValue = clamp(
        drag.currentValue + dx * sensitivity * timePerPixel,
        trackMin,
        trackMax,
      );
      drag.lastX = e.clientX;
      setPrecisionPct(sensitivityLabel(dy));
      commitValue(drag.currentValue);
    },
    [trackMin, trackMax, trackRange, commitValue],
  );

  const onPointerUp = useCallback((_e: React.PointerEvent) => {
    dragRef.current = null;
    setDragging(false);
    setPrecisionPct(null);
  }, []);

  // ---- Callbacks ----
  const handleDateFieldChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onFilterChange({ ...DEFAULT_FILTER, dateField: e.target.value });
    },
    [onFilterChange],
  );

  const handleReset = useCallback(() => {
    stopPlay();
    setExpanded(false);
    onFilterChange({ ...DEFAULT_FILTER, dateField: filter.dateField });
  }, [filter.dateField, onFilterChange, stopPlay]);

  const handleJump = useCallback(
    (frac: number) => {
      stopPlay();
      const value = trackMin + frac * trackRange;
      playPosRef.current = value;
      commitValue(value);
    },
    [stopPlay, trackMin, trackRange, commitValue],
  );

  // ---- Derived values ----
  const pctPos = valueToFraction(vizPos) * 100;
  const dateFieldLabel = dateColumns.find((c) => c.key === filter.dateField)?.label ?? filter.dateField;
  const isPast = !isLive;
  const s = makeStyles(theme);

  return (
    <div style={s.container}>

      {/* ── Top row — always visible ── */}
      <div style={s.topRow}>

        {/* Left cell — field pill / selector */}
        {dateColumns.length > 1 ? (
          <select
            value={filter.dateField}
            onChange={handleDateFieldChange}
            style={{ ...s.fieldPill, cursor: 'pointer' }}
          >
            {dateColumns.map((col) => (
              <option key={col.key} value={col.key}>{col.label}</option>
            ))}
          </select>
        ) : (
          <span style={s.fieldPill}>{dateFieldLabel}</span>
        )}

        {/* Center cell — date label + indicator dot */}
        <div style={s.topRowCenter}>
          {range && (
            <span style={{ ...s.dateDisplay, color: isPast ? theme.purple : theme.textSecondary }}>
              {isLive ? 'Live' : formatDate(vizPos)}
            </span>
          )}
          <span
            className={isLive ? 'eo-horizon-live' : undefined}
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              flexShrink: 0,
              background: isLive ? theme.success : theme.purple,
              boxShadow: isLive ? `0 0 5px ${theme.success}` : `0 0 5px ${theme.purple}`,
              transition: 'background 0.3s, box-shadow 0.3s',
            }}
          />
        </div>

        {/* Right cell — expand toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            ...s.histBtn,
            ...(expanded ? {
              borderColor: theme.purpleBorder,
              color: theme.purple,
              background: theme.purpleBg,
            } : {}),
          }}
        >
          {expanded ? '↑ Close' : '⏮ History'}
        </button>

      </div>

      {/* ── Collapsible panel ── */}
      <div className={`eo-horizon-panel${expanded ? ' open' : ''}`}>
        <div style={s.bodyInner}>

          {/* Track */}
          <div
            ref={trackRef}
            style={{ ...s.trackOuter, cursor: range ? 'pointer' : 'default' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* Background track */}
            <div style={{ ...s.trackBg, background: theme.bgMuted }} />

            {/* Fill */}
            {range && (
              <div style={{
                ...s.trackFill,
                width: `${pctPos}%`,
                background: isPast
                  ? `linear-gradient(90deg, ${theme.purpleBorder}, ${theme.purple})`
                  : `linear-gradient(90deg, ${theme.tealBorder}, ${theme.accent})`,
              }} />
            )}

            {/* Node */}
            {range && (
              <div style={{
                ...s.node,
                left: `${pctPos}%`,
                borderColor: isPast ? theme.purple : theme.accent,
                boxShadow: `0 0 0 3px ${isPast ? theme.purpleBg : theme.accentBg}`,
              }}>
                {/* Drag tooltip */}
                {dragging && (
                  <div style={s.tooltip}>
                    {formatDate(vizPos)}
                    {precisionPct && (
                      <span style={{ ...s.precisionBadge, color: isPast ? theme.purple : theme.accent }}>
                        {precisionPct}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Static date label under node */}
            {range && !dragging && (
              <span style={{
                ...s.nodeLabel,
                left: `${pctPos}%`,
                color: isPast ? theme.purple : theme.textMuted,
              }}>
                {formatDate(vizPos)}
              </span>
            )}
          </div>

          {/* Past banner */}
          {isPast && range && (
            <div style={s.pastBanner}>
              <span style={{ flex: 1, fontSize: 11, lineHeight: '1.3', color: theme.purple }}>
                Viewing{' '}
                <strong style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
                  {formatDate(vizPos)}
                </strong>
                {' '}— read-only
              </span>
              <button onClick={handleReset} style={s.returnBtn}>
                ↺ Return to live
              </button>
            </div>
          )}

          {/* Controls panel */}
          <div style={s.panel}>

            {/* Jump row */}
            <div style={s.panelRow}>
              <span style={s.panelLabel}>Jump</span>
              {([
                { label: '|← Start', frac: 0 },
                { label: '¼', frac: 0.25 },
                { label: '¾', frac: 0.75 },
                { label: 'End →|', frac: 1 },
              ] as const).map(({ label, frac }) => (
                <button key={frac} style={s.jumpBtn} onClick={() => handleJump(frac)}>
                  {label}
                </button>
              ))}
            </div>

            {/* Playback row */}
            <div style={s.panelRow}>
              <span style={s.panelLabel}>Speed</span>
              <div style={s.speedGroup}>
                {SPEEDS.map((sp, i) => (
                  <button
                    key={sp}
                    style={{
                      ...s.speedBtn,
                      borderRight: i < SPEEDS.length - 1 ? `0.5px solid ${theme.border}` : 'none',
                      ...(playSpeed === sp ? { background: theme.purpleBg, color: theme.purple } : {}),
                    }}
                    onClick={() => setPlaySpeed(sp)}
                  >
                    {sp === 0.5 ? '½×' : `${sp}×`}
                  </button>
                ))}
              </div>
              <button
                style={{
                  ...s.playBtn,
                  background: playing ? theme.purpleBg : theme.accentBg,
                  color: playing ? theme.purple : theme.accent,
                  borderColor: playing ? theme.purpleBorder : theme.accentBorder,
                  opacity: range ? 1 : 0.5,
                  cursor: range ? 'pointer' : 'default',
                }}
                onClick={() => (playing ? stopPlay() : startPlay())}
                disabled={!range}
              >
                {playing ? '⏸ Pause' : '▶ Play'}
              </button>
            </div>

          </div>
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      display: 'flex',
      flexDirection: 'column',
      background: 'transparent',
      flexShrink: 0,
      userSelect: 'none',
    } as React.CSSProperties,

    // ── Top row — 3-column grid: field pill | centered Live/date | History button ──
    topRow: {
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto',
      alignItems: 'center',
      columnGap: 10,
      padding: '4px 12px',
      minHeight: 28,
    } as React.CSSProperties,
    topRowCenter: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minWidth: 0,
    } as React.CSSProperties,

    fieldPill: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 8px',
      height: 20,
      background: t.bgMuted,
      border: `0.5px solid ${t.border}`,
      borderRadius: 10,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      outline: 'none',
      flexShrink: 0,
    } as React.CSSProperties,

    dateDisplay: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 500,
      letterSpacing: '0.01em',
      whiteSpace: 'nowrap',
      transition: 'color 0.3s',
    } as React.CSSProperties,

    histBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 9px',
      height: 20,
      background: 'transparent',
      border: `0.5px solid ${t.border}`,
      borderRadius: 10,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      transition: 'all 0.15s',
      flexShrink: 0,
    } as React.CSSProperties,

    // ── Body ──
    bodyInner: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '0 12px 10px',
    } as React.CSSProperties,

    // ── Track ──
    trackOuter: {
      position: 'relative',
      height: 28,
      minWidth: 100,
      touchAction: 'none',
    } as React.CSSProperties,

    trackBg: {
      position: 'absolute',
      top: '50%',
      left: 0,
      right: 0,
      height: 3,
      borderRadius: 1.5,
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
    } as React.CSSProperties,

    trackFill: {
      position: 'absolute',
      top: '50%',
      left: 0,
      height: 3,
      borderRadius: 1.5,
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
    } as React.CSSProperties,

    node: {
      position: 'absolute',
      top: '50%',
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: t.bgCard,
      border: `2px solid ${t.accent}`,
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      zIndex: 3,
      transition: 'border-color 0.3s, box-shadow 0.3s',
    } as React.CSSProperties,

    tooltip: {
      position: 'absolute',
      bottom: 18,
      left: '50%',
      transform: 'translateX(-50%)',
      whiteSpace: 'nowrap',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.text,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      padding: '2px 6px',
      boxShadow: `0 2px 6px rgba(0,0,0,0.12)`,
      zIndex: 10,
      pointerEvents: 'none',
    } as React.CSSProperties,

    precisionBadge: {
      marginLeft: 4,
      fontSize: 9,
      fontWeight: 600,
    } as React.CSSProperties,

    nodeLabel: {
      position: 'absolute',
      bottom: -1,
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      transform: 'translateX(-50%)',
      transition: 'color 0.3s',
    } as React.CSSProperties,

    // ── Past banner ──
    pastBanner: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      background: t.purpleBg,
      border: `0.5px solid ${t.purpleBorder}`,
      borderRadius: 5,
    } as React.CSSProperties,

    returnBtn: {
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      padding: '3px 9px',
      background: 'transparent',
      border: `0.5px solid ${t.purpleBorder}`,
      borderRadius: 10,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 600,
      color: t.purple,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as React.CSSProperties,

    // ── Controls panel ──
    panel: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: '8px 10px',
      background: t.bgMuted,
      border: `0.5px solid ${t.border}`,
      borderRadius: 5,
    } as React.CSSProperties,

    panelRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flexWrap: 'wrap',
    } as React.CSSProperties,

    panelLabel: {
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      fontWeight: 600,
      minWidth: 36,
      whiteSpace: 'nowrap',
    } as React.CSSProperties,

    jumpBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      background: t.bgCard,
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as React.CSSProperties,

    speedGroup: {
      display: 'flex',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      overflow: 'hidden',
    } as React.CSSProperties,

    speedBtn: {
      padding: '2px 7px',
      background: t.bgCard,
      border: 'none',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      lineHeight: 1.5,
    } as React.CSSProperties,

    playBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '3px 10px',
      border: `0.5px solid ${t.accentBorder}`,
      borderRadius: 4,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      fontWeight: 600,
      whiteSpace: 'nowrap',
    } as React.CSSProperties,
  };
}
