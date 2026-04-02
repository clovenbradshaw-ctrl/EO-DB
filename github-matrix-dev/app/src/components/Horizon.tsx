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
  handle: 'min' | 'max';
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

/** Compute a human-friendly sensitivity label. */
function sensitivityLabel(dy: number): string | null {
  if (dy < 12) return null;
  const factor = 1 / (1 + dy / 60);
  if (factor > 0.7) return null;
  const pct = Math.round(factor * 100);
  return `${pct}%`;
}

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

  const currentMin = filter.rangeMin ?? trackMin;
  const currentMax = filter.rangeMax ?? trackMax;

  // Adaptive date formatter based on actual data span
  const formatDate = useMemo(
    () => buildAdaptiveFormatter(trackRange),
    [trackRange],
  );

  const isActive =
    filter.rangeMin != null ||
    filter.rangeMax != null ||
    filter.emptyHandling !== 'show';

  // ---- Refs ----
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // ---- Local visual state (smooth during drag) ----
  const [vizMin, setVizMin] = useState(currentMin);
  const [vizMax, setVizMax] = useState(currentMax);
  const [dragging, setDragging] = useState(false);
  const [precisionPct, setPrecisionPct] = useState<string | null>(null);

  // Sync visual state when filter changes externally
  useEffect(() => {
    if (!dragRef.current) {
      setVizMin(currentMin);
      setVizMax(currentMax);
    }
  }, [currentMin, currentMax]);

  // ---- Settings popover ----
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close settings on outside click
  useEffect(() => {
    if (!showSettings) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettings]);

  // ---- Value helpers ----
  const valueToFraction = useCallback(
    (v: number) => (v - trackMin) / trackRange,
    [trackMin, trackRange],
  );

  const commitValue = useCallback(
    (handle: 'min' | 'max', value: number) => {
      const clamped = clamp(value, trackMin, trackMax);
      if (handle === 'min') {
        setVizMin(clamped);
        const newMin = clamped <= trackMin + buffer ? null : clamped;
        const newMax = filter.rangeMax != null ? Math.max(filter.rangeMax, clamped) : null;
        onFilterChange({ ...filter, rangeMin: newMin, rangeMax: newMax });
      } else {
        setVizMax(clamped);
        const newMax = clamped >= trackMax - buffer ? null : clamped;
        const newMin = filter.rangeMin != null ? Math.min(filter.rangeMin, clamped) : null;
        onFilterChange({ ...filter, rangeMax: newMax, rangeMin: newMin });
      }
    },
    [filter, onFilterChange, trackMin, trackMax, buffer],
  );

  // ---- Pointer handlers ----
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!trackRef.current || !range) return;
      const rect = trackRef.current.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const value = trackMin + fraction * trackRange;

      // Determine closest handle
      const distMin = Math.abs(value - (dragging ? vizMin : currentMin));
      const distMax = Math.abs(value - (dragging ? vizMax : currentMax));
      const handle: 'min' | 'max' = distMin <= distMax ? 'min' : 'max';

      dragRef.current = {
        handle,
        lastX: e.clientX,
        startY: e.clientY,
        currentValue: value,
        trackWidth: rect.width,
        pointerId: e.pointerId,
      };

      trackRef.current.setPointerCapture(e.pointerId);
      setDragging(true);
      setPrecisionPct(null);

      // Snap handle to click position
      commitValue(handle, value);
    },
    [range, trackMin, trackRange, currentMin, currentMax, vizMin, vizMax, dragging, commitValue],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.startY;

      // Drag down = slower scrubbing
      const sensitivity = 1 / (1 + Math.max(0, dy) / 60);
      const timePerPixel = trackRange / drag.trackWidth;
      drag.currentValue = clamp(
        drag.currentValue + dx * sensitivity * timePerPixel,
        trackMin,
        trackMax,
      );
      drag.lastX = e.clientX;

      setPrecisionPct(sensitivityLabel(dy));
      commitValue(drag.handle, drag.currentValue);
    },
    [trackMin, trackMax, trackRange, commitValue],
  );

  const onPointerUp = useCallback(
    (_e: React.PointerEvent) => {
      dragRef.current = null;
      setDragging(false);
      setPrecisionPct(null);
    },
    [],
  );

  // ---- Callbacks ----
  const handleDateFieldChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onFilterChange({ ...DEFAULT_FILTER, dateField: e.target.value });
    },
    [onFilterChange],
  );

  const handleEmptyChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onFilterChange({
        ...filter,
        emptyHandling: e.target.value as TimeScrubberFilter['emptyHandling'],
      });
    },
    [filter, onFilterChange],
  );

  const handleReset = useCallback(() => {
    onFilterChange({ ...DEFAULT_FILTER, dateField: filter.dateField });
  }, [filter.dateField, onFilterChange]);

  // ---- Computed visual positions ----
  const pctMin = valueToFraction(vizMin) * 100;
  const pctMax = valueToFraction(vizMax) * 100;

  const trackBg = range
    ? `linear-gradient(to right,
        ${theme.bgMuted} 0%,
        ${theme.bgMuted} ${pctMin}%,
        ${theme.accent}44 ${pctMin}%,
        ${theme.accent}44 ${pctMax}%,
        ${theme.bgMuted} ${pctMax}%,
        ${theme.bgMuted} 100%)`
    : theme.bgMuted;

  // ---- Current date field label ----
  const dateFieldLabel =
    dateColumns.find((c) => c.key === filter.dateField)?.label ?? filter.dateField;

  const s = styles(theme);

  return (
    <div className="eo-horizon" style={s.bar}>
      {/* Settings area */}
      <div ref={settingsRef} style={s.settingsWrap}>
        <button
          style={s.settingsBtn}
          onClick={() => setShowSettings((v) => !v)}
          title="Horizon settings"
        >
          <span style={{ fontSize: 10, opacity: 0.7 }}>{dateFieldLabel}</span>
          <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.4 }}>&#9662;</span>
        </button>

        {showSettings && (
          <div style={s.popover}>
            <label style={s.popLabel}>Date field</label>
            <select
              value={filter.dateField}
              onChange={handleDateFieldChange}
              style={s.popSelect}
            >
              {dateColumns.map((col) => (
                <option key={col.key} value={col.key}>
                  {col.label}
                </option>
              ))}
            </select>

            <label style={{ ...s.popLabel, marginTop: 6 }}>Empty records</label>
            <select
              value={filter.emptyHandling}
              onChange={handleEmptyChange}
              style={s.popSelect}
            >
              <option value="show">Show</option>
              <option value="hide">Hide</option>
              <option value="end">At end</option>
            </select>
          </div>
        )}
      </div>

      {/* Track area */}
      <div
        ref={trackRef}
        style={s.trackOuter}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* Background track */}
        <div style={{ ...s.trackBar, background: trackBg }} />

        {/* Min handle */}
        {range && (
          <div
            style={{
              ...s.handle,
              left: `${pctMin}%`,
              background: theme.accent,
            }}
          >
            {/* Date tooltip */}
            {(dragging && dragRef.current?.handle === 'min') && (
              <div style={s.tooltip}>
                {formatDate(vizMin)}
                {precisionPct && (
                  <span style={s.precisionBadge}>{precisionPct}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Max handle */}
        {range && (
          <div
            style={{
              ...s.handle,
              left: `${pctMax}%`,
              background: theme.accent,
            }}
          >
            {(dragging && dragRef.current?.handle === 'max') && (
              <div style={s.tooltip}>
                {formatDate(vizMax)}
                {precisionPct && (
                  <span style={s.precisionBadge}>{precisionPct}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Date range labels (shown when not dragging) */}
        {range && !dragging && (
          <>
            <span style={{ ...s.rangeLabel, left: `${pctMin}%` }}>
              {formatDate(filter.rangeMin ?? sliderMin)}
            </span>
            <span style={{ ...s.rangeLabel, left: `${pctMax}%`, transform: 'translateX(-100%)' }}>
              {formatDate(filter.rangeMax ?? sliderMax)}
            </span>
          </>
        )}
      </div>

      {/* Reset */}
      {isActive && (
        <button onClick={handleReset} style={s.resetBtn} title="Reset horizon">
          &times;
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    bar: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 16px',
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      minHeight: 28,
      userSelect: 'none',
    } as React.CSSProperties,

    // ---- Settings ----
    settingsWrap: {
      position: 'relative',
      flexShrink: 0,
    } as React.CSSProperties,

    settingsBtn: {
      display: 'flex',
      alignItems: 'center',
      height: 20,
      padding: '0 6px',
      background: 'transparent',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      color: t.textSecondary,
      fontFamily: "'JetBrains Mono', monospace",
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    } as React.CSSProperties,

    popover: {
      position: 'absolute',
      top: 24,
      left: 0,
      zIndex: 100,
      background: t.bgCard,
      border: `1px solid ${t.border}`,
      borderRadius: 6,
      padding: 8,
      minWidth: 160,
      boxShadow: `0 4px 12px rgba(0,0,0,0.15)`,
    } as React.CSSProperties,

    popLabel: {
      display: 'block',
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      marginBottom: 2,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.5px',
    },

    popSelect: {
      width: '100%',
      height: 22,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '0 4px',
      border: `0.5px solid ${t.border}`,
      borderRadius: 3,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      cursor: 'pointer',
    },

    // ---- Track ----
    trackOuter: {
      position: 'relative',
      flex: 1,
      height: 24,
      minWidth: 120,
      cursor: 'pointer',
      touchAction: 'none',
    } as React.CSSProperties,

    trackBar: {
      position: 'absolute',
      top: '50%',
      left: 0,
      right: 0,
      height: 3,
      borderRadius: 1.5,
      transform: 'translateY(-50%)',
      transition: 'height 0.15s ease',
      pointerEvents: 'none',
    } as React.CSSProperties,

    // ---- Handles ----
    handle: {
      position: 'absolute',
      top: '50%',
      width: 2,
      height: 14,
      borderRadius: 1,
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      zIndex: 3,
      transition: 'height 0.1s ease',
    } as React.CSSProperties,

    // ---- Tooltip (shown during drag) ----
    tooltip: {
      position: 'absolute',
      bottom: 16,
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
      color: t.accent,
      fontWeight: 600,
    },

    // ---- Range date labels (static, when not dragging) ----
    rangeLabel: {
      position: 'absolute',
      bottom: -1,
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
    } as React.CSSProperties,

    // ---- Reset ----
    resetBtn: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      color: t.textMuted,
      fontSize: 13,
      cursor: 'pointer',
      flexShrink: 0,
      lineHeight: 1,
    },
  };
}
