import { describe, it, expect } from 'vitest';
import type { EoEvent } from '../../db/types';
import {
  emptyProjection,
  applyEvent,
  pieceStatus,
  type SyncProjection,
  type PieceProjection,
} from '../projection';
import {
  selectForArchival,
  runArchiverTick,
  buildCacheDefEvent,
  buildArchiveEvents,
  formatUriAdvertiser,
  resolveCacheDef,
  countResidencyFromProjection,
  type ArchiveBackend,
  type ArchiverIO,
  type ArchiverKnobs,
  type SelectedPiece,
} from '../archiver';
import { pieceSite, cacheSite, swarmSite, peerSite } from '../sites';
import { DEFAULT_CACHE_DEF, type CacheDefOperand } from '../operators';
import { formatAgent } from '../agent';

let nextSeq = 1;
function ev(partial: Partial<EoEvent> & Pick<EoEvent, 'op' | 'target' | 'operand'>): EoEvent {
  return {
    seq: nextSeq++,
    agent: '@sys:local',
    ts: '2026-01-01T00:00:00.000Z',
    acquired_ts: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as EoEvent;
}
function resetSeq() { nextSeq = 1; }

function instantiatePiece(
  proj: SyncProjection,
  author: string,
  idx: number,
  hash: string,
): SyncProjection {
  return applyEvent(proj, ev({
    op: 'INS',
    target: pieceSite(author, idx),
    operand: { content_hash: hash, verified_at: 't' },
  }));
}

function addVerifyingDeliveries(
  proj: SyncProjection,
  author: string,
  idx: number,
  hash: string,
  peerSites: string[],
): SyncProjection {
  let p = proj;
  for (const peer of peerSites) {
    p = applyEvent(p, ev({
      op: 'CON',
      target: peer,
      operand: {
        joined: pieceSite(author, idx),
        coupling: 'delivered_verified',
        observed_hash: hash,
      },
    }));
  }
  return p;
}

// ─── cache projection ────────────────────────────────────────────────────

describe('cache projection — DEF merging', () => {
  it('DEF on cache:<device> sets retention schema', () => {
    resetSeq();
    let p = emptyProjection();
    p = applyEvent(p, ev({
      op: 'DEF',
      target: cacheSite('DA'),
      operand: {
        enabled: true,
        high_watermark_mb: 1000,
        low_watermark_mb: 800,
        min_attestation: 2,
        hot_window_ms: 60_000,
      } as Partial<CacheDefOperand>,
    }));
    const c = p.caches.get('DA');
    expect(c).toBeDefined();
    expect(c!.def.enabled).toBe(true);
    expect(c!.def.high_watermark_mb).toBe(1000);
    expect(c!.def.low_watermark_mb).toBe(800);
  });

  it('partial DEF composes with existing def, preserving other fields', () => {
    resetSeq();
    let p = emptyProjection();
    p = applyEvent(p, ev({
      op: 'DEF',
      target: cacheSite('DA'),
      operand: { enabled: true, high_watermark_mb: 500, low_watermark_mb: 400 },
    }));
    // Only flip `enabled`. Watermarks should persist.
    p = applyEvent(p, ev({
      op: 'DEF',
      target: cacheSite('DA'),
      operand: { enabled: false },
    }));
    const c = p.caches.get('DA')!;
    expect(c.def.enabled).toBe(false);
    expect(c.def.high_watermark_mb).toBe(500);
    expect(c.def.low_watermark_mb).toBe(400);
  });

  it('rejects DEF where low >= high', () => {
    resetSeq();
    let p = emptyProjection();
    const before = applyEvent(p, ev({
      op: 'DEF',
      target: cacheSite('DA'),
      operand: { enabled: true, high_watermark_mb: 500, low_watermark_mb: 400 },
    }));
    // Bad watermark ordering — projection returns the prior state unchanged.
    const after = applyEvent(before, ev({
      op: 'DEF',
      target: cacheSite('DA'),
      operand: { high_watermark_mb: 100, low_watermark_mb: 200 },
    }));
    expect(after).toBe(before);
  });

  it('EVA on cache:<device> records usage measurement', () => {
    resetSeq();
    let p = emptyProjection();
    p = applyEvent(p, ev({
      op: 'EVA',
      target: cacheSite('DA'),
      operand: {
        predicate: 'usage_measurement',
        usage_mb: 512,
        quota_mb: 1024,
        resident_pieces: 7,
        archived_pieces: 3,
      },
    }));
    const c = p.caches.get('DA')!;
    expect(c.lastUsageMb).toBe(512);
    expect(c.lastQuotaMb).toBe(1024);
    expect(c.lastResidentPieces).toBe(7);
    expect(c.lastArchivedPieces).toBe(3);
  });

  it('resolveCacheDef falls back to defaults when no DEF has been seen', () => {
    const p = emptyProjection();
    expect(resolveCacheDef(p, 'DA')).toEqual(DEFAULT_CACHE_DEF);
  });
});

// ─── piece archive state ─────────────────────────────────────────────────

describe('piece archive — REC(locally_archived)', () => {
  it('REC locally_archived sets archive and clears instantiatedHash', () => {
    resetSeq();
    let p = emptyProjection();
    p = instantiatePiece(p, 'A', 0, 'h1');
    expect(pieceStatus(p.pieces.get(pieceSite('A', 0))!)).toBe('instantiated');

    p = applyEvent(p, ev({
      op: 'REC',
      target: pieceSite('A', 0),
      operand: {
        recognized: 'locally_archived',
        archive_uri: 'https://drive.google.com/p/abcd',
        archive_scheme: 'drive',
        content_hash: 'h1',
        archived_at: '2026-01-02T00:00:00Z',
        size_bytes: 4096,
      },
    }));
    const piece = p.pieces.get(pieceSite('A', 0))!;
    expect(piece.archive).not.toBeNull();
    expect(piece.archive!.scheme).toBe('drive');
    expect(piece.archive!.archive_uri).toBe('https://drive.google.com/p/abcd');
    expect(piece.instantiatedHash).toBeNull();
    expect(pieceStatus(piece)).toBe('archived');
  });

  it('subsequent INS (rehydrate) clears the archive marker', () => {
    resetSeq();
    let p = emptyProjection();
    p = instantiatePiece(p, 'A', 0, 'h1');
    p = applyEvent(p, ev({
      op: 'REC',
      target: pieceSite('A', 0),
      operand: {
        recognized: 'locally_archived',
        archive_uri: 'https://drive.google.com/p/abcd',
        archive_scheme: 'drive',
        content_hash: 'h1',
        archived_at: 't',
        size_bytes: 4096,
      },
    }));
    expect(pieceStatus(p.pieces.get(pieceSite('A', 0))!)).toBe('archived');

    p = instantiatePiece(p, 'A', 0, 'h1');
    const piece = p.pieces.get(pieceSite('A', 0))!;
    expect(piece.archive).toBeNull();
    expect(piece.instantiatedHash).toBe('h1');
    expect(pieceStatus(piece)).toBe('instantiated');
  });

  it('REC locally_archived with missing fields is rejected', () => {
    resetSeq();
    let p = emptyProjection();
    p = instantiatePiece(p, 'A', 0, 'h1');
    const before = p;
    p = applyEvent(p, ev({
      op: 'REC',
      target: pieceSite('A', 0),
      operand: {
        recognized: 'locally_archived',
        // missing archive_uri
        archive_scheme: 'drive',
        content_hash: 'h1',
        archived_at: 't',
        size_bytes: 1,
      },
    }));
    expect(p).toBe(before);
  });
});

// ─── selection (pure) ────────────────────────────────────────────────────

function makeProjectionWithTwoAttestedPieces(): SyncProjection {
  resetSeq();
  let p = emptyProjection();
  // Piece A/0 and A/1, both instantiated and attested by 3 peers each.
  for (const idx of [0, 1]) {
    p = instantiatePiece(p, 'A', idx, `h${idx}`);
    p = addVerifyingDeliveries(p, 'A', idx, `h${idx}`, [
      peerSite('@a', 'da'),
      peerSite('@b', 'db'),
      peerSite('@c', 'dc'),
    ]);
  }
  return p;
}

describe('selectForArchival', () => {
  it('returns [] when disabled', () => {
    const p = makeProjectionWithTwoAttestedPieces();
    const def: CacheDefOperand = { ...DEFAULT_CACHE_DEF, enabled: false };
    const out = selectForArchival({
      projection: p,
      def,
      usage_mb: 1_000_000,
      lastAccessMsByPieceSite: new Map(),
      nowMs: Date.now(),
      pieceSizeBytesBySite: new Map(),
      defaultPieceSizeBytes: 1024,
    });
    expect(out).toEqual([]);
  });

  it('returns [] when usage is at or below the high watermark', () => {
    const p = makeProjectionWithTwoAttestedPieces();
    const def: CacheDefOperand = {
      ...DEFAULT_CACHE_DEF, enabled: true, high_watermark_mb: 500, low_watermark_mb: 400, min_attestation: 3,
      hot_window_ms: 0, // everything is cold
    };
    const out = selectForArchival({
      projection: p, def,
      usage_mb: 499, // below high watermark
      lastAccessMsByPieceSite: new Map(), nowMs: Date.now(),
      pieceSizeBytesBySite: new Map(), defaultPieceSizeBytes: 1024,
    });
    expect(out).toEqual([]);
  });

  it('coldest-first: picks the oldest-accessed piece first', () => {
    const p = makeProjectionWithTwoAttestedPieces();
    const def: CacheDefOperand = {
      ...DEFAULT_CACHE_DEF, enabled: true, high_watermark_mb: 500, low_watermark_mb: 400,
      min_attestation: 3, hot_window_ms: 0,
    };
    const lastAccess = new Map<string, number>();
    lastAccess.set(pieceSite('A', 0), 1000);
    lastAccess.set(pieceSite('A', 1), 2000);
    const sizes = new Map<string, number>();
    sizes.set(pieceSite('A', 0), 50 * 1024 * 1024); // 50MB
    sizes.set(pieceSite('A', 1), 50 * 1024 * 1024); // 50MB
    const out = selectForArchival({
      projection: p, def,
      usage_mb: 600,
      lastAccessMsByPieceSite: lastAccess, nowMs: 10_000_000,
      pieceSizeBytesBySite: sizes, defaultPieceSizeBytes: 1024,
    });
    // piece A/0 is coldest (access=1000 < 2000) and should be selected first.
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].piece.piece_site).toBe(pieceSite('A', 0));
  });

  it('stops once projected usage <= low_watermark_mb', () => {
    const p = makeProjectionWithTwoAttestedPieces();
    const def: CacheDefOperand = {
      ...DEFAULT_CACHE_DEF, enabled: true, high_watermark_mb: 500, low_watermark_mb: 400,
      min_attestation: 3, hot_window_ms: 0,
    };
    const oneMb = 1024 * 1024;
    const sizes = new Map<string, number>();
    sizes.set(pieceSite('A', 0), 50 * oneMb);
    sizes.set(pieceSite('A', 1), 50 * oneMb);
    const out = selectForArchival({
      projection: p, def,
      usage_mb: 501, // only need to drop ~101 MB to get to 400
      lastAccessMsByPieceSite: new Map([
        [pieceSite('A', 0), 1000], [pieceSite('A', 1), 2000],
      ]),
      nowMs: 10_000_000,
      pieceSizeBytesBySite: sizes, defaultPieceSizeBytes: oneMb,
    });
    // 501 - 50 = 451 (still above 400) → picks first; 451 - 50 = 401 (still above 400) → picks second
    // To drop below 400 we need BOTH, so we expect 2.
    expect(out).toHaveLength(2);
  });

  it('excludes pieces below min_attestation', () => {
    resetSeq();
    let p = emptyProjection();
    p = instantiatePiece(p, 'A', 0, 'h0');
    // Only 1 attester — below the default min_attestation=3.
    p = addVerifyingDeliveries(p, 'A', 0, 'h0', [peerSite('@a', 'da')]);

    const def: CacheDefOperand = {
      ...DEFAULT_CACHE_DEF, enabled: true, high_watermark_mb: 1, low_watermark_mb: 0,
      min_attestation: 3, hot_window_ms: 0,
    };
    const out = selectForArchival({
      projection: p, def, usage_mb: 1_000,
      lastAccessMsByPieceSite: new Map(), nowMs: Date.now(),
      pieceSizeBytesBySite: new Map(), defaultPieceSizeBytes: 1024,
    });
    expect(out).toEqual([]);
  });

  it('excludes hot pieces', () => {
    const p = makeProjectionWithTwoAttestedPieces();
    const now = 10_000_000;
    const def: CacheDefOperand = {
      ...DEFAULT_CACHE_DEF, enabled: true, high_watermark_mb: 1, low_watermark_mb: 0,
      min_attestation: 3, hot_window_ms: 1_000_000, // 1000s hot
    };
    const lastAccess = new Map<string, number>();
    lastAccess.set(pieceSite('A', 0), now - 500_000); // hot (inside window)
    lastAccess.set(pieceSite('A', 1), now - 2_000_000); // cold
    const out = selectForArchival({
      projection: p, def, usage_mb: 1000,
      lastAccessMsByPieceSite: lastAccess, nowMs: now,
      pieceSizeBytesBySite: new Map(), defaultPieceSizeBytes: 1024,
    });
    // Only the cold one is eligible.
    expect(out).toHaveLength(1);
    expect(out[0].piece.piece_site).toBe(pieceSite('A', 1));
  });

  it('excludes already-archived pieces', () => {
    let p = makeProjectionWithTwoAttestedPieces();
    p = applyEvent(p, ev({
      op: 'REC',
      target: pieceSite('A', 0),
      operand: {
        recognized: 'locally_archived',
        archive_uri: 'https://drive.google.com/abc',
        archive_scheme: 'drive',
        content_hash: 'h0',
        archived_at: 't',
        size_bytes: 4096,
      },
    }));
    const def: CacheDefOperand = {
      ...DEFAULT_CACHE_DEF, enabled: true, high_watermark_mb: 1, low_watermark_mb: 0,
      min_attestation: 3, hot_window_ms: 0,
    };
    const out = selectForArchival({
      projection: p, def, usage_mb: 1000,
      lastAccessMsByPieceSite: new Map(), nowMs: Date.now(),
      pieceSizeBytesBySite: new Map(), defaultPieceSizeBytes: 1024,
    });
    // Only A/1 is still resident.
    expect(out.length).toBeLessThanOrEqual(1);
    for (const sel of out) {
      expect(sel.piece.piece_site).not.toBe(pieceSite('A', 0));
    }
  });
});

