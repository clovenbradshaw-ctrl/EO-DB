/**
 * Seed-upload UI.
 *
 * Pick a file → upload as encrypted media → post the m.eo.block event.
 * That's it. No client-side parsing, no preview, no per-event progress —
 * once the upload completes, the rest of the system handles fold via
 * normal block-chain hydration.
 */

import { useRef, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme } from '../theme';
import { useEoStore } from '../store/eo-store';
import { uploadSeedFile } from '../sync/seed-uploader';
import { readBlockEvents } from '../sync/block-hydration';
import { loadSpaceKeyring } from '../crypto/keyring-store';

interface SeedSpaceSectionProps {
  matrixClient: MatrixClient | null | undefined;
  roomId: string | null | undefined;
  collectionId: string | null | undefined;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'uploading'; fileName: string; byteCount: number }
  | { kind: 'done'; fileName: string; byteCount: number; blockEventId: string }
  | { kind: 'error'; fileName: string; message: string };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SeedSpaceSection({
  matrixClient,
  roomId,
  collectionId,
}: SeedSpaceSectionProps) {
  const { theme } = useTheme();
  const store = useEoStore((s) => s.store);
  const batchImport = useEoStore((s) => s.batchImport);
  const flushToOpfs = useEoStore((s) => s.flushToOpfs);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const disabled = !matrixClient || !roomId || !collectionId || !store;

  async function handleFile(file: File) {
    if (!matrixClient || !roomId) return;
    setStatus({ kind: 'uploading', fileName: file.name, byteCount: file.size });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());

      // Parse once: we need the event list for local fold below, and we
      // pass `events.length` to uploadSeedFile so the m.eo.block message
      // carries an accurate event_count (used by the Uploaded Blocks UI).
      // This is the only client-side parse on the upload path.
      const events = await readBlockEvents(bytes);

      const mirrorToken = matrixClient.getAccessToken?.();
      const result = await uploadSeedFile(
        matrixClient,
        roomId,
        bytes,
        events.length,
        mirrorToken
          ? {
              matrixToken: mirrorToken,
              spaceRoomId: roomId,
              loadKeyring: () => loadSpaceKeyring(roomId),
            }
          : null,
      );

      // Fold the events we just parsed directly into local state.
      // The alternative — calling hydrateBlocksIfStale — races against
      // the Matrix SDK echoing the m.eo.head state event back via /sync.
      // If hydrate runs before the echo lands, readHeadState returns an
      // empty head and the new block is silently skipped. Folding from
      // the in-memory event list avoids that round-trip entirely.
      // Persist the hydrated-head marker so the next refresh's
      // hydrateBlocksIfStale knows this block has been folded and
      // doesn't re-walk the chain.
      if (store && events.length > 0) {
        try {
          await batchImport(events);
          try {
            localStorage.setItem(
              `eo-db-hydrated-head:${roomId}`,
              result.blockEventId,
            );
          } catch {
            // localStorage write failures are non-fatal — worst case we
            // re-fold on the next refresh (dedup by client_event_id).
          }
          await flushToOpfs();
        } catch (e) {
          console.warn('[EO-DB] post-upload local fold failed:', e);
        }
      }

      setStatus({
        kind: 'done',
        fileName: file.name,
        byteCount: bytes.byteLength,
        blockEventId: result.blockEventId,
      });
    } catch (e: any) {
      setStatus({ kind: 'error', fileName: file.name, message: e?.message ?? String(e) });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: theme.textSecondary }}>
        Upload an <code style={{ fontSize: 11 }}>.eodb</code> bundle to seed
        this space. The file is uploaded as encrypted media; every client
        in the room folds it through the normal block-chain hydration path
        on the next sync tick.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".eodb,application/octet-stream"
          style={{ display: 'none' }}
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <button
          type="button"
          disabled={disabled || status.kind === 'uploading'}
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            border: `1px solid ${theme.border}`,
            background: theme.bg,
            color: theme.text,
            borderRadius: 4,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          Choose seed file…
        </button>
        {disabled && (
          <span style={{ fontSize: 11, color: theme.textMuted }}>
            Waiting for space to finish connecting…
          </span>
        )}
      </div>

      {status.kind === 'uploading' && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          Uploading <code>{status.fileName}</code> ({formatBytes(status.byteCount)})…
        </div>
      )}

      {status.kind === 'done' && (
        <div style={{
          padding: '8px 10px',
          background: theme.successBg,
          border: `1px solid ${theme.successBorder}`,
          color: theme.successText,
          borderRadius: 4,
          fontSize: 11,
        }}>
          Uploaded <strong>{status.fileName}</strong> ({formatBytes(status.byteCount)}).
          Block <code>{status.blockEventId.slice(0, 12)}…</code> sealed.
        </div>
      )}

      {status.kind === 'error' && (
        <div style={{
          padding: '8px 10px',
          background: theme.dangerBg,
          border: `1px solid ${theme.dangerBorder}`,
          color: theme.dangerText,
          borderRadius: 4,
          fontSize: 11,
        }}>
          Failed to upload <code>{status.fileName}</code>: {status.message}
        </div>
      )}
    </div>
  );
}
