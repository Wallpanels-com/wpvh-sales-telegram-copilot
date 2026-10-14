import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { AiService } from './services/ai.js';
import { BriefingService } from './services/briefing.js';
import { ContextService } from './services/context.js';
import { GhlClient } from './services/ghl.js';
import { GhlPoller } from './services/poller.js';
import { EventProcessor } from './services/processor.js';
import { SchedulerService } from './services/scheduler.js';
import { TelegramClient } from './services/telegram.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHighLevelRoutes } from './routes/highlevel.js';
import { registerTelegramRoute } from './routes/telegram.js';

const config = loadConfig();
const app = Fastify({
  logger: { level: config.LOG_LEVEL },
  bodyLimit: 2 * 1024 * 1024
});

const db = createDb(config);
const ghl = new GhlClient(config);
const telegram = new TelegramClient(config);
const ai = new AiService(config);
const contextService = new ContextService(ghl, db);
const briefing = new BriefingService(config, db, ghl);
const processor = new EventProcessor(config, db, ghl, telegram, ai, contextService, app.log);
const poller = new GhlPoller(config, db, ghl, app.log);
const scheduler = new SchedulerService(config, db, telegram, briefing, processor, app.log);

await registerHealthRoutes(app, db);
await registerHighLevelRoutes(app, config, db);
await registerTelegramRoute(app, config, db, telegram, ai, contextService, ghl, briefing);

app.get('/', async () => ({
  service: 'WP/VH AI Sales Telegram Copilot',
  ok: true,
  highLevelWriteAccess: false,
  automationEnabled: config.AUTOMATION_ENABLED,
  telegramDeliveryMode: config.TELEGRAM_DELIVERY_MODE,
  pollingFallback: config.POLLING_ENABLED
}));

app.addHook('onReady', async () => {
  await db.recoverStuckWork();
  if (config.AI_VALIDATE_ON_STARTUP) {
    try {
      await ai.validateConnection();
      app.log.info({ provider: config.AI_PROVIDER, model: config.aiModel }, 'AI provider validation succeeded');
    } catch (error) {
      app.log.error({ provider: config.AI_PROVIDER, model: config.aiModel, err: error instanceof Error ? error.message : String(error) }, 'AI provider validation failed');
    }
  }
  if (!config.AUTOMATION_ENABLED) {
    app.log.warn('automation is disabled; webhook ingestion remains available');
    return;
  }
  processor.start();
  poller.start();
  scheduler.start();
  app.log.info({ polling: config.POLLING_ENABLED, timezone: config.TIMEZONE }, 'background services started');
});

app.addHook('onClose', async () => {
  poller.stop();
  processor.stop();
});

await app.listen({ port: config.PORT, host: '0.0.0.0' });
