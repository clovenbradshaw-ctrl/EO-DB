/**
 * Matrix-media backend: backend dispatch + JSON envelope round-trip.
 *
 * The two backends share the same at-rest `BlobEnvelope` shape so a reader
 * dispatched by URI scheme reconstructs identical metadata + ciphertext
 * regardless of which backend wrote it.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  backendForUri,
  fetchBlobByUri,
  fetchBlobFromMatrixMedia,
  storeBlobToMatrixMedia,
  type BlobUploadMeta,
  type MatrixMediaClient,
} from '../eodb-blob-endpoint';

function makeMockMediaClient() {
  const stored = new Map<string, Blob>();
  let counter = 0;
  const uploadContent = vi.fn(async (file: Blob) => {
    counter += 1;
    const id = `media${counter}`;
    stored.set(id, file);
    return { content_uri: `mxc://test.server/${id}` };
  });
  const mxcUrlToHttp = vi.fn((mxc: string) => {
    if (!mxc.startsWith('mxc://')) return null;
    const [, server, id] = mxc.match(/^mxc:\/\/([^/]+)\/(.+)$/) ?? [];
    if (!server || !id) return null;
    return `https://${server}/_matrix/media/v3/download/${server}/${id}`;
  });
  const client: MatrixMediaClient = {
    uploadContent: uploadContent as unknown as MatrixMediaClient['uploadContent'],
    mxcUrlToHttp: mxcUrlToHttp as unknown as MatrixMediaClient['mxcUrlToHttp'],
  };
  return { client, stored, uploadContent, mxcUrlToHttp };
}

describe('backendForUri', () => {
  it('classifies mxc:// as matrix-media', () => {
    expect(backendForUri('mxc://example.com/abc123')).toBe('matrix-media');
  });
  it('classifies gdrive:// as drive', () => {
    expect(backendForUri('gdrive://1A2B3C')).toBe('drive');
  });
  it('returns null for unknown schemes', () => {
    expect(backendForUri('https://example.com/x')).toBeNull();
    expect(backendForUri('file:///tmp/x')).toBeNull();
    expect(backendForUri('')).toBeNull();
  });
});

describe('storeBlobToMatrixMedia + fetchBlobFromMatrixMedia round-trip', () => {
  it('preserves envelope metadata + ciphertext bytes', async () => {
    const mock = makeMockMediaClient();
    const meta: BlobUploadMeta = {
      v: 2,
      iv: 'AAAAAAAAAAAAAAAA',
      content_hash: 'cafebabe',
      key_id: 'space.editor',
      plaintext_size: 128,
      compression: 'gzip',
    };
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const stored = await storeBlobToMatrixMedia(mock.client, meta, ciphertext, {
      name: 'eodb-deadbeef.json',
    });
    expect(stored.uri).toBe('mxc://test.server/media1');
    expect(stored.created).toBe(true);
    expect(mock.uploadContent).toHaveBeenCalledOnce();

    // Intercept the http fetch with a stub that pulls the blob from the
    // mock's in-memory map. Keeps the test hermetic (no real network).
    const blob = mock.stored.get('media1');
    expect(blob).toBeDefined();
    const text = await blob!.text();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    try {
      const fetched = await fetchBlobFromMatrixMedia(mock.client, stored.uri);
      expect(fetched).not.toBeNull();
      expect(fetched!.uri).toBe(stored.uri);
      expect(fetched!.envelope.v).toBe(2);
      expect(fetched!.envelope.iv).toBe(meta.iv);
      expect(fetched!.envelope.content_hash).toBe(meta.content_hash);
      expect(fetched!.envelope.key_id).toBe(meta.key_id);
      expect(fetched!.envelope.plaintext_size).toBe(meta.plaintext_size);
      expect(fetched!.envelope.compression).toBe(meta.compression);
      // ct is base64(ciphertext) — verify byte equality
      const decoded = Uint8Array.from(atob(fetched!.envelope.ct), c => c.charCodeAt(0));
      expect(Array.from(decoded)).toEqual(Array.from(ciphertext));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns null when mxcUrlToHttp cannot resolve the URI', async () => {
    const mock = makeMockMediaClient();
    mock.mxcUrlToHttp.mockReturnValueOnce(null);
    const result = await fetchBlobFromMatrixMedia(mock.client, 'mxc://nope');
    expect(result).toBeNull();
  });

  it('returns null on HTTP 404', async () => {
    const mock = makeMockMediaClient();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );
    try {
      const result = await fetchBlobFromMatrixMedia(mock.client, 'mxc://test.server/missing');
      expect(result).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('fetchBlobByUri dispatcher', () => {
  it('requires mediaClient for mxc:// URIs', async () => {
    await expect(
      fetchBlobByUri(
        { matrixToken: 'tok', spaceRoomId: null },
        'mxc://test.server/abc',
      ),
    ).rejects.toThrow(/mediaClient required/);
  });

  it('requires dataId for gdrive:// URIs', async () => {
    await expect(
      fetchBlobByUri(
        { matrixToken: 'tok', spaceRoomId: null },
        'gdrive://abc',
      ),
    ).rejects.toThrow(/dataId required/);
  });

  it('returns null for unknown URI schemes', async () => {
    const result = await fetchBlobByUri(
      { matrixToken: 'tok', spaceRoomId: null },
      'unknown://x',
    );
    expect(result).toBeNull();
  });
});
