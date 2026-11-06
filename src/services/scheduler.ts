import cron from 'node-cron';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { BriefingService } from './briefing.js';
import { canDeliverToTelegram } from './delivery-policy.js';
import { EventProcessor } from './processor.js';
import { TelegramClient } from './telegram.js';
import { auditRef, safeErrorMessage } from '../security.js';

export class SchedulerService {
  private readonly tasks: ReturnType<typeof cron.schedule>[] = [];
  private briefingRunning = false;
  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly telegram: TelegramClient,
    private readonly briefing: BriefingService,
    private readonly processor: EventProcessor,
    private readonly logger: { info: Function; warn: Function; error: Function }
  ) {}

  start() {
    const [hour, minute] = this.config.DAILY_BRIEF_TIME.split(':').map(Number);
    const expression = `${minute ?? 45} ${hour ?? 8} * * *`;
    this.tasks.push(cron.schedule(expression, () => this.sendDailyBriefs().catch((error) => {
      this.logger.error({ error: safeErrorMessage(error) }, 'daily briefing schedule failed');
    }), { timezone: this.config.TIMEZONE }));
    this.tasks.push(cron.schedule('*/2 * * * *', () => this.processor.deliverDeferredNow().catch((error) => {
      this.logger.error({ error: safeErrorMessage(error) }, 'deferred schedule failed');
    }), { timezone: this.config.TIMEZONE }));
    this.logger.info({ expression, timezone: this.config.TIMEZONE }, 'scheduler started');
  }

  stop() {
    for (const task of this.tasks) void task.stop();
  }

  async sendDailyBriefs() {
    if (this.briefingRunning || this.config.TELEGRAM_DELIVERY_MODE === 'disabled') return;
    const now = new Date();
    const jsDay = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: this.config.TIMEZONE });
    const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    if (!this.config.workDays.has(map[jsDay] ?? 0)) return;

    this.briefingRunning = true;
    try {
    const sales = await this.briefing.allSales();
    for (const user of sales) {
      const recipients = [...new Set([user.telegramUserId, ...this.config.adminTelegramUserIds])]
        .filter((id) => canDeliverToTelegram(this.config, id));
      if (!recipients.length) continue;
      try {
        const brief = await this.briefing.forSales(user);
        for (const recipient of recipients) {
          try {
            await this.telegram.sendMessage({ chatId: recipient, text: brief.text });
          } catch (error) {
            this.logger.error({ recipientRef: auditRef(recipient), error: safeErrorMessage(error) }, 'daily brief delivery failed');
          }
        }
      } catch (error) {
        this.logger.error({ salesRef: auditRef(user.id), error: safeErrorMessage(error) }, 'daily brief failed');
      }
    }
    } finally {
      this.briefingRunning = false;
    }
  }
}
