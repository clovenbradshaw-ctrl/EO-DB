/**
 * Architecture Layer Definitions — SEG boundaries for the EO-DB codebase.
 *
 * Each layer maps to a directory prefix and represents a distinct concern.
 * The fold uses these to draw SEG boundaries in the analysis event log.
 */

import type { ArchitectureLayer, EquivalencePair } from './types.js';

export const LAYERS: ArchitectureLayer[] = [
  // ─── Server-side (reference implementation) ────────────────────────────
  {
    id: 'server',
    name: 'Server Engine',
    description: 'Fastify/LevelDB server — reference implementation of the fold engine',
    pathPrefix: 'src/',
  },
  {
    id: 'server.db',
    name: 'Core Fold Engine',
    description: 'The nine-operator fold, state projection, graph, horizon, hashing',
    pathPrefix: 'src/db/',
    parent: 'server',
  },
  {
    id: 'server.api',
    name: 'HTTP API',
    description: 'Fastify routes — webhook, ops, query, sync, auth endpoints',
    pathPrefix: 'src/api/',
    parent: 'server',
  },
  {
    id: 'server.matrix',
    name: 'Server Matrix Integration',
    description: 'Matrix SDK bridge — event relay, room sync, peer presence',
    pathPrefix: 'src/matrix/',
    parent: 'server',
  },
  {
    id: 'server.ingestion',
    name: 'Server Ingestion Pipeline',
    description: 'Airtable sync, field rules, type mapping, value extraction',
    pathPrefix: 'src/ingestion/',
    parent: 'server',
  },
  {
    id: 'server.crypto',
    name: 'Server Encryption',
    description: 'Segment keys, field-level encryption, key distribution',
    pathPrefix: 'src/crypto/',
    parent: 'server',
  },
  {
    id: 'server.dedup',
    name: 'Deduplication Engine',
    description: 'Similarity scoring, blocking, comparison for SYN detection',
    pathPrefix: 'src/dedup/',
    parent: 'server',
  },

  // ─── Browser-native app (primary development target) ───────────────────
  {
    id: 'browser',
    name: 'Browser App',
    description: 'React/Vite/TypeScript PWA — runs entire EO-DB locally',
    pathPrefix: 'github-matrix-dev/app/src/',
  },
  {
    id: 'browser.db',
    name: 'Browser Fold Engine',
    description: 'IndexedDB layer, browser fold, encrypted store, binary snapshots',
    pathPrefix: 'github-matrix-dev/app/src/db/',
    parent: 'browser',
  },
  {
    id: 'browser.components',
    name: 'UI Components',
    description: '80+ React components — views, editors, visualizations',
    pathPrefix: 'github-matrix-dev/app/src/components/',
    parent: 'browser',
  },
  {
    id: 'browser.store',
    name: 'State Management',
    description: 'Zustand stores — eo-store, slice-store, builder-store, sync-store',
    pathPrefix: 'github-matrix-dev/app/src/store/',
    parent: 'browser',
  },
  {
    id: 'browser.matrix',
    name: 'Browser Matrix Client',
    description: 'Direct Matrix login, sync manager, room history, presence, WebRTC',
    pathPrefix: 'github-matrix-dev/app/src/matrix/',
    parent: 'browser',
  },
  {
    id: 'browser.ingestion',
    name: 'Browser Ingestion',
    description: 'Browser-side Airtable sync — direct API, incremental pull, writeback',
    pathPrefix: 'github-matrix-dev/app/src/ingestion/',
    parent: 'browser',
  },
  {
    id: 'browser.permissions',
    name: 'Access Control',
    description: 'Matrix power levels → roles, field-level permissions, room topology',
    pathPrefix: 'github-matrix-dev/app/src/permissions/',
    parent: 'browser',
  },
  {
    id: 'browser.collab',
    name: 'Collaboration',
    description: 'Yjs collaborative editing, awareness, CRDT sync',
    pathPrefix: 'github-matrix-dev/app/src/collab/',
    parent: 'browser',
  },
  {
    id: 'browser.lib',
    name: 'Browser Utilities',
    description: 'Crypto, routing, auth, domain helpers',
    pathPrefix: 'github-matrix-dev/app/src/lib/',
    parent: 'browser',
  },

  // ─── Documentation ─────────────────────────────────────────────────────
  {
    id: 'docs',
    name: 'Documentation',
    description: 'Technical specs, architecture docs, governance model',
    pathPrefix: 'Documentation/',
  },

  // ─── Tests ─────────────────────────────────────────────────────────────
  {
    id: 'tests',
    name: 'Test Suite',
    description: 'Server and browser test files',
    pathPrefix: 'Tests/',
  },
];

/**
 * Known server ↔ browser equivalences (SYN).
 * These are modules ported from the server to run in the browser.
 */
export const EQUIVALENCES: EquivalencePair[] = [
  {
    serverPath: 'src/db/fold.ts',
    browserPath: 'github-matrix-dev/app/src/db/fold.ts',
    description: 'Nine-operator fold engine — ported to IndexedDB/async-mutex for browser',
  },
  {
    serverPath: 'src/db/horizon.ts',
    browserPath: 'github-matrix-dev/app/src/db/horizon.ts',
    description: 'Six-layer Horizon read model — same logic, different storage backend',
  },
  {
    serverPath: 'src/db/types.ts',
    browserPath: 'github-matrix-dev/app/src/db/idb.ts',
    description: 'Type definitions and storage schema — LevelDB keyspaces → IndexedDB object stores',
  },
  {
    serverPath: 'src/ingestion/',
    browserPath: 'github-matrix-dev/app/src/ingestion/',
    description: 'Airtable ingestion pipeline — server proxy → direct browser API calls',
  },
  {
    serverPath: 'src/matrix/',
    browserPath: 'github-matrix-dev/app/src/matrix/',
    description: 'Matrix integration — SDK server bridge → browser Matrix client',
  },
  {
    serverPath: 'src/crypto/',
    browserPath: 'github-matrix-dev/app/src/lib/crypto.ts',
    description: 'Encryption — Node crypto → Web SubtleCrypto',
  },
];

/**
 * Resolve which layer a file belongs to.
 * Returns the most specific (deepest) matching layer.
 */
export function resolveLayer(relativePath: string): ArchitectureLayer | null {
  let best: ArchitectureLayer | null = null;
  let bestLen = 0;

  for (const layer of LAYERS) {
    if (relativePath.startsWith(layer.pathPrefix) && layer.pathPrefix.length > bestLen) {
      best = layer;
      bestLen = layer.pathPrefix.length;
    }
  }

  return best;
}