// ─── archiver tick — pipeline ────────────────────────────────────────────

class FakeBackend implements ArchiveBackend {
  scheme = 'drive' as const;
  uploaded = new Map<string, Uint8Array>();
  failNext = false;
  async uploadPiece({ piece_site, content_hash, bytes }: { piece_site: string; content_hash: string; bytes: Uint8Array }) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated upload failure');
    }
    const uri = `https://drive.google.com/${content_hash}`;
    this.uploaded.set(piece_site, bytes);
    return { archive_uri: uri, size_bytes: bytes.length };
  }
}

class FakeIO implements ArchiverIO {
  log: EoEvent[] = [];
  local = new Map<string, Uint8Array>();
  nowValue = '2026-02-02T00:00:00.000Z';
  async readPieceBytes(piece_site: string) {
    return this.local.get(piece_site) ?? null;
  }
  async dropPieceBytes(piece_site: string) {
    this.local.delete(piece_site);
  }
  async appendEvents(events: EoEvent[]) {
    this.log.push(...events);
  }
  nowIso() { return this.nowValue; }
}

function makeKnobs(): ArchiverKnobs {
  return {
    systemAgent: formatAgent('@me:host', 'MY_DEVICE'),
    myDeviceId: 'MY_DEVICE',
    roomId: '!room:host',
    myPeerSite: peerSite('@me:host', 'MY_DEVICE'),
    maxArchivesPerTick: 16,
  };
}

