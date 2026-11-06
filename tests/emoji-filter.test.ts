import { describe, expect, it, vi } from 'vitest';
import { isEmojiOnlyMessage } from '../src/utils/emoji.js';
import { EventProcessor } from '../src/services/processor.js';

describe('emoji-only notification filter', () => {
  it.each(['🔥', '🙏', '👍🏽', '❤️', '👨‍👩‍👧‍👦', '🇺🇸', '1️⃣', '#️⃣', '🔥 🙏\n❤️', '🏳️‍🌈', '🫶'])('ignores %s', (body) => {
    expect(isEmojiOnlyMessage({ id: 'message', body })).toBe(true);
  });

  it.each(['Thank you 🙏', '🔥 How much?', '530', '1', '#', '*', '', '   ', 'OK', '👍?', 'www.example.com'])('preserves non-emoji-only content: %s', (body) => {
    expect(isEmojiOnlyMessage({ id: 'message', body })).toBe(false);
  });

  it('preserves attachments with an emoji caption', () => {
    expect(isEmojiOnlyMessage({ id: 'message', body: '🔥', attachments: ['photo.jpg'] })).toBe(false);
  });

  function harness(body: string) {
    const message = { id: 'message', body, direction: 'inbound', contactId: 'contact', messageType: 'TYPE_SMS' };
    const db = { markMessageProcessed: vi.fn(async () => true), getLessons: vi.fn(async () => []), unmarkMessageProcessed: vi.fn() };
    const ghl = { brandFromLocation: () => 'wp', locationId: () => 'wp-location', getMessage: vi.fn(async () => message) };
    const context = { build: vi.fn(async () => ({ brand: 'wp', locationId: 'wp-location', contactId: 'contact',
      assignedGhlUserId: 'mary', recentMessages: [message], triggerMessage: message })) };
    const ai = { analyzeReply: vi.fn(async () => { throw new Error('analysis reached'); }) };
    const telegram = { sendMessage: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processor = new EventProcessor({ SHADOW_TEST_ENABLED: false } as any, db as any,
      ghl as any, telegram as any, ai as any, context as any, logger);
    return { processor, db, ghl, context, ai, telegram };
  }

  it('skips an identified emoji message before CRM context and AI', async () => {
    const h = harness('🔥');
    await h.processor.processEvent('customer_replied', { locationId: 'wp-location', contactId: 'contact', messageId: 'message' });
    expect(h.context.build).not.toHaveBeenCalled();
    expect(h.db.markMessageProcessed).toHaveBeenCalledWith('wp-location', 'message', 'inbound', 'TYPE_SMS');
    expect(h.ai.analyzeReply).not.toHaveBeenCalled();
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('also skips native webhooks that omit messageId', async () => {
    const h = harness('🙏❤️');
    await h.processor.processEvent('customer_replied', { locationId: 'wp-location', contactId: 'contact' });
    expect(h.context.build).toHaveBeenCalledTimes(1);
    expect(h.ai.analyzeReply).not.toHaveBeenCalled();
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps text with emoji eligible for AI processing', async () => {
    const h = harness('Thanks 🙏 What is the price?');
    await expect(h.processor.processEvent('customer_replied', { locationId: 'wp-location', contactId: 'contact' }))
      .rejects.toThrow('analysis reached');
    expect(h.ai.analyzeReply).toHaveBeenCalledTimes(1);
  });
});
