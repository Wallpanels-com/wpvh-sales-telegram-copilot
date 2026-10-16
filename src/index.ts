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
import { runPreProductionChecks } from './services/preproduction.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerHighLevelRoutes } from './routes/highlevel.js';
import { registerTelegramRoute } from './routes/telegram.js';
import { redactUrl, safeErrorMessage } from './security.js';

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-webhook-secret"]',
        'req.headers["x-telegram-bot-api-secret-token"]', 'headers.authorization', 'authorization',
        '*.apiKey', '*.token', '*.secret', '*.transcript', '*.messages'
      ],
      censor: '[REDACTED]'
    },
    serializers: {
      req(request: any) {
        return {
          method: request.method,
          url: redactUrl(String(request.url ?? '')),
          host: request.headers?.host,
          remoteAddress: request.socket?.remoteAddress,
          remotePort: request.socket?.remotePort
        };
      }
    }
  },
  bodyLimit: 1024 * 1024,
  requestTimeout: 15_000,
  connectionTimeout: 10_000,
  keepAliveTimeout: 72_000
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

app.addHook('onSend', async (_request, reply, payload) => {
  reply
    .header('x-content-type-options', 'nosniff')
    .header('x-frame-options', 'DENY')
    .header('referrer-policy', 'no-referrer')
    .header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
    .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
    .header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    .header('cache-control', 'no-store');
  return payload;
});

app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ ok: false, error: 'not_found' }));

app.setErrorHandler(async (error, request, reply) => {
  const typedError = error as Error & { statusCode?: number };
  const status = Number(typedError.statusCode ?? 500);
  const safeStatus = [400, 401, 403, 404, 413, 429].includes(status) ? status : 500;
  if (safeStatus >= 500) {
    request.log.error({ error: safeErrorMessage(typedError), errorType: typedError.name }, 'request failed');
  }
  const code = safeStatus === 413 ? 'payload_too_large'
    : safeStatus === 429 ? 'rate_limited'
      : safeStatus >= 500 ? 'internal_error' : 'invalid_request';
  return reply.code(safeStatus).send({ ok: false, error: code });
});

app.get('/', async () => ({
  service: 'WP/VH AI Sales Telegram Copilot',
  ok: true,
  highLevelWriteAccess: false
}));

app.addHook('onReady', async () => {
  await db.recoverStuckWork();
  await runPreProductionChecks(config, db, ghl, telegram, app.log);
  if (config.AI_VALIDATE_ON_STARTUP) {
    try {
      await ai.validateConnection();
      app.log.info({ provider: config.AI_PROVIDER, model: config.aiModel }, 'AI provider validation succeeded');
    } catch (error) {
      app.log.error({ provider: config.AI_PROVIDER, model: config.aiModel, error: safeErrorMessage(error) }, 'AI provider validation failed');
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
