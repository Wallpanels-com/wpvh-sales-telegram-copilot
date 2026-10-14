import cron from 'node-cron';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { BriefingService } from './briefing.js';
import { canDeliverToTelegram } from './delivery-policy.js';
import { EventProcessor } from './processor.js';
import { TelegramClient } from './telegram.js';

export class SchedulerService {
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
    cron.schedule(expression, () => void this.sendDailyBriefs(), { timezone: this.config.TIMEZONE });
    cron.schedule('*/2 * * * *', () => void this.processor.deliverDeferredNow(), { timezone: this.config.TIMEZONE });
    this.logger.info({ expression, timezone: this.config.TIMEZONE }, 'scheduler started');
  }

  async sendDailyBriefs() {
    if (this.config.TELEGRAM_DELIVERY_MODE === 'disabled') return;
    const now = new Date();
    const jsDay = now.toLocaleDateString('en-US', { weekday: 'short', timeZone: this.config.TIMEZONE });
    const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    if (!this.config.workDays.has(map[jsDay] ?? 0)) return;

    const sales = await this.briefing.allSales();
    for (const user of sales) {
      if (!canDeliverToTelegram(this.config, user.telegramUserId)) continue;
      try {
        const brief = await this.briefing.forSales(user);
        await this.telegram.sendMessage({ chatId: user.telegramUserId, text: brief.text });
        for (const adminId of this.config.adminTelegramUserIds) {
          if (adminId === user.telegramUserId) continue;
          if (!canDeliverToTelegram(this.config, adminId)) continue;
          await this.telegram.sendMessage({ chatId: adminId, text: brief.text });
        }
      } catch (error) {
        this.logger.error({ salesUser: user.name, err: error instanceof Error ? error.message : String(error) }, 'daily brief failed');
      }
    }
  }
}
