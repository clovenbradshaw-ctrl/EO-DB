import { describe, it, expect } from 'vitest';
import {
  swarmSite,
  peerSite,
  logSite,
  pieceSite,
  tailSite,
  parseSwarmSite,
  parsePeerSite,
  parseLogSite,
  parsePieceSite,
  parseTailSite,
  parseSyncSite,
  siteFamily,
  isSyncSite,
  isSyncTarget,
} from '../sites';

describe('sites — round-trip build/parse', () => {
  it('swarm', () => {
    const s = swarmSite('!room:matrix.local');
    expect(parseSwarmSite(s)).toEqual({ family: 'swarm', roomId: '!room:matrix.local' });
    expect(siteFamily(s)).toBe('swarm');
  });

  it('peer', () => {
    const s = peerSite('@alice:matrix.local', 'DEVICE123');
    expect(parsePeerSite(s)).toEqual({
      family: 'peer',
      userId: '@alice:matrix.local',
      deviceId: 'DEVICE123',
    });
  });

  it('log', () => {
    const s = logSite('DEVICE123');
    expect(parseLogSite(s)).toEqual({ family: 'log', authorDeviceId: 'DEVICE123' });
  });

  it('piece (default version)', () => {
    const s = pieceSite('DEVICE123', 42);
    expect(s).toBe('piece:DEVICE123/v1/42');
    expect(parsePieceSite(s)).toEqual({
      family: 'piece',
      authorDeviceId: 'DEVICE123',
      version: 1,
      pieceIndex: 42,
    });
  });

  it('piece (explicit version)', () => {
    const s = pieceSite('DEVICE123', 0, 2);
    expect(parsePieceSite(s)?.version).toBe(2);
    expect(parsePieceSite(s)?.pieceIndex).toBe(0);
  });

  it('tail', () => {
    const s = tailSite('DEVICE123');
    expect(parseTailSite(s)).toEqual({ family: 'tail', authorDeviceId: 'DEVICE123' });
  });

  it('parseSyncSite dispatches', () => {
    expect(parseSyncSite(swarmSite('R'))?.family).toBe('swarm');
    expect(parseSyncSite(peerSite('@u', 'd'))?.family).toBe('peer');
    expect(parseSyncSite(logSite('d'))?.family).toBe('log');
    expect(parseSyncSite(pieceSite('d', 0))?.family).toBe('piece');
    expect(parseSyncSite(tailSite('d'))?.family).toBe('tail');
  });

  it('isSyncTarget and isSyncSite agree', () => {
    expect(isSyncTarget(pieceSite('d', 0))).toBe(true);
    expect(isSyncSite(pieceSite('d', 0))).toBe(true);
    expect(isSyncTarget('foo:bar')).toBe(false);
    expect(isSyncSite('card:user1')).toBe(false);
  });
});

describe('sites — malformed input rejected', () => {
  it('piece with missing parts', () => {
    expect(parsePieceSite('piece:dev/v1')).toBeNull();
    expect(parsePieceSite('piece:dev/42')).toBeNull();
    expect(parsePieceSite('piece:dev/x1/42')).toBeNull();
    expect(parsePieceSite('piece:dev/v1/notanumber')).toBeNull();
    expect(parsePieceSite('piece:dev/v0/1')).toBeNull();
    expect(parsePieceSite('piece:dev/v1/-5')).toBeNull();
  });

  it('peer with wrong separators', () => {
    expect(parsePeerSite('peer:alice')).toBeNull();
    expect(parsePeerSite('peer:|dev')).toBeNull();
    expect(parsePeerSite('peer:alice|')).toBeNull();
    expect(parsePeerSite('peer:a|b|c')).toBeNull();
  });

  it('log/tail reject compound device ids', () => {
    expect(parseLogSite('log:a/b')).toBeNull();
    expect(parseLogSite('log:a|b')).toBeNull();
    expect(parseLogSite('log:')).toBeNull();
    expect(parseTailSite('tail:')).toBeNull();
  });

  it('swarm rejects empty room', () => {
    expect(parseSwarmSite('swarm:')).toBeNull();
    expect(parseSwarmSite('notswarm:xyz')).toBeNull();
  });

  it('builders reject forbidden delimiters', () => {
    expect(() => peerSite('a|b', 'd')).toThrow();
    expect(() => peerSite('a', 'd|x')).toThrow();
    expect(() => pieceSite('dev/bad', 0)).toThrow();
    expect(() => pieceSite('dev', -1)).toThrow();
    expect(() => pieceSite('dev', 1.5)).toThrow();
    expect(() => pieceSite('dev', 0, 0)).toThrow();
  });

  it('non-sync targets return null', () => {
    expect(parseSyncSite('card:user1')).toBeNull();
    expect(parseSyncSite('helix:card:user1')).toBeNull();
    expect(isSyncTarget('card:user1')).toBe(false);
  });
});
