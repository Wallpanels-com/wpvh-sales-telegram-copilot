import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { AiService } from '../services/ai.js';
import { BriefingService } from '../services/briefing.js';
import { ContextService } from '../services/context.js';
import { GhlClient } from '../services/ghl.js';
import { canTelegramUserAccessCard } from '../services/recipients.js';
import { canDeliverToTelegram } from '../services/delivery-policy.js';
import { TelegramClient } from '../services/telegram.js';
import { escapeHtml } from '../utils/html.js';

export async function registerTelegramRoute(
  app: FastifyInstance,
  config: AppConfig,
  db: Db,
  telegram: TelegramClient,
  ai: AiService,
  contextService: ContextService,
  ghl: GhlClient,
  briefing: BriefingService
) {
  app.post('/webhooks/telegram', async (request, reply) => {
    const secret = String(request.headers['x-telegram-bot-api-secret-token'] ?? '');
    if (secret !== config.TELEGRAM_WEBHOOK_SECRET) {
      return reply.code(401).send({ ok: false });
    }
    const update = request.body as any;
    const actorId = String(update?.callback_query?.from?.id ?? update?.message?.from?.id ?? '');
    if (!actorId || !canDeliverToTelegram(config, actorId)) {
      return reply.code(200).send({ ok: true });
    }
    // Ack quickly; processing is lightweight and Telegram retries on transport failure.
    void handleUpdate(update).catch((err) => app.log.error({ err }, 'telegram update failed'));
    return reply.code(200).send({ ok: true });
  });

  async function handleUpdate(update: any) {
    if (update?.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }
    if (update?.message?.text) {
      await handleCommand(update.message);
    }
  }

  async function handleCommand(message: any) {
    const chatId = String(message.chat?.id ?? '');
    const fromId = String(message.from?.id ?? '');
    if (!chatId || !fromId) return;
    const text = String(message.text ?? '').trim().split(/\s+/)[0]?.toLowerCase();
    const user = await db.getSalesByTelegramId(fromId);
    const isAdmin = config.adminTelegramUserIds.includes(fromId) || user?.isAdmin;
    if (!user && !isAdmin) {
      await telegram.sendMessage({ chatId, text: '⛔️ This Telegram account is not authorized for WP/VH Sales Copilot.' });
      return;
    }

    if (text === '/start' || text === '/help') {
      await telegram.sendMessage({
        chatId,
        text: [
          '<b>WP/VH AI Sales Copilot</b>',
          '',
          'I notify you when an assigned client replies, prepare an AI reply, summarize calls and show today’s tasks.',
          '',
          '<b>Commands</b>',
          '/today — tasks, calls and meetings for today',
          '/status — service status',
          '/help — this message',
          '',
          'HighLevel remains the CRM. This bot does not send messages to clients.'
        ].join('\n')
      });
      return;
    }

    if (text === '/status') {
      await telegram.sendMessage({ chatId, text: '✅ <b>WP/VH Sales Copilot is online</b>\nCRM access: read-only\nClient auto-send: disabled' });
      return;
    }

    if (text === '/today') {
      if (isAdmin) {
        const sales = await briefing.allSales();
        if (!sales.length) {
          await telegram.sendMessage({ chatId, text: 'No active sales mappings found.' });
          return;
        }
        for (const salesUser of sales) {
          const brief = await briefing.forSales(salesUser);
          await telegram.sendMessage({ chatId, text: brief.text });
        }
      } else if (user) {
        const brief = await briefing.forSales(user);
        await telegram.sendMessage({ chatId, text: brief.text });
      }
      return;
    }
  }

  async function handleCallback(query: any) {
    const id = String(query.id ?? '');
    const fromId = String(query.from?.id ?? '');
    const chatId = String(query.message?.chat?.id ?? fromId);
    const data = String(query.data ?? '');
    const match = data.match(/^card:([0-9a-f-]{36}):(shorter|friendlier|rewrite)$/i);
    if (!match) {
      await telegram.answerCallbackQuery(id, 'Unknown action');
      return;
    }
    const [, cardId, mode] = match;
    const card = await db.getCard(cardId!);
    if (!card || !(await canTelegramUserAccessCard(config, db, fromId, card))) {
      await telegram.answerCallbackQuery(id, 'Not authorized', true);
      return;
    }
    if (!card.suggested_reply) {
      await telegram.answerCallbackQuery(id, 'No draft available');
      return;
    }

    await telegram.answerCallbackQuery(id, 'Generating…');
    const brand = String(card.brand) as 'wp' | 'vh';
    const context = await contextService.build({
      brand,
      contactId: String(card.contact_id),
      conversationId: card.conversation_id ? String(card.conversation_id) : undefined,
      messageId: card.message_id ? String(card.message_id) : undefined
    });
    const lessons = await db.getLessons(fromId);
    const rewritten = await ai.rewriteText(
      String(card.suggested_reply),
      mode === 'shorter' ? 'shorter' : mode === 'friendlier' ? 'friendlier' : 'rewrite',
      context,
      lessons
    );
    const label = mode === 'shorter' ? 'Shorter' : mode === 'friendlier' ? 'Friendlier' : 'Rewrite';
    await telegram.sendMessage({
      chatId,
      text: `✨ <b>${escapeHtml(label)}</b>\n\n${escapeHtml(rewritten)}`,
      keyboard: [
        [{ text: '📋 Copy', copy_text: { text: rewritten } }],
        [{ text: '↗️ Open in GHL', url: ghl.contactUrl(String(card.location_id), String(card.contact_id)) }]
      ]
    });
  }
}
