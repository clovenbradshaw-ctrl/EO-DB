/**
 * RecordTimeline — per-record time-travel slider.
 *
 * Shows a compact "time travel" toggle in the Fields section. When activated,
 * an event-dot slider lets the user scrub through the record's DEF history.
 * Calls onTimestampChange so FigureFields can reconstruct historical values.
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import type { EoEvent } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { readLogForTarget } from '../db/log';
import { useTheme, type Theme } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecordTimelineProps {
  target: string;
  onTimestampChange: (ts: number | null) => void;
  onEventsLoaded: (events: EoEvent[]) => void;
}

interface EventMarker {
  ts: number;
  agent: string;
  fields: string[];
  note: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAgentShort(agent: string): string {
  if (agent === 'system' || agent === 'system:eva') return 'system';
  const m = agent.match(/^@?([^:@]+)/);
  return m ? m[1] : agent;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Exported reconstruction helper
// ---------------------------------------------------------------------------

/**
 * Reconstruct field values at a point in time by walking DEF events backward.
 * Events that occurred AFTER `ts` are reverted using their `_prev` snapshot.
 */
export function reconstructAt(
  currentValue: Record<string, unknown>,
  events: EoEvent[],
  ts: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...currentValue };
  // Sort DEF events newest-first
  const defEvents = events
    .filter((e) => e.op === 'DEF')
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  for (const evt of defEvents) {
    if (new Date(evt.ts).getTime() > ts) {
      // This change happened after our target time — revert it
      const prev = (evt.operand as Record<string, unknown>)?._prev as Record<string, unknown> | undefined;
      if (prev) {
        for (const k of Object.keys(prev)) {
          result[k] = prev[k];
        }
        // Fields added by this DEF that have no _prev entry were new — mark as absent
        const newFields = Object.keys(evt.operand as object).filter(
          (k) => !k.startsWith('_') && !(prev as object).hasOwnProperty(k),
        );
        for (const k of newFields) {
          result[k] = undefined;
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecordTimeline({ target, onTimestampChange, onEventsLoaded }: RecordTimelineProps) {
  const store = useEoStore((s) => s.store);
  const { theme } = useTheme();

  const [events, setEvents] = useState<EoEvent[]>([]);
  const [active, setActive] = useState(false);
  const [recordTs, setRecordTs] = useState<number>(0);

  // Load events for this target
  useEffect(() => {
    if (!store) return;
    readLogForTarget(store, target).then((evts) => {
      // Sort oldest → newest for timeline
      const sorted = [...evts].sort(
        (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
      );
      setEvents(sorted);
      onEventsLoaded(sorted);
    });
  }, [store, target, onEventsLoaded]);

  // Build markers from DEF events
  const markers: EventMarker[] = useMemo(() => {
    return events
      .filter((e) => e.op === 'DEF' || e.op === 'INS')
      .map((e) => ({
        ts: new Date(e.ts).getTime(),
        agent: getAgentShort(e.agent),
        fields: Object.keys(e.operand ?? {}).filter((k) => !k.startsWith('_')),
        note: (e.meta as any)?.note || (e.meta as any)?.reason || null,
      }))
      .filter((m) => m.ts > 0);
  }, [events]);

  const minTs = markers.length > 0 ? markers[0].ts : 0;
  const maxTs = markers.length > 0 ? markers[markers.length - 1].ts : 0;

  // Initialise slider to present on first load
  useEffect(() => {
    if (maxTs > 0 && recordTs === 0) {
      setRecordTs(maxTs);
    }
  }, [maxTs, recordTs]);

  const isPresent = recordTs >= maxTs;

  // Nearest marker at or before recordTs
  const nearestMarker = useMemo<EventMarker | null>(() => {
    let best: EventMarker | null = null;
    for (const m of markers) {
      if (m.ts <= recordTs) best = m;
    }
    return best;
  }, [markers, recordTs]);

  const handleToggle = useCallback(() => {
    if (active) {
      // Exit time travel
      setActive(false);
      setRecordTs(maxTs);
      onTimestampChange(null);
    } else {
      setActive(true);
      onTimestampChange(maxTs);
    }
  }, [active, maxTs, onTimestampChange]);

  const handleSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = Number(e.target.value);
      setRecordTs(v);
      onTimestampChange(isPresent ? null : v);
    },
    [isPresent, onTimestampChange],
  );

  const s = styles(theme);

  // Need at least one event to show anything
  if (markers.length === 0) return null;

  return (
    <div style={s.wrap}>
      {/* Header row */}
      <div style={s.header}>
        <div style={s.headerLeft}>
          <div style={{ ...s.dot, background: active ? theme.accent : theme.border }} />
          <span style={{ ...s.label, color: active ? theme.textSecondary : theme.textMuted }}>
            Record Timeline
          </span>
          {!active && <span style={s.hint}>— scrub through history</span>}
        </div>
        <button style={{ ...s.toggleBtn, ...(active ? s.toggleBtnActive : {}) }} onClick={handleToggle}>
          {active ? 'exit' : 'time travel'}
        </button>
      </div>

      {/* Expanded panel */}
      {active && (
        <div style={s.body}>
          {/* Date + past badge — own readable row */}
          <div style={s.dateLine}>
            <span style={s.dateText}>{formatTs(recordTs)}</span>
            {!isPresent && <span style={s.pastBadge}>past</span>}
          </div>

          {/* Slider with event dots */}
          <div style={s.trackWrap}>
            <div style={s.dotLayer}>
              {markers.map((m, i) => {
                const pct = maxTs > minTs ? ((m.ts - minTs) / (maxTs - minTs)) * 100 : 50;
                const isNearest = nearestMarker?.ts === m.ts;
                return (
                  <div key={i} style={{
                    position: 'absolute',
                    left: `${pct}%`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: isNearest ? 7 : 3,
                    height: isNearest ? 7 : 3,
                    borderRadius: '50%',
                    background: isNearest ? theme.accent : m.ts <= recordTs ? theme.textMuted : theme.border,
                    transition: 'all 0.1s',
                    zIndex: 2,
                    pointerEvents: 'none',
                  }} />
                );
              })}
            </div>
            <input
              type="range"
              min={minTs}
              max={maxTs}
              value={recordTs}
              step={1}
              onChange={handleSlider}
              style={s.rangeInput}
            />
          </div>

          {/* Provenance — single compact line */}
          {nearestMarker && (
            <div style={s.provenance}>
              <span style={s.provenanceAgent}>{nearestMarker.agent}</span>
              {nearestMarker.fields.length > 0 && (
                <span style={s.provenanceMeta}>{' · '}{nearestMarker.fields.join(', ')}</span>
              )}
              {nearestMarker.note && (
                <span style={{ ...s.provenanceMeta, fontStyle: 'italic' as const }}>
                  {' · \u201c'}{nearestMarker.note}{'\u201d'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(t: Theme): Record<string, React.CSSProperties> {
  return {
    wrap: {
      borderBottom: `1px solid ${t.border}`,
      marginBottom: 2,
    },
    header: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '5px 0 4px',
    },
    headerLeft: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      minWidth: 0,
    },
    dot: {
      width: 5,
      height: 5,
      borderRadius: '50%',
      flexShrink: 0,
      transition: 'background 0.2s',
    },
    label: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      letterSpacing: '0.07em',
      textTransform: 'uppercase' as const,
      transition: 'color 0.2s',
    },
    hint: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      opacity: 0.5,
    },
    toggleBtn: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      letterSpacing: '0.05em',
      background: 'transparent',
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      padding: '2px 8px',
      cursor: 'pointer',
      flexShrink: 0,
      transition: 'all 0.15s',
    },
    toggleBtnActive: {
      color: t.textSecondary,
      borderColor: t.textMuted,
    },
    body: {
      paddingBottom: 10,
    },
    // Compact inline row: date + badge + slider
    sliderRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 5,
    },
    dateLine: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      marginBottom: 6,
    },
    dateText: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fontWeight: 500,
      color: t.text,
    },
    trackWrap: {
      position: 'relative' as const,
      marginBottom: 4,
      height: 20,
    },
    dotLayer: {
      position: 'absolute' as const,
      top: 0,
      left: 0,
      right: 0,
      height: '100%',
      pointerEvents: 'none' as const,
    },
    rangeInput: {
      width: '100%',
      position: 'relative' as const,
      zIndex: 3,
      cursor: 'pointer',
      accentColor: t.accent,
      height: 2,
      margin: '7px 0',
    },
    // Single-line provenance below slider
    provenance: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: t.textMuted,
      marginTop: 2,
      lineHeight: 1.4,
    },
    provenanceAgent: {
      color: t.textSecondary,
    },
    provenanceMeta: {
      color: t.textMuted,
    },
    pastBadge: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 9,
      color: t.textMuted,
      border: `1px solid ${t.border}`,
      padding: '1px 5px',
      borderRadius: 3,
      flexShrink: 0,
    },
  };
}
