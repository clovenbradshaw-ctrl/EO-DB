import { useMemo, useCallback } from 'react';
import type { EoState } from '../db/types';
import { useTheme, type Theme } from '../theme';
import {
  type DateColumnOption,
  type TimeScrubberFilter,
  DEFAULT_FILTER,
  computeDateRange,
  formatDateLabel,
} from './time-scrubber-utils';
import { hasFieldsSubObject } from './filter-types';

interface TimeScrubberProps {
  records: EoState[];
  dateColumns: DateColumnOption[];
  filter: TimeScrubberFilter;
  onFilterChange: (filter: TimeScrubberFilter) => void;
}

export function TimeScrubber({ records, dateColumns, filter, onFilterChange }: TimeScrubberProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);

  const range = useMemo(
    () => computeDateRange(records, filter.dateField, useFieldsSub),
    [records, filter.dateField, useFieldsSub],
  );

  // Slider values: use data range, or fall back to a 1-year window around now
  const sliderMin = range?.min ?? Date.now() - 365 * 86400000;
  const sliderMax = range?.max ?? Date.now();
  // Add a small buffer so handles can reach the true edges
  const buffer = Math.max((sliderMax - sliderMin) * 0.005, 60000);
  const trackMin = sliderMin - buffer;
  const trackMax = sliderMax + buffer;

  const currentMin = filter.rangeMin ?? trackMin;
  const currentMax = filter.rangeMax ?? trackMax;

  const isActive =
    filter.rangeMin != null ||
    filter.rangeMax != null ||
    filter.emptyHandling !== 'show';

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

  const handleMinChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      onFilterChange({
        ...filter,
        rangeMin: v <= trackMin + buffer ? null : v,
        rangeMax: filter.rangeMax != null ? Math.max(filter.rangeMax, v) : null,
      });
    },
    [filter, onFilterChange, trackMin, buffer],
  );

  const handleMaxChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      onFilterChange({
        ...filter,
        rangeMax: v >= trackMax - buffer ? null : v,
        rangeMin: filter.rangeMin != null ? Math.min(filter.rangeMin, v) : null,
      });
    },
    [filter, onFilterChange, trackMax, buffer],
  );

  const handleReset = useCallback(() => {
    onFilterChange({ ...DEFAULT_FILTER, dateField: filter.dateField });
  }, [filter.dateField, onFilterChange]);

  // Compute the filled portion percentages for the track highlight
  const pctMin = ((currentMin - trackMin) / (trackMax - trackMin)) * 100;
  const pctMax = ((currentMax - trackMin) / (trackMax - trackMin)) * 100;

  const trackBackground = `linear-gradient(to right,
    ${theme.bgMuted} 0%,
    ${theme.bgMuted} ${pctMin}%,
    ${theme.accent} ${pctMin}%,
    ${theme.accent} ${pctMax}%,
    ${theme.bgMuted} ${pctMax}%,
    ${theme.bgMuted} 100%)`;

  return (
    <div className="eo-time-scrubber" style={{ ...s.bar, '--eo-accent': theme.accent } as React.CSSProperties}>
      {/* Date field selector */}
      <select
        value={filter.dateField}
        onChange={handleDateFieldChange}
        style={s.select}
      >
        {dateColumns.map((col) => (
          <option key={col.key} value={col.key}>
            {col.label}
          </option>
        ))}
      </select>

      {/* Empty handling */}
      <select
        value={filter.emptyHandling}
        onChange={handleEmptyChange}
        style={s.select}
      >
        <option value="show">If empty: show</option>
        <option value="hide">If empty: hide</option>
        <option value="end">If empty: end</option>
      </select>

      {/* Date label — min */}
      <span style={s.dateLabel}>
        {range ? formatDateLabel(filter.rangeMin ?? sliderMin) : '\u2014'}
      </span>

      {/* Dual-handle range slider */}
      <div style={s.sliderWrap}>
        <div
          style={{
            ...s.sliderTrack,
            background: range ? trackBackground : theme.bgMuted,
          }}
        />
        <input
          type="range"
          min={trackMin}
          max={trackMax}
          step={60000}
          value={currentMin}
          onChange={handleMinChange}
          style={s.sliderInput}
          disabled={!range}
        />
        <input
          type="range"
          min={trackMin}
          max={trackMax}
          step={60000}
          value={currentMax}
          onChange={handleMaxChange}
          style={s.sliderInput}
          disabled={!range}
        />
      </div>

      {/* Date label — max */}
      <span style={s.dateLabel}>
        {range ? formatDateLabel(filter.rangeMax ?? sliderMax) : '\u2014'}
      </span>

      {/* Reset */}
      {isActive && (
        <button onClick={handleReset} style={s.resetBtn} title="Reset scrubber">
          \u00d7
        </button>
      )}
    </div>
  );
}

