import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createDb, type EoDb } from './db/level.js';
import { Feed } from './db/feed.js';
import { authMiddleware, setAuthConfig, setAuthDb } from './auth/matrix.js';
import { registerHealthRoute, registerQueryRoutes } from './api/query.js';
import { registerWebhookRoutes } from './api/webhook.js';
import { registerOpsRoutes } from './api/ops.js';
import { registerSyncRoute } from './api/sync.js';
import { registerAdminRoutes } from './api/admin.js';
import { registerAuthRoutes } from './api/auth.js';

const PORT = parseInt(process.env.EO_PORT || '3000', 10);
const DATA_DIR = process.env.EO_DATA_DIR || './data';
const HOMESERVER = process.env.EO_MATRIX_HOMESERVER || 'https://app.aminoimmigration.com';
const WEBHOOK_SECRET = process.env.EO_WEBHOOK_SECRET || '';
const LOG_LEVEL = process.env.EO_LOG_LEVEL || 'info';

async function start(): Promise<void> {
  const app = Fastify({ logger: { level: LOG_LEVEL } });
  const db: EoDb = createDb(DATA_DIR);
  await db.open();
  const feed = new Feed();

  setAuthConfig({ homeserver: HOMESERVER, webhookSecret: WEBHOOK_SECRET });
  setAuthDb(db);

  // CORS
  await app.register(cors, { origin: true });

  // Health endpoint (no auth)
  registerHealthRoute(app, db);

  // Auth proxy routes (login/whoami/profile — no EO auth required)
  registerAuthRoutes(app, HOMESERVER);

  // WebSocket sync (has its own auth via query param)
  registerSyncRoute(app, db, feed);

  // Auth-protected routes
  app.register(async (protectedApp) => {
    protectedApp.addHook('preHandler', authMiddleware);
    registerWebhookRoutes(protectedApp, db, feed);
    registerOpsRoutes(protectedApp, db, feed);
    registerQueryRoutes(protectedApp, db);
    registerAdminRoutes(protectedApp, db);
  });

  // Graceful shutdown
  const shutdown = async () => {
    app.log.info('Shutting down...');
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
