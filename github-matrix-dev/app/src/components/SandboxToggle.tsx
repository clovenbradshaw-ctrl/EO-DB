/**
 * SandboxToggle — draft mode banner and toggle.
 *
 * When active, shows a banner explaining the sandbox (draft) state and
 * provides actions to promote or discard the draft.
 *
 * Maps EO sandbox concepts to user-facing language:
 *   sandbox/SIG layer   → "draft"
 *   promoteSandbox()    → "Save as version"
 *   discardSandbox()    → "Discard draft"
 */

export interface SandboxToggleProps {
  /** Whether sandbox/draft mode is currently active. */
  active: boolean;
  /** Number of staged (unsaved) changes in the sandbox. */
  stagedCount: number;
  onActivate: () => void;
  onSaveAsVersion: () => void;
  onDiscard: () => void;
}

/**
 * Stub — prop interface established, sandbox promotion deferred.
 * Real implementation will call promoteSandbox() on the server and create
 * a real named branch via fork().
 */
export function SandboxToggle({
  active,
  stagedCount,
  onActivate,
  onSaveAsVersion,
  onDiscard,
}: SandboxToggleProps) {
  if (!active) {
    return (
      <button onClick={onActivate} style={{
        padding: '8px 16px', borderRadius: 7, fontSize: 13,
        background: '#fef3d4', border: '1px solid #9a6c0044',
        color: '#9a6c00', cursor: 'pointer', fontWeight: 500,
      }}>
        ✏️ Start draft
      </button>
    );
  }

  return (
    <div style={{
      background: '#fffbeb',
      borderBottom: '2px solid #9a6c00',
      padding: '10px 24px',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <span style={{ fontSize: 14 }}>✏️</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#9a6c00' }}>
          Draft mode — changes are not saved to the official record
        </div>
        <div style={{ fontSize: 12, color: '#5a5d6e' }}>
          {stagedCount > 0
            ? `${stagedCount} unsaved change${stagedCount > 1 ? 's' : ''}. Save as a named version or discard.`
            : 'No changes staged yet. Edit fields to add to the draft.'}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <button onClick={onDiscard} style={{
        padding: '6px 14px', borderRadius: 6, fontSize: 12,
        background: 'transparent', border: '1px solid #e8e5de',
        color: '#5a5d6e', cursor: 'pointer',
      }}>
        Discard draft
      </button>
      <button
        onClick={onSaveAsVersion}
        disabled={stagedCount === 0}
        style={{
          padding: '6px 14px', borderRadius: 6, fontSize: 12,
          background: stagedCount > 0 ? '#9a6c00' : '#ededf0',
          border: 'none',
          color: stagedCount > 0 ? '#fff' : '#9a9dae',
          cursor: stagedCount > 0 ? 'pointer' : 'not-allowed',
          fontWeight: 600,
        }}
      >
        Save as version →
      </button>
    </div>
  );
}
