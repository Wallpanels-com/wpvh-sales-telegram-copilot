import { DateTime } from 'luxon';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { BrandKey, GhlMessage } from '../types.js';
import { GhlClient } from './ghl.js';
import { normalizeWebhook } from './webhook-normalizer.js';
import { canonicalWebhookPayload } from './webhook-normalizer.js';
import { safeErrorMessage } from '../security.js';

export class GhlPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly ghl: GhlClient,
    private readonly logger: { info: Function; warn: Function; error: Function }
  ) {}

  start() {
    if (!this.config.POLLING_ENABLED || this.timer) return;
    const ms = this.config.POLLING_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const brand of ['wp', 'vh'] as BrandKey[]) {
        for (const channel of this.config.pollingChannels) {
          try {
            await this.pollChannel(brand, channel);
          } catch (error) {
            this.logger.error({ brand, channel, error: safeErrorMessage(error) }, 'poll channel failed');
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async pollChannel(brand: BrandKey, channel: string) {
    const key = `messages:${brand}:${channel}`;
    const checkpoint = await this.db.getCheckpoint(key);
    const now = DateTime.utc();
    const start = checkpoint
      ? DateTime.fromISO(checkpoint, { zone: 'utc' }).minus({ minutes: 2 })
      : now.minus({ minutes: this.config.POLLING_LOOKBACK_MINUTES });

    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.ghl.exportMessages(brand, {
        channel,
        startDate: start.toISO()!,
        endDate: now.toISO()!,
        limit: 1000,
        sortOrder: 'asc',
        cursor
      });
      for (const message of result.messages) {
        await this.enqueueMessage(brand, channel, message);
      }
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
      if (page === 9) throw new Error(`HighLevel export exceeded 10 pages for ${brand}/${channel}; checkpoint not advanced`);
    }
    await this.db.setCheckpoint(key, now.toISO()!);
  }

  private async enqueueMessage(brand: BrandKey, channel: string, message: GhlMessage) {
    if (!message.id || !message.contactId) return;
    const locationId = this.ghl.locationId(brand);
    if (channel.toLowerCase() === 'call' || String(message.messageType).toUpperCase().includes('CALL')) {
      const n = normalizeWebhook('poll_call', {
        locationId,
        contactId: message.contactId,
        conversationId: message.conversationId,
        messageId: message.id,
        timestamp: message.dateAdded
      });
      await this.db.enqueueEvent({ eventKey: n.eventKey, source: 'poller', kind: 'poll_call', payload: canonicalWebhookPayload(n) });
      return;
    }

    if (message.direction !== 'inbound') return;
    const n = normalizeWebhook('poll_message', {
      locationId,
      contactId: message.contactId,
      conversationId: message.conversationId,
      messageId: message.id,
      timestamp: message.dateAdded
    });
    await this.db.enqueueEvent({ eventKey: n.eventKey, source: 'poller', kind: 'poll_message', payload: canonicalWebhookPayload(n) });
  }
}
