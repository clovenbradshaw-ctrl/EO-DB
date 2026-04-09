/**
 * BranchBar — version/branch tab strip for a record or table view.
 *
 * Maps EO branch concepts to user-facing language:
 *   branch  → "version"
 *   fork    → "start review / start draft"
 *   SYN     → "promote to official"
 *   conflict → "dispute"
 *
 * Per-table, role-scoped: each branch has an optional `scope` (table prefix)
 * and `role` ('attorney', 'reviewer', 'caseworker'). The bar shows all branches
 * whose scope matches the current table view, plus the official filed record (main).
 */

import { useState } from 'react';

export interface BranchDescriptor {
  id: string;
  label: string;
  role?: string;
  isOfficial?: boolean;
  color?: string;
  icon?: string;
}

export interface BranchBarProps {
  /** All branches scoped to the current table (including main as 'official'). */
  branches: BranchDescriptor[];
  /** Currently selected branch. */
  activeBranchId: string;
  /** Branch being compared against (null = no diff mode). */
  compareBranchId: string | null;
  /** Whether the change-diff highlight is toggled on. */
  showDiff: boolean;
  onSelectBranch: (branchId: string) => void;
  onCompare: (branchId: string | null) => void;
  onToggleDiff: () => void;
  /** Start a new draft (sandbox) on the current branch. */
  onStartDraft?: () => void;
  /** Fork a new named version from the current branch. */
  onCreateVersion?: () => void;
}

/**
 * Stub — prop interface established, wiring to EO-DB API deferred.
 * Real implementation will call fork() on the server and refresh the branch list.
 */
export function BranchBar({
  branches,
  activeBranchId,
  compareBranchId,
  showDiff,
  onSelectBranch,
  onCompare,
  onToggleDiff,
  onStartDraft,
  onCreateVersion,
}: BranchBarProps) {
  const [showCompare, setShowCompare] = useState(false);
  const active = branches.find(b => b.id === activeBranchId);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Tab strip */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #e8e5de' }}>
        {branches.map(branch => (
          <button
            key={branch.id}
            onClick={() => { onSelectBranch(branch.id); setShowCompare(false); }}
            style={{
              padding: '7px 14px',
              background: activeBranchId === branch.id ? '#fff' : 'transparent',
              border: 'none',
              borderBottom: activeBranchId === branch.id ? `2.5px solid ${branch.color ?? '#2d5be3'}` : '2.5px solid transparent',
              color: activeBranchId === branch.id ? (branch.color ?? '#2d5be3') : '#5a5d6e',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: activeBranchId === branch.id ? 600 : 400,
            }}
          >
            {branch.icon && <span style={{ marginRight: 6 }}>{branch.icon}</span>}
            {branch.label}
            {branch.isOfficial && (
              <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 5px', background: '#dde6ff', color: '#2d5be3', borderRadius: 3, fontWeight: 700 }}>
                OFFICIAL
              </span>
            )}
            {branch.role && (
              <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 5px', background: '#f0ede8', color: '#9a9dae', borderRadius: 3 }}>
                {branch.role}
              </span>
            )}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        <button onClick={onToggleDiff} style={{ fontSize: 12, padding: '6px 14px', background: 'transparent', border: 'none', color: showDiff ? '#9a6c00' : '#9a9dae', cursor: 'pointer' }}>
          {showDiff ? 'Showing changes' : 'Show changes'}
        </button>
      </div>

      {/* Compare bar */}
      {active && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', background: '#f0ede6', borderBottom: '1px solid #e8e5de' }}>
          <span style={{ fontSize: 12, color: '#5a5d6e' }}>Compare with:</span>
          {branches.filter(b => b.id !== activeBranchId).map(b => (
            <button
              key={b.id}
              onClick={() => onCompare(compareBranchId === b.id ? null : b.id)}
              style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12,
                background: compareBranchId === b.id ? (b.color ?? '#2d5be3') + '18' : 'transparent',
                border: `1px solid ${compareBranchId === b.id ? (b.color ?? '#2d5be3') + '66' : '#e8e5de'}`,
                color: compareBranchId === b.id ? (b.color ?? '#2d5be3') : '#5a5d6e',
                cursor: 'pointer',
              }}
            >
              {b.icon} {b.label}
            </button>
          ))}
          {onStartDraft && (
            <button onClick={onStartDraft} style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 7, fontSize: 12, background: '#fef3d4', border: '1px solid #9a6c0044', color: '#9a6c00', cursor: 'pointer', fontWeight: 500 }}>
              ✏️ Start draft
            </button>
          )}
          {onCreateVersion && (
            <button onClick={onCreateVersion} style={{ padding: '6px 14px', borderRadius: 7, fontSize: 12, background: '#dde6ff', border: '1px solid #2d5be344', color: '#2d5be3', cursor: 'pointer', fontWeight: 500 }}>
              Create version
            </button>
          )}
        </div>
      )}
    </div>
  );
}