describe('runArchiverTick', () => {
  it('successful upload emits SIG + REC + EVA and drops local bytes', async () => {
    const proj = makeProjectionWithTwoAttestedPieces();
    const io = new FakeIO();
    const backend = new FakeBackend();
    const knobs = makeKnobs();
    io.local.set(pieceSite('A', 0), new Uint8Array([1, 2, 3, 4]));
    const selection: SelectedPiece[] = [{
      piece: proj.pieces.get(pieceSite('A', 0))! as PieceProjection,
      size_bytes: 4,
      content_hash: 'h0',
    }];
    const result = await runArchiverTick({
      projection: proj, selection,
      usage_mb: 501, quota_mb: 1024,
      io, backend, knobs,
    });
    expect(result.archived).toBe(1);
    expect(result.skipped).toBe(0);
    // Local bytes dropped.
    expect(io.local.get(pieceSite('A', 0))).toBeUndefined();
    // Backend has the bytes.
    expect(backend.uploaded.has(pieceSite('A', 0))).toBe(true);
    // Log has SIG + REC + EVA.
    const ops = io.log.map((e) => `${e.op}@${e.target}`);
    expect(ops).toContain(`SIG@${swarmSite(knobs.roomId)}`);
    expect(ops).toContain(`REC@${pieceSite('A', 0)}`);
    expect(ops).toContain(`EVA@${cacheSite(knobs.myDeviceId)}`);
  });

  it('upload failure keeps bytes local and emits no REC', async () => {
    const proj = makeProjectionWithTwoAttestedPieces();
    const io = new FakeIO();
    const backend = new FakeBackend();
    const knobs = makeKnobs();
    io.local.set(pieceSite('A', 0), new Uint8Array([9, 9, 9]));
    backend.failNext = true;
    const selection: SelectedPiece[] = [{
      piece: proj.pieces.get(pieceSite('A', 0))! as PieceProjection,
      size_bytes: 3,
      content_hash: 'h0',
    }];
    const result = await runArchiverTick({
      projection: proj, selection,
      usage_mb: 501, quota_mb: null,
      io, backend, knobs,
    });
    expect(result.archived).toBe(0);
    expect(result.skipped).toBe(1);
    expect(io.local.get(pieceSite('A', 0))).toBeDefined();
    expect(io.log.some((e) => e.op === 'REC' && e.target === pieceSite('A', 0))).toBe(false);
  });

  it('skips pieces whose bytes are not present locally', async () => {
    const proj = makeProjectionWithTwoAttestedPieces();
    const io = new FakeIO();
    const backend = new FakeBackend();
    const knobs = makeKnobs();
    // No bytes placed in io.local — read returns null.
    const selection: SelectedPiece[] = [{
      piece: proj.pieces.get(pieceSite('A', 0))! as PieceProjection,
      size_bytes: 4,
      content_hash: 'h0',
    }];
    const result = await runArchiverTick({
      projection: proj, selection,
      usage_mb: 501, quota_mb: null,
      io, backend, knobs,
    });
    expect(result.archived).toBe(0);
    expect(result.skipped).toBe(1);
    expect(backend.uploaded.size).toBe(0);
  });
});

