/**
 * "This is the file to get started" — seed-upload UI.
 *
 * Lets the space owner pick a `.eodb` or NDJSON bundle and apply it to
 * the current space. Diffs every event by `client_event_id` so uploading
 * the same file twice is a no-op. Brand-new spaces with an `.eodb` seed
 * take a hot-start path that posts the file directly as the genesis
 * block (one upload, one state event, fully hydrated chain).
 */

import { useRef, useState } from 'react';
import type { MatrixClient } from 'matrix-js-sdk';
import { useTheme } from '../theme';
import { useEoStore } from '../store/eo-store';
import { parseSeedFile, seedSpaceFromFile, type ParsedSeed } from '../sync/seed-uploader';

interface SeedSpaceSectionProps {
  matrixClient: MatrixClient | null | undefined;
  roomId: string | null | undefined;
  collectionId: string | null | undefined;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'reading'; fileName: string }
  | { kind: 'preview'; fileName: string; seed: ParsedSeed }
  | { kind: 'applying'; fileName: string; current: number; total: number }
  | { kind: 'done'; fileName: string; total: number; added: number; skipped: number; genesis?: boolean }
  | { kind: 'error'; fileName: string; message: string };

export function SeedSpaceSection({
  matrixClient,
  roomId,
  collectionId,
}: SeedSpaceSectionProps) {
  const { theme } = useTheme();
  const store = useEoStore((s) => s.store);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const disabled = !matrixClient || !roomId || !collectionId || !store;

  async function handleFile(file: File) {
    setStatus({ kind: 'reading', fileName: file.name });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const seed = await parseSeedFile(bytes, file.name);
      setStatus({ kind: 'preview', fileName: file.name, seed });
    } catch (e: any) {
      setStatus({ kind: 'error', fileName: file.name, message: e?.message ?? String(e) });
    }
  }

  async function applyPreview(seed: ParsedSeed, fileName: string) {
    if (!matrixClient || !roomId || !collectionId || !store) return;
    setStatus({ kind: 'applying', fileName, current: 0, total: seed.events.length });
    try {
      const result = await seedSpaceFromFile(
        matrixClient,
        roomId,
        collectionId,
        store,
        seed,
        {
          onProgress: (current, total) => {
            setStatus({ kind: 'applying', fileName, current, total });
          },
        },
      );
      setStatus({
        kind: 'done',
        fileName,
        total: result.total,
        added: result.added,
        skipped: result.skipped,
        genesis: !!result.hotStartGenesis,
      });
    } catch (e: any) {
      setStatus({ kind: 'error', fileName, message: e?.message ?? String(e) });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, color: theme.textSecondary }}>
        Upload an <code style={{ fontSize: 11 }}>.eodb</code> or NDJSON event bundle to
        seed this space. New events are folded in; events already present (matched by
        content hash) are skipped. Empty spaces seeded with an <code style={{ fontSize: 11 }}>.eodb</code>
        {' '}use a fast genesis-block path.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          ref={fileInputRef}
          type="file"
          accept=".eodb,.ndjson,.jsonl,application/octet-stream,application/x-ndjson,application/json"
          style={{ display: 'none' }}
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            // Reset the input so the same file can be re-selected.
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
        <button
          type="button"
          disabled={disabled || status.kind === 'reading' || status.kind === 'applying'}
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

      {status.kind === 'reading' && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          Reading <code>{status.fileName}</code>…
        </div>
      )}

      {status.kind === 'preview' && (
        <div style={{
          padding: '8px 10px',
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          fontSize: 11,
          color: theme.text,
          display: 'flex',
          flexDirection: 'column' as const,
          gap: 6,
        }}>
          <div>
            <strong>{status.fileName}</strong> — detected{' '}
            <code>{status.seed.format}</code> with{' '}
            <strong>{status.seed.events.length.toLocaleString()}</strong> events.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => applyPreview(status.seed, status.fileName)}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                background: theme.accent,
                color: theme.bg,
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              Apply to this space
            </button>
            <button
              type="button"
              onClick={() => setStatus({ kind: 'idle' })}
              style={{
                padding: '4px 10px',
                fontSize: 11,
                background: 'transparent',
                color: theme.text,
                border: `1px solid ${theme.border}`,
                borderRadius: 3,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status.kind === 'applying' && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>
          Applying <code>{status.fileName}</code>… {status.current.toLocaleString()} /{' '}
          {status.total.toLocaleString()}
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
          {status.genesis ? 'Sealed as genesis block. ' : ''}
          Added <strong>{status.added.toLocaleString()}</strong>. Skipped{' '}
          <strong>{status.skipped.toLocaleString()}</strong> already-present event(s).
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
          Failed to seed <code>{status.fileName}</code>: {status.message}
        </div>
      )}
    </div>
  );
}
