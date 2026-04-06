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

  // Single node position — defaults to the end of the range
  const currentPos = filter.rangeMax ?? trackMax;

  // Adaptive date formatter based on actual data span
  const formatDate = useMemo(
    () => buildAdaptiveFormatter(trackRange),
    [trackRange],
  );

  const isActive = filter.rangeMax != null;

  // ---- Refs ----
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);

  // ---- Local visual state (smooth during drag) ----
  const [vizPos, setVizPos] = useState(currentPos);
  const [dragging, setDragging] = useState(false);
  const [precisionPct, setPrecisionPct] = useState<string | null>(null);

  // Sync visual state when filter changes externally
  useEffect(() => {
    if (!dragRef.current) {
      setVizPos(currentPos);
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
      // Store position in rangeMax; null out rangeMin (no clipping)
      const pos = clamped >= trackMax - buffer ? null : clamped;
      onFilterChange({ ...filter, rangeMin: null, rangeMax: pos });
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

      // Snap node to click position
      commitValue(value);
    },
    [range, trackMin, trackRange, commitValue],
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
      commitValue(drag.currentValue);
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

  const handleReset = useCallback(() => {
    onFilterChange({ ...DEFAULT_FILTER, dateField: filter.dateField });
  }, [filter.dateField, onFilterChange]);

  // ---- Computed visual position ----
  const pctPos = valueToFraction(vizPos) * 100;

  // ---- Current date field label ----
  const dateFieldLabel =
    dateColumns.find((c) => c.key === filter.dateField)?.label ?? filter.dateField;

  const s = styles(theme);

  return (
    <div className="eo-horizon" style={s.bar}>
      {/* Inline date field selector */}
      {dateColumns.length > 1 ? (
        <select
          value={filter.dateField}
          onChange={handleDateFieldChange}
          style={s.fieldSelect}
          title="Date field"
        >
          {dateColumns.map((col) => (
            <option key={col.key} value={col.key}>{col.label}</option>
          ))}
        </select>
      ) : (
        <span style={s.fieldLabel}>{dateFieldLabel}</span>
      )}

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
        <div style={{ ...s.trackBar, background: theme.bgMuted }} />

        {/* Single node */}
        {range && (
          <div
            style={{
              ...s.node,
              left: `${pctPos}%`,
              background: theme.accent,
            }}
          >
            {dragging && (
              <div style={s.tooltip}>
                {formatDate(vizPos)}
                {precisionPct && (
                  <span style={s.precisionBadge}>{precisionPct}</span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Date label at node position (shown when not dragging) */}
        {range && !dragging && (
          <span style={{ ...s.dateLabel, left: `${pctPos}%` }}>
            {formatDate(vizPos)}
          </span>
        )}
      </div>

      {/* Inline reset button */}
      {isActive && (
        <button onClick={handleReset} style={s.resetBtn} title="Reset position">
          ×
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

    // ---- Inline date field selector ----
    fieldSelect: {
      height: 20,
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '0 4px',
      border: `0.5px solid ${t.border}`,
      borderRadius: 3,
      background: 'transparent',
      color: t.textSecondary,
      outline: 'none',
      cursor: 'pointer',
      flexShrink: 0,
      maxWidth: 140,
    } as React.CSSProperties,

    fieldLabel: {
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      flexShrink: 0,
      whiteSpace: 'nowrap',
    } as React.CSSProperties,

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
      pointerEvents: 'none',
    } as React.CSSProperties,

    // ---- Single node ----
    node: {
      position: 'absolute',
      top: '50%',
      width: 8,
      height: 8,
      borderRadius: '50%',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      zIndex: 3,
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

    // ---- Date label at node position (when not dragging) ----
    dateLabel: {
      position: 'absolute',
      bottom: -1,
      fontSize: 9,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      transform: 'translateX(-50%)',
    } as React.CSSProperties,

    // ---- Inline reset button ----
    resetBtn: {
      height: 20,
      width: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      color: t.textMuted,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', monospace",
      cursor: 'pointer',
      flexShrink: 0,
      padding: 0,
    } as React.CSSProperties,
  };
}
