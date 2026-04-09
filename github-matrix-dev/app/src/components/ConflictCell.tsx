/**
 * ConflictCell — inline conflict display for a field row in the record table.
 *
 * Shows two diverging values side-by-side with resolution action buttons.
 * Maps EO ConflictState to user-facing language: "disputed value".
 *
 * Resolution actions:
 *   Accept A's version  → SYN absorb with targetFilter = [target], policy = Dissecting
 *   Accept B's version  → same, other direction
 *   Keep both ↗         → leave ConflictState in place (Binding default)
 */

export interface ConflictEntry {
  value: unknown;
  branchId: string;
  branchLabel: string;
  branchColor: string;
  seq: number | null;
  agent: string | null;
}

export interface ConflictCellProps {
  target: string;
  entries: [ConflictEntry, ConflictEntry];
  /** Called when user picks a side. Null = keep both (Binding). */
  onResolve: (winner: ConflictEntry | null) => void;
}

/**
 * Stub — prop interface established, resolution wiring deferred.
 * Real implementation will POST a SYN absorb with targetFilter to the server API.
 */
export function ConflictCell({ target: _target, entries, onResolve }: ConflictCellProps) {
  const [a, b] = entries;

  return (
    <div style={{
      padding: '8px 12px',
      background: '#fff',
      border: '1px solid #c42b2b33',
      borderRadius: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: '#c42b2b', fontWeight: 600 }}>
          ⚠ Disputed value
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16 }}>
        {([a, b] as ConflictEntry[]).map((entry, i) => (
          <div key={i} style={{ flex: 1 }}>
            <div style={{ fontSize: 10, color: '#9a9dae', marginBottom: 3, fontFamily: 'monospace' }}>
              {entry.branchLabel}
            </div>
            <div style={{ fontSize: 13, color: '#1a1c24' }}>
              {entry.value == null ? <em style={{ color: '#9a9dae' }}>—</em> : String(entry.value)}
            </div>
            {entry.agent && (
              <div style={{ fontSize: 10, color: '#9a9dae', marginTop: 2 }}>
                {entry.agent} · seq {entry.seq}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 6, paddingTop: 4, borderTop: '1px solid #e8e5de' }}>
        <span style={{ fontSize: 11, color: '#5a5d6e', alignSelf: 'center' }}>Accept:</span>
        {([a, b] as ConflictEntry[]).map((entry, i) => (
          <button key={i} onClick={() => onResolve(entry)} style={{
            padding: '4px 10px', borderRadius: 5, fontSize: 11,
            background: entry.branchColor + '15',
            border: `1px solid ${entry.branchColor}44`,
            color: entry.branchColor,
            cursor: 'pointer',
            fontWeight: 500,
          }}>
            {entry.branchLabel}'s version
          </button>
        ))}
        <button onClick={() => onResolve(null)} style={{
          padding: '4px 10px', borderRadius: 5, fontSize: 11,
          background: '#ededf0',
          border: '1px solid #e8e5de',
          color: '#5a5d6e',
          cursor: 'pointer',
        }}>
          Keep both ↗
        </button>
      </div>
    </div>
  );
}
