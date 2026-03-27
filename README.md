# EO///DB

Embedded database server implementing the EO transformation calculus.

## Prerequisites

- [Node.js](https://nodejs.org) (LTS version recommended)

## Setup

```bash
# Clone the repo
git clone https://github.com/clovenbradshaw-ctrl/eo-db.git
cd eo-db

# Install dependencies
npm install

# Start the server
npm run dev
```

The server runs at `http://localhost:3000` by default.

## Verify it's working

Open `http://localhost:3000/health` in your browser. You should see:

```json
{"status":"ok","seq":0,"uptime":...}
```

## Admin UI

Open `eo-db-admin.html` in your browser (double-click the file in your file explorer). It connects to the running server automatically.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the server in dev mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run tests |
| `npm run test:watch` | Run tests in watch mode |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EO_PORT` | `3000` | Server port |
| `EO_DATA_DIR` | `./data` | LevelDB data directory |
| `EO_MATRIX_HOMESERVER` | `https://app.aminoimmigration.com` | Matrix auth homeserver |
| `EO_WEBHOOK_SECRET` | _(empty)_ | Webhook authentication secret |
| `EO_LOG_LEVEL` | `info` | Log verbosity (`debug`, `info`, `warn`, `error`) |
