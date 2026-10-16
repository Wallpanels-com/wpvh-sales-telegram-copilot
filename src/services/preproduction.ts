import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { auditRef, safeErrorMessage } from '../security.js';
import { GhlClient } from './ghl.js';
import { TelegramClient } from './telegram.js';

export async function runPreProductionChecks(
  config: AppConfig,
  db: Db,
  ghl: GhlClient,
  telegram: TelegramClient,
  logger: { info: Function; warn: Function }
) {
  const trackedSalesIds = config.productionSalesGhlIds?.size
    ? config.productionSalesGhlIds
    : config.shadowTestSalesGhlIds;
  const [salesUsers, bot, webhook, workflowResult] = await Promise.all([
    db.listSalesUsers(),
    settle(() => telegram.getMe()),
    settle(() => telegram.getWebhookInfo()),
    settle(() => ghl.getWorkflows('wp'))
  ]);

  const recipients = salesUsers.filter((user) => (
    config.adminTelegramUserIds.includes(user.telegramUserId)
    || Boolean(user.wpGhlUserId && trackedSalesIds.has(user.wpGhlUserId))
  ));
  const recipientChecks = await Promise.all(recipients.map(async (user) => {
    const check = await settle(() => telegram.getChat(user.telegramUserId));
    return {
      recipientRef: auditRef(user.telegramUserId),
      admin: config.adminTelegramUserIds.includes(user.telegramUserId),
      trackedSales: Boolean(user.wpGhlUserId && trackedSalesIds.has(user.wpGhlUserId)),
      reachable: check.ok
    };
  }));

  const workflowChecks = workflowResult.ok
    ? workflowResult.value
      .filter((workflow: any) => /copilot|customer replied|transcript|task reminder|appointment reminder|meeting brief/i.test(String(workflow?.name ?? '')))
      .slice(0, 50)
      .map((workflow: any) => ({ name: String(workflow?.name ?? ''), status: String(workflow?.status ?? 'unknown') }))
    : [];
  const expectedTelegramWebhook = config.PUBLIC_BASE_URL
    ? `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/telegram`
    : '';
  const webhookUrl = webhook.ok ? String(webhook.value?.url ?? '') : '';

  const report = {
    telegram: {
      botReachable: bot.ok,
      webhookActive: webhook.ok && Boolean(webhookUrl) && (!expectedTelegramWebhook || webhookUrl === expectedTelegramWebhook),
      pendingUpdates: webhook.ok ? Number(webhook.value?.pending_update_count ?? 0) : null,
      recipients: recipientChecks
    },
    highLevel: {
      workflowReadAvailable: workflowResult.ok,
      workflows: workflowChecks
    }
  };
  logger.info(report, 'pre-production read-only checks completed');
  if (!bot.ok || !webhook.ok || !workflowResult.ok || recipientChecks.some((recipient) => !recipient.reachable)) {
    logger.warn({
      telegramBotError: bot.ok ? undefined : bot.error,
      telegramWebhookError: webhook.ok ? undefined : webhook.error,
      workflowReadError: workflowResult.ok ? undefined : workflowResult.error,
      unreachableRecipientRefs: recipientChecks.filter((recipient) => !recipient.reachable).map((recipient) => recipient.recipientRef)
    }, 'pre-production checks need attention');
  }
  return report;
}

async function settle<T>(operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error: safeErrorMessage(error) };
  }
}
