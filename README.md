# EO///DB

Browser-native database implementing the EO transformation calculus. No server. The fold runs in every browser. Every device with the events and keys has the complete database.

## Architecture

```
Browser (each device)
  ├── IndexedDB (encrypted at rest, AES-GCM)
  │     ├── log     — append-only event log
  │     ├── state   — projected state (from fold)
  │     ├── graph   — CON adjacency index
  │     └── eva     — EVA-active registrations
  ├── Nine-case fold (runs locally)
  ├── Six-layer Horizon read
  └── Matrix SDK (sync, E2EE, device messaging)

Matrix homeserver (app.aminoimmigration.com)
  ├── #amino-data room (E2EE) — event sync between devices
  ├── Media store — encrypted binary snapshots
  └── Key management — Megolm sessions, cross-signing
```

## Data Persistence Tiers

| Tier | Storage | Role |
|------|---------|------|
| 1 | Local IndexedDB (per device) | Primary working store, encrypted at rest |
| 2 | Matrix media repository | Binary snapshot backups for fast device bootstrap |
| 3 | 3rd-party backups (future) | Disaster recovery, archival (S3, IPFS, etc.) |

## How It Works

- **Local-first:** Events fold immediately in the browser. UI updates instantly. Sync is async.
- **Matrix sync:** Events propagate to other devices through an encrypted Matrix room.
- **Offline capable:** All operations work offline. Events queue and sync on reconnect.
- **Snapshot hydration:** New devices bootstrap from a binary snapshot, then sync the tail.
- **No server:** No `localhost:3000`. No Fastify. No LevelDB. No nginx. The browser is the database.

## Development

See [DEVELOPMENT-STAGES.md](./DEVELOPMENT-STAGES.md) for the staged build plan.

### Legacy Server (historical)

The `src/` directory contains the original server-based implementation (Fastify + LevelDB). It serves as reference for the fold logic, operator handlers, Horizon layers, and ingestion pipeline being ported to the browser.

```bash
# Legacy server (reference only)
npm install
npm run dev       # Starts Fastify at localhost:3000
npm test          # Runs vitest suite
```

### Browser App

```bash
# Open directly (Stages 1-2, no build step)
open index.html

# With Vite (Stage 3+, required for Matrix SDK)
npm run dev       # Vite dev server
npm run build     # Static assets to dist/
```

## Matrix Homeserver

Authentication and sync target: `https://app.aminoimmigration.com`

## Documentation

| Document | Purpose |
|----------|---------|
| `DEVELOPMENT-STAGES.md` | Staged build plan for browser-native transition |
| `eo-db-technical-spec.md` | Technical spec (server-era, fold/operator logic still authoritative) |
| `build-eo-db-prompt.md` | Original server build phases (completed) |
| `github-matrix-dev/eo-db-decentralized-spec.md` | Decentralized architecture spec |
| `github-matrix-dev/build-eo-db-decentralized-prompt.md` | Browser-native build guide |
| `about.md` | Design report — transformation calculus theory |
