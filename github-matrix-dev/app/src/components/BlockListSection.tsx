/**
 * Uploaded-block list with per-block enable/disable toggle.
 *
 * Walks the room's m.eo.block chain (newest first) and renders each
 * uploaded `.eodb`. The toggle sends an `m.eo.block.disabled` state
 * event keyed by the block's room-event id — visible to every member
 * of the space, gated by the state-event power level. Disabled blocks
 * stay on the chain (so prior_block_event_id pointers remain intact)
 * but are skipped by hydrateFromBlocks; new clients never fold their
 * events, and the "re-hydrate" button below the list rebuilds local
 * state to reflect the change on the current device.
 */

import { useEffect, useState, useCallback } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme } from '../theme';
import { useEoStore } from '../store/eo-store';
import {
  listBlockChain,
  setBlockDisabled,
  hydrateBlocksIfStale,
  isAutoIngestEnabled,
  setAutoIngestEnabled,
  type BlockListEntry,
} from '../sync/block-hydration';
import { loadSpaceKeyring } from '../crypto/keyring-store';

interface BlockListSectionProps {
  matrixClient: MatrixClient | null | undefined;
  roomId: string | null | undefined;
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function BlockListSection({ matrixClient, roomId }: BlockListSectionProps) {
  const { theme } = useTheme();
  const store = useEoStore((s) => s.store);
  const batchImport = useEoStore((s) => s.batchImport);
  const [blocks, setBlocks] = useState<BlockListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [reapplyBusy, setReapplyBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read the current auto-ingest preference. Default true — new blocks
  // from other clients fold automatically as they're sealed.
  const [autoIngest, setAutoIngestState] = useState<boolean>(
    () => (roomId ? isAutoIngestEnabled(roomId) : true),
  );

  useEffect(() => {
    if (roomId) setAutoIngestState(isAutoIngestEnabled(roomId));
  }, [roomId]);

  function toggleAutoIngest() {
    if (!roomId) return;
    const next = !autoIngest;
    setAutoIngestEnabled(roomId, next);
    setAutoIngestState(next);
  }

  const refresh = useCallback(async () => {
    if (!matrixClient || !roomId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await listBlockChain(matrixClient, roomId);
      setBlocks(list);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [matrixClient, roomId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function toggle(entry: BlockListEntry) {
    if (!matrixClient || !roomId) return;
    setBusyEventId(entry.eventId);
    setError(null);
    try {
      await setBlockDisabled(matrixClient, roomId, entry.eventId, !entry.disabled);
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusyEventId(null);
    }
  }

  async function reapplyChain() {
    if (!matrixClient || !roomId || !store) return;
    setReapplyBusy(true);
    setError(null);
    try {
      // Force-walk the chain back to genesis so the disabled-set filter
      // applies to every block. The fold engine dedups by client_event_id,
      // so re-folding the still-enabled blocks is a no-op for events
      // already in local state. Enabling a previously-disabled block
      // pulls in the missing events.
      //
      // Caveat: this re-fold does NOT remove events from local state
      // that came from a now-disabled block. To fully wipe an
      // already-folded disabled block's contributions, the user must
      // wipe local data for this space (Settings → Switch & wipe cache).
      const mirrorToken = matrixClient.getAccessToken?.();
      await hydrateBlocksIfStale(matrixClient, roomId, store, {
        bulkApply: (events) => batchImport(events),
        force: true,
        mirror: mirrorToken
          ? {
              matrixToken: mirrorToken,
              spaceRoomId: roomId,
              loadKeyring: () => loadSpaceKeyring(roomId),
            }
          : null,
      });
      // Persist the kv-snapshot + init-cache so the next refresh restores
      // from the snapshot directly instead of re-folding the OPFS log.
      try {
        await useEoStore.getState().flushToOpfs();
      } catch (e) {
        console.warn('[EO-DB] post-reapply flushToOpfs failed:', e);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setReapplyBusy(false);
    }
  }

  const disabled = !matrixClient || !roomId;
  const rowStyle = (entry: BlockListEntry): React.CSSProperties => ({
    display: 'grid',
    gridTemplateColumns: 'auto 1fr auto auto',
    gap: 12,
    alignItems: 'center',
    padding: '6px 10px',
    background: entry.disabled ? theme.bgMuted ?? theme.bgCard : theme.bgCard,
    border: `1px solid ${theme.border}`,
    borderRadius: 4,
    opacity: entry.disabled ? 0.65 : 1,
    fontSize: 11,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: theme.textSecondary }}>
        Every <code style={{ fontSize: 11 }}>.eodb</code> uploaded to this space
        appears here. Disabling a block stops new clients from folding its
        events; the file stays on the homeserver (encrypted) and can be re-enabled
        at any time. The chain itself is never broken.
      </div>

      {/* Auto-ingest toggle — when enabled, blocks uploaded by any client
          fold into local state automatically on the next /sync tick. When
          disabled, new blocks are listed but not folded until the user
          explicitly clicks "Re-apply chain locally" below. */}
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 11,
        color: theme.text,
        cursor: roomId ? 'pointer' : 'not-allowed',
        opacity: roomId ? 1 : 0.6,
      }}>
        <input
          type="checkbox"
          checked={autoIngest}
          disabled={!roomId}
          onChange={toggleAutoIngest}
        />
        <span>
          Auto-ingest new blocks
          <span style={{ color: theme.textMuted, marginLeft: 8 }}>
            (fold blocks uploaded by other clients as soon as they land)
          </span>
        </span>
      </label>

      {disabled && (
        <span style={{ fontSize: 11, color: theme.textMuted }}>
          Waiting for room to connect…
        </span>
      )}

      {loading && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>Loading chain…</div>
      )}

      {!loading && blocks.length === 0 && !disabled && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          No blocks uploaded yet. Use the “Seed this Space” section above to
          upload an <code>.eodb</code>.
        </div>
      )}

      {blocks.map((entry) => (
        <div key={entry.eventId} style={rowStyle(entry)}>
          <span style={{ fontFamily: 'monospace', color: theme.textSecondary }}>
            #{entry.blockIndex}
          </span>
          <span>
            <code style={{ fontSize: 10 }}>{entry.eventId.slice(0, 16)}…</code>
            <span style={{ color: theme.textMuted, marginLeft: 8 }}>
              {entry.eventCount.toLocaleString()} events · sealed {formatTimestamp(entry.sealedAt)}
            </span>
            {entry.disabled && entry.disabledReason ? (
              <span style={{ color: theme.dangerText, marginLeft: 8 }}>
                — disabled ({entry.disabledReason})
              </span>
            ) : null}
          </span>
          <span style={{
            padding: '2px 6px',
            borderRadius: 3,
            fontSize: 10,
            background: entry.disabled ? theme.dangerBg : theme.successBg,
            color: entry.disabled ? theme.dangerText : theme.successText,
            border: `1px solid ${entry.disabled ? theme.dangerBorder : theme.successBorder}`,
          }}>
            {entry.disabled ? 'disabled' : 'active'}
          </span>
          <button
            type="button"
            disabled={busyEventId !== null}
            onClick={() => toggle(entry)}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              border: `1px solid ${theme.border}`,
              background: theme.bg,
              color: theme.text,
              borderRadius: 3,
              cursor: 'pointer',
              opacity: busyEventId === entry.eventId ? 0.5 : 1,
            }}
          >
            {busyEventId === entry.eventId
              ? '…'
              : entry.disabled
                ? 'Enable'
                : 'Disable'}
          </button>
        </div>
      ))}

      {blocks.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' }}>
          <button
            type="button"
            disabled={reapplyBusy || disabled}
            onClick={reapplyChain}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              border: `1px solid ${theme.border}`,
              background: theme.bg,
              color: theme.text,
              borderRadius: 3,
              cursor: 'pointer',
              opacity: reapplyBusy ? 0.5 : 1,
            }}
          >
            {reapplyBusy ? 'Re-applying…' : 'Re-apply chain locally'}
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            style={{
              padding: '4px 10px',
              fontSize: 11,
              border: `1px solid ${theme.border}`,
              background: 'transparent',
              color: theme.text,
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Refresh list
          </button>
          <span style={{ fontSize: 10, color: theme.textMuted }}>
            Re-apply pulls newly-enabled blocks into local state. To fully
            unfold a just-disabled block from this device, wipe local data
            for this space.
          </span>
        </div>
      )}

      {error && (
        <div style={{
          padding: '6px 8px',
          fontSize: 11,
          background: theme.dangerBg,
          border: `1px solid ${theme.dangerBorder}`,
          color: theme.dangerText,
          borderRadius: 4,
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