// ─── event construction ─────────────────────────────────────────────────

describe('buildArchiveEvents', () => {
  it('SIG advertises URI via the reserved uri: prefix', () => {
    const knobs = makeKnobs();
    const events = buildArchiveEvents({
      piece_site: pieceSite('A', 0),
      author_device_id: 'A',
      piece_index: 0,
      content_hash: 'h0',
      size_bytes: 4096,
      archive_uri: 'https://drive.google.com/abc',
      scheme: 'drive',
      archived_at: '2026-02-02T00:00:00Z',
      knobs,
    });
    const sig = events.find((e) => e.op === 'SIG');
    expect(sig).toBeDefined();
    expect(sig!.target).toBe(swarmSite(knobs.roomId));
    expect((sig!.operand as { advertised_by: string }).advertised_by)
      .toBe(formatUriAdvertiser('drive', 'https://drive.google.com/abc'));
  });

  it('stable client_event_id — re-running with same inputs dedupes', () => {
    const knobs = makeKnobs();
    const a = buildArchiveEvents({
      piece_site: pieceSite('A', 0), author_device_id: 'A', piece_index: 0,
      content_hash: 'h0', size_bytes: 1, archive_uri: 'https://x', scheme: 'https',
      archived_at: 't', knobs,
    });
    const b = buildArchiveEvents({
      piece_site: pieceSite('A', 0), author_device_id: 'A', piece_index: 0,
      content_hash: 'h0', size_bytes: 1, archive_uri: 'https://x', scheme: 'https',
      archived_at: 't', knobs,
    });
    expect(a.map((e) => e.client_event_id)).toEqual(b.map((e) => e.client_event_id));
  });
});

