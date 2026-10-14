import { describe, expect, it } from 'vitest';
import { normalizeWebhook } from '../src/services/webhook-normalizer.js';

describe('normalizeWebhook', () => {
  it('extracts common ids from nested payload', () => {
    const n = normalizeWebhook('customer_replied', {
      location: { id: 'loc1' },
      contact: { id: 'c1' },
      message: { id: 'm1', conversationId: 'conv1' },
      webhookId: 'w1'
    });
    expect(n.locationId).toBe('loc1');
    expect(n.contactId).toBe('c1');
    expect(n.messageId).toBe('m1');
    expect(n.conversationId).toBe('conv1');
    expect(n.eventKey.startsWith('customer_replied:')).toBe(true);
  });

  it('creates stable event key', () => {
    const a = normalizeWebhook('task_reminder', { locationId: 'x', contactId: 'y', id: 'same' });
    const b = normalizeWebhook('task_reminder', { locationId: 'x', contactId: 'y', id: 'same' });
    expect(a.eventKey).toBe(b.eventKey);
  });
});