// --- Styles ---

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  const thumbSize = 14;

  // Shared thumb/track styles need to be injected via a <style> tag or inline.
  // We use inline styles + CSS variables approach with the slider inputs.
  const sliderInput: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    margin: 0,
    padding: 0,
    background: 'transparent',
    WebkitAppearance: 'none',
    appearance: 'none' as any,
    pointerEvents: 'none',
    zIndex: 2,
    cursor: 'pointer',
  };

  return {
    bar: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 20px',
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      minHeight: 36,
    },
    select: {
      height: 24,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
      padding: '0 6px',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
      cursor: 'pointer',
      flexShrink: 0,
    },
    dateLabel: {
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textSecondary,
      whiteSpace: 'nowrap',
      flexShrink: 0,
      minWidth: 80,
      textAlign: 'center',
    } as React.CSSProperties,
    sliderWrap: {
      position: 'relative',
      flex: 1,
      height: 20,
      minWidth: 120,
    } as React.CSSProperties,
    sliderTrack: {
      position: 'absolute',
      top: '50%',
      left: 0,
      right: 0,
      height: 4,
      borderRadius: 2,
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
      zIndex: 1,
    } as React.CSSProperties,
    sliderInput,
    resetBtn: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 20,
      height: 20,
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      color: t.textMuted,
      fontSize: 14,
      cursor: 'pointer',
      flexShrink: 0,
      lineHeight: 1,
    },
  };
}

/**
 * Global CSS for the dual-handle range slider thumbs.
 * Injected once via a <style> element so we can style ::-webkit-slider-thumb
 * and ::-moz-range-thumb (not possible with inline styles).
 */
const SLIDER_STYLE_ID = 'eo-time-scrubber-styles';

if (typeof document !== 'undefined' && !document.getElementById(SLIDER_STYLE_ID)) {
  const style = document.createElement('style');
  style.id = SLIDER_STYLE_ID;
  style.textContent = `
    .eo-time-scrubber input[type="range"]::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--eo-accent, #2563eb);
      border: 2px solid #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      cursor: pointer;
      pointer-events: all;
      position: relative;
      z-index: 3;
    }
    .eo-time-scrubber input[type="range"]::-moz-range-thumb {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--eo-accent, #2563eb);
      border: 2px solid #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      cursor: pointer;
      pointer-events: all;
      position: relative;
      z-index: 3;
    }
    .eo-time-scrubber input[type="range"]::-webkit-slider-runnable-track {
      background: transparent;
      height: 4px;
    }
    .eo-time-scrubber input[type="range"]::-moz-range-track {
      background: transparent;
      height: 4px;
    }
    .eo-time-scrubber input[type="range"]:disabled::-webkit-slider-thumb {
      background: #aaa;
      cursor: default;
    }
    .eo-time-scrubber input[type="range"]:disabled::-moz-range-thumb {
      background: #aaa;
      cursor: default;
    }
  `;
  document.head.appendChild(style);
}