describe('buildCacheDefEvent', () => {
  it('emits DEF on cache:<deviceId> with the patch as operand', () => {
    const e = buildCacheDefEvent({
      systemAgent: formatAgent('@me:host', 'MY_DEVICE'),
      myDeviceId: 'MY_DEVICE',
      patch: { enabled: true, high_watermark_mb: 750 },
      nowIso: '2026-03-01T00:00:00.000Z',
    });
    expect(e.op).toBe('DEF');
    expect(e.target).toBe(cacheSite('MY_DEVICE'));
    expect(e.operand).toEqual({ enabled: true, high_watermark_mb: 750 });
  });
});

// ─── residency counting ─────────────────────────────────────────────────

describe('countResidencyFromProjection', () => {
  it('counts instantiated and archived pieces separately', () => {
    resetSeq();
    let p = emptyProjection();
    p = instantiatePiece(p, 'A', 0, 'h0');
    p = instantiatePiece(p, 'A', 1, 'h1');
    p = applyEvent(p, ev({
      op: 'REC', target: pieceSite('A', 1),
      operand: {
        recognized: 'locally_archived',
        archive_uri: 'https://x', archive_scheme: 'https',
        content_hash: 'h1', archived_at: 't', size_bytes: 0,
      },
    }));
    const counts = countResidencyFromProjection(p);
    expect(counts.resident_pieces).toBe(1);
    expect(counts.archived_pieces).toBe(1);
  });
});
