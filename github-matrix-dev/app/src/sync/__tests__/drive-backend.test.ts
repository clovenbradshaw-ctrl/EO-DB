import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the gdrive-api module so tests don't touch the network. The mock
// keeps an in-memory "folder" (map from dataType+fileName → bytes+fileId)
// and exposes assertion hooks.
const mockStore = new Map<string, { bytes: Uint8Array; fileId: string }>();
let nextFileId = 100;
const storeCalls: Array<{ token: string; dataType: string; fileName: string }> = [];
const retrieveCalls: Array<{ token: string; dataType: string; fileName: string }> = [];
let uploadShouldFail = false;

vi.mock('../../google-drive/gdrive-api', () => ({
  gdriveStoreNamed: vi.fn(async (token: string, bytes: Uint8Array, dataType: string, fileName: string) => {
    storeCalls.push({ token, dataType, fileName });
    if (uploadShouldFail) throw new Error('simulated drive upload failure');
    const key = `${dataType}/${fileName}`;
    const existing = mockStore.get(key);
    const fileId = existing?.fileId ?? `drive_${nextFileId++}`;
    mockStore.set(key, { bytes: new Uint8Array(bytes), fileId });
    return { ok: true, drive_file_id: fileId };
  }),
  gdriveRetrieveNamed: vi.fn(async (token: string, dataType: string, fileName: string) => {
    retrieveCalls.push({ token, dataType, fileName });
    const key = `${dataType}/${fileName}`;
    const entry = mockStore.get(key);
    if (!entry) return null;
    return { ok: true, data: entry.bytes, fileId: entry.fileId };
  }),
}));

import {
  DriveArchiveBackend,
  driveFetchArchive,
  formatDriveUri,
  parseDriveUri,
  archiveDataType,
  archiveFileName,
} from '../drive-backend';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('drive-backend — URI format', () => {
  it('roundtrips fileId through format/parse', () => {
    const uri = formatDriveUri('ABC123');
    expect(uri).toBe('drive://ABC123');
    expect(parseDriveUri(uri)).toEqual({ fileId: 'ABC123' });
  });

  it('rejects malformed URIs', () => {
    expect(parseDriveUri('https://drive.google.com/x')).toBeNull();
    expect(parseDriveUri('drive://')).toBeNull();
    expect(parseDriveUri('drive://a/b')).toBeNull();
  });

  it('refuses to format invalid fileIds', () => {
    expect(() => formatDriveUri('')).toThrow();
    expect(() => formatDriveUri('a/b')).toThrow();
  });
});

describe('drive-backend — naming', () => {
  it('archive folder per space', () => {
    expect(archiveDataType('space-1')).toBe('eo-archive-space-1');
  });

  it('filename is content-addressed', () => {
    expect(archiveFileName('abc123')).toBe('piece-abc123.eodb');
  });

  it('rejects empty / separators in naming helpers', () => {
    expect(() => archiveDataType('')).toThrow();
    expect(() => archiveFileName('')).toThrow();
    expect(() => archiveFileName('a/b')).toThrow();
  });
});

// ─── Upload path ─────────────────────────────────────────────────────────

