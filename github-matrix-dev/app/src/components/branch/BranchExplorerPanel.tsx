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
import { useBranchStore, listSynEvents } from '../../store/branch-store';
import { useTheme } from '../../theme';
import { BranchExplorer } from './BranchExplorer';
import type { EoEvent } from '../../db/types';

export function BranchExplorerPanel() {
  const { theme } = useTheme();
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);
  const branches = useBranchStore((s) => s.branches);
  const activeBranchSubject = useBranchStore((s) => s.activeBranchSubject);
  const loadBranchesForSubject = useBranchStore((s) => s.loadBranchesForSubject);
  const createBranchSet = useBranchStore((s) => s.createBranchSet);
  const setActiveBranchSubject = useBranchStore((s) => s.setActiveBranchSubject);

  const [synEvents, setSynEvents] = useState<EoEvent[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh SYN events when the log changes.
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
  }, [ready, lastSeq]);

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
                <div style={{ fontWeight: 500 }}>seq #{event.seq}</div>
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
            <div style={{ padding: 40, color: theme.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>
              {synEvents.length === 0
                ? 'Merge two records via a SYN event from the compose view to enable branching.'
                : 'Select a SYN event from the sidebar to open its branch set.'}
            </div>
          ) : (
            <BranchExplorer branches={visibleBranches} />
          )}
        </section>
      </div>
    </div>
  );
}
