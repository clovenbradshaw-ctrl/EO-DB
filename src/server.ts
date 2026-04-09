import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createDb, type EoDb } from './db/level.js';
import { Feed } from './db/feed.js';
import { authMiddleware, setAuthConfig, setAuthDb, setConnectionStatus } from './auth/matrix.js';
import { registerHealthRoute, registerQueryRoutes } from './api/query.js';
import { registerWebhookRoutes } from './api/webhook.js';
import { registerOpsRoutes } from './api/ops.js';
import { registerSyncRoute } from './api/sync.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerIngestionRoutes } from './api/ingestion.js';
import { registerLogImportRoutes } from './api/log-import.js';
import { registerImportJobRoutes } from './api/import-jobs.js';
import { registerRoomSyncRoutes } from './api/room-sync.js';
import { registerDedupRoutes } from './api/dedup.js';
import { registerChatRoutes } from './api/chat.js';
import { ChatFeed } from './chat/feed.js';
import { configureMatrixDomain } from './config/matrix-domain.js';
import { RoomSyncCoordinator } from './ingestion/room-sync-coordinator.js';
import { MatrixConnectionMonitor } from './matrix/connection-resilience.js';
import { loadN8nConfig, configureN8nWebhook } from './n8n/config.js';
import { registerN8nRoutes } from './api/n8n-store.js';
import { registerCrystallizeRoutes } from './api/crystallize.js';
import { registerHealRoutes } from './api/heal.js';

const PORT = parseInt(process.env.EO_PORT || '3000', 10);
const DATA_DIR = process.env.EO_DATA_DIR || './data';
const HOMESERVER = process.env.EO_MATRIX_HOMESERVER || '';
const WEBHOOK_SECRET = process.env.EO_WEBHOOK_SECRET || '';
const WEBHOOK_USER = process.env.EO_WEBHOOK_USER || '';
const EVENT_PREFIX = process.env.EO_EVENT_PREFIX || '';
const DATA_ROOM_ALIAS = process.env.EO_DATA_ROOM_ALIAS || '';
const LOG_LEVEL = process.env.EO_LOG_LEVEL || 'info';

async function start(): Promise<void> {
  const app = Fastify({ logger: { level: LOG_LEVEL } });
  const db: EoDb = createDb(DATA_DIR);
  await db.open();
  const feed = new Feed();

  // Centralise domain config so every module reads from the same source
  configureMatrixDomain({
    homeserver: HOMESERVER || undefined,
    webhookUser: WEBHOOK_USER || undefined,
    eventPrefix: EVENT_PREFIX || undefined,
    dataRoomAlias: DATA_ROOM_ALIAS || undefined,
  });

  setAuthConfig({ homeserver: HOMESERVER, webhookSecret: WEBHOOK_SECRET, webhookUser: WEBHOOK_USER });
  setAuthDb(db);

  // CORS
  await app.register(cors, { origin: true });

  // Start connection health monitor
  let connectionMonitor: MatrixConnectionMonitor | undefined;
  if (HOMESERVER) {
    connectionMonitor = new MatrixConnectionMonitor(HOMESERVER);
    connectionMonitor.onStateChange((state) => {
      setConnectionStatus(state.status);
      app.log.info(`Matrix connection: ${state.status} (${state.reason})`);
    });
    connectionMonitor.start();
  }

  // Health endpoint (no auth)
  registerHealthRoute(app, db);

  // Auth proxy routes (login/whoami/profile — no EO auth required)
  registerAuthRoutes(app, HOMESERVER, DATA_DIR);

  // Chat feed — real-time pub/sub for space-agnostic chat messages
  const chatFeed = new ChatFeed();

  // Room sync coordinator — manages continuous Airtable sync per room
  const coordinator = new RoomSyncCoordinator(db, feed);

  // SyncManager (requires Matrix client) — when available, batch operations
  // use the media store instead of posting individual timeline events.
  // Set via coordinator.setSyncManager() and passed to routes below.
  // Currently undefined on the server; browser-side provides one.
  const syncManager = undefined;

  // WebSocket sync (has its own auth via query param)
  registerSyncRoute(app, db, feed, coordinator, chatFeed);

  // Auth-protected routes
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authMiddleware);
    registerWebhookRoutes(protectedApp, db, feed, syncManager);
    registerOpsRoutes(protectedApp, db, feed);
    registerQueryRoutes(protectedApp, db);
    registerAdminRoutes(protectedApp, db);
    registerIngestionRoutes(protectedApp, db, feed, syncManager);
    registerLogImportRoutes(protectedApp, db, feed, syncManager, DATA_DIR);
    registerImportJobRoutes(protectedApp, db, feed, DATA_DIR);
    registerRoomSyncRoutes(protectedApp, db, coordinator);
    registerDedupRoutes(protectedApp, db, feed);
    registerChatRoutes(protectedApp, db, chatFeed);
    registerN8nRoutes(protectedApp, db, feed);
    registerCrystallizeRoutes(protectedApp, db);
    registerHealRoutes(protectedApp, db, feed);
  });

  // Start the room sync coordinator after routes are registered
  await coordinator.start();

  // n8n Google Drive storage — optional, enabled when N8N_WEBHOOK_URL is set
  const n8nConfig = loadN8nConfig();
  if (n8nConfig) {
    configureN8nWebhook(n8nConfig);
    app.log.info(`n8n webhook configured → ${n8nConfig.baseUrl}${n8nConfig.webhookPath}`);
  }

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Shutting down...');
    connectionMonitor?.stop();
    coordinator.stop();
    await app.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`EO///DB listening on port ${PORT}`);
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