describe('DriveArchiveBackend — uploadPiece', () => {
  beforeEach(() => {
    mockStore.clear();
    storeCalls.length = 0;
    retrieveCalls.length = 0;
    uploadShouldFail = false;
    nextFileId = 100;
  });

  it('uploads to the per-space folder with a content-addressed filename', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const contentHash = await sha256Hex(bytes);
    const backend = new DriveArchiveBackend({
      getToken: () => 'tok',
      getSpaceId: () => 'space-xyz',
    });
    const result = await backend.uploadPiece({
      piece_site: 'piece:DEV/v1/0',
      content_hash: contentHash,
      bytes,
    });
    expect(result.archive_uri).toMatch(/^drive:\/\/drive_\d+$/);
    expect(result.size_bytes).toBe(5);
    expect(storeCalls).toHaveLength(1);
    expect(storeCalls[0].dataType).toBe('eo-archive-space-xyz');
    expect(storeCalls[0].fileName).toBe(`piece-${contentHash}.eodb`);
    expect(storeCalls[0].token).toBe('tok');
  });

  it('throws on pre-upload hash mismatch WITHOUT calling drive', async () => {
    const backend = new DriveArchiveBackend({
      getToken: () => 'tok',
      getSpaceId: () => 'space-xyz',
    });
    await expect(
      backend.uploadPiece({
        piece_site: 'piece:DEV/v1/0',
        content_hash: 'DEADBEEF', // not the real hash
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/hash mismatch/);
    expect(storeCalls).toHaveLength(0);
  });

  it('propagates upload failures', async () => {
    uploadShouldFail = true;
    const bytes = new Uint8Array([9, 9, 9]);
    const contentHash = await sha256Hex(bytes);
    const backend = new DriveArchiveBackend({
      getToken: () => 'tok',
      getSpaceId: () => 'space-xyz',
    });
    await expect(
      backend.uploadPiece({
        piece_site: 'piece:DEV/v1/0',
        content_hash: contentHash,
        bytes,
      }),
    ).rejects.toThrow(/drive upload failure/);
  });

  it('refuses to upload when the access token is missing', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const contentHash = await sha256Hex(bytes);
    const backend = new DriveArchiveBackend({
      getToken: () => null,
      getSpaceId: () => 'space-xyz',
    });
    await expect(
      backend.uploadPiece({ piece_site: 'piece:DEV/v1/0', content_hash: contentHash, bytes }),
    ).rejects.toThrow(/no access token/);
  });

  it('refuses to upload when the spaceId is missing', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const contentHash = await sha256Hex(bytes);
    const backend = new DriveArchiveBackend({
      getToken: () => 'tok',
      getSpaceId: () => null,
    });
    await expect(
      backend.uploadPiece({ piece_site: 'piece:DEV/v1/0', content_hash: contentHash, bytes }),
    ).rejects.toThrow(/no spaceId/);
  });

  it('re-uploading the same content produces the same filename (content-addressed idempotence)', async () => {
    const bytes = new Uint8Array([42, 42, 42]);
    const contentHash = await sha256Hex(bytes);
    const backend = new DriveArchiveBackend({
      getToken: () => 'tok',
      getSpaceId: () => 'space-xyz',
    });
    const a = await backend.uploadPiece({
      piece_site: 'piece:DEV/v1/0',
      content_hash: contentHash,
      bytes,
    });
    const b = await backend.uploadPiece({
      piece_site: 'piece:DEV/v1/0',
      content_hash: contentHash,
      bytes,
    });
    // Same filename, same fileId — gdriveStoreNamed overwrites in place.
    expect(storeCalls).toHaveLength(2);
    expect(storeCalls[0].fileName).toBe(storeCalls[1].fileName);
    expect(a.archive_uri).toBe(b.archive_uri);
  });
});

// ─── Fetch / rehydrate path ──────────────────────────────────────────────

describe('driveFetchArchive', () => {
  beforeEach(() => {
    mockStore.clear();
    storeCalls.length = 0;
    retrieveCalls.length = 0;
    uploadShouldFail = false;
    nextFileId = 100;
  });

  it('round-trips bytes: upload then fetch returns the same content', async () => {
    const bytes = new Uint8Array([7, 8, 9, 10]);
    const contentHash = await sha256Hex(bytes);
    const cfg = { getToken: () => 'tok', getSpaceId: () => 'space-1' };
    const backend = new DriveArchiveBackend(cfg);
    const up = await backend.uploadPiece({
      piece_site: 'piece:DEV/v1/0',
      content_hash: contentHash,
      bytes,
    });
    const fetched = await driveFetchArchive({
      cfg,
      archive_uri: up.archive_uri,
      content_hash: contentHash,
    });
    expect(Array.from(fetched)).toEqual(Array.from(bytes));
    expect(retrieveCalls).toHaveLength(1);
    expect(retrieveCalls[0].fileName).toBe(`piece-${contentHash}.eodb`);
  });

  it('throws if the file is absent in Drive', async () => {
    const cfg = { getToken: () => 'tok', getSpaceId: () => 'space-1' };
    await expect(
      driveFetchArchive({
        cfg,
        archive_uri: 'drive://fake',
        content_hash: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/file not found/);
  });

  it('throws on post-fetch hash mismatch (bytes tampered)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const contentHash = await sha256Hex(bytes);
    // Seed the mock store directly with MISMATCHED bytes under the
    // content_hash's filename — simulating tampering at the Drive layer.
    mockStore.set(
      `eo-archive-space-1/piece-${contentHash}.eodb`,
      { bytes: new Uint8Array([9, 9, 9]), fileId: 'evil' },
    );
    const cfg = { getToken: () => 'tok', getSpaceId: () => 'space-1' };
    await expect(
      driveFetchArchive({ cfg, archive_uri: 'drive://evil', content_hash: contentHash }),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('throws when token or spaceId missing', async () => {
    await expect(
      driveFetchArchive({
        cfg: { getToken: () => null, getSpaceId: () => 'space-1' },
        archive_uri: 'drive://x',
        content_hash: 'h',
      }),
    ).rejects.toThrow(/no access token/);
    await expect(
      driveFetchArchive({
        cfg: { getToken: () => 'tok', getSpaceId: () => null },
        archive_uri: 'drive://x',
        content_hash: 'h',
      }),
    ).rejects.toThrow(/no spaceId/);
  });

  it('rejects non-drive:// URIs', async () => {
    const cfg = { getToken: () => 'tok', getSpaceId: () => 'space-1' };
    await expect(
      driveFetchArchive({
        cfg,
        archive_uri: 'https://other.host/abc',
        content_hash: 'h',
      }),
    ).rejects.toThrow(/not a drive uri/);
  });
});
