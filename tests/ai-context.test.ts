import { describe, expect, it } from 'vitest';
import { buildReplyPrompt, estimateTokens, getRateLimitBackoffMs } from '../src/services/ai.js';
import { canDeliverToTelegram, prependShadowTestPrefix, shouldProcessAssignedSales } from '../src/services/delivery-policy.js';
import type { AppConfig } from '../src/config.js';
import type { ClientContext } from '../src/types.js';

function context(): ClientContext {
  return {
    brand: 'wp',
    brandLabel: 'WallPanels',
    locationId: 'loc',
    contactId: 'contact',
    contactName: 'Client Name',
    companyName: 'Client Company',
    email: 'client@example.com',
    phone: '+15550000000',
    assignedGhlUserId: 'ghl-user',
    assignedSalesName: 'Assigned Sales',
    opportunity: {
      id: 'opp', name: 'Living room project', status: 'open', pipelineId: 'pipeline', pipelineStageId: 'stage'
    },
    pipelineName: 'Residential',
    stageName: 'Consultation',
    recentMessages: Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      direction: index % 2 ? 'inbound' : 'outbound',
      body: `message-${index}`,
      dateAdded: `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00Z`
    })),
    openTasks: [{ id: 'task', title: 'Send samples', dueDate: '2026-10-20T12:00:00Z', completed: false }],
    nextAppointment: { id: 'appt', title: 'Showroom visit', startTime: '2026-10-21T14:00:00Z' },
    relationshipSummary: 'Returning client renovating a living room.',
    lastCallSummary: 'Client asked about acoustic panels.',
    importantFacts: ['Prefers walnut finish'],
    objections: ['Concerned about installation time'],
    commitments: ['Sales will send samples'],
    nextSteps: ['Confirm showroom appointment'],
    triggerMessage: { id: 'm19', direction: 'inbound', body: 'Can we meet Tuesday?' }
  };
}

describe('AI context layer', () => {
  it('includes every required context source and only the latest 15 messages', () => {
    const prompt = buildReplyPrompt(context(), ['Never invent availability'], 240);
    expect(prompt).toContain('CONTACT:');
    expect(prompt).toContain('OPPORTUNITY:');
    expect(prompt).toContain('pipeline: Residential');
    expect(prompt).toContain('stage: Consultation');
    expect(prompt).toContain('Assigned Sales');
    expect(prompt).toContain('RELATIONSHIP SUMMARY:');
    expect(prompt).toContain('LAST RELEVANT CALL SUMMARY:');
    expect(prompt).toContain('IMPORTANT CLIENT FACTS:');
    expect(prompt).toContain('OBJECTIONS:');
    expect(prompt).toContain('COMMITMENTS:');
    expect(prompt).toContain('NEXT STEPS:');
    expect(prompt).toContain('OPEN TASKS:');
    expect(prompt).toContain('NEAREST APPOINTMENT:');
    expect(prompt).toContain('message-19');
    expect(prompt).toContain('message-5');
    expect(prompt).not.toContain('message-4');
    expect(estimateTokens(prompt)).toBeLessThan(2500);
  });

  it('respects Retry-After and exponential backoff', () => {
    const rateLimit = { status: 429, headers: { get: () => '2' } };
    expect(getRateLimitBackoffMs(rateLimit, 0, 1000)).toBe(2000);
    expect(getRateLimitBackoffMs({ status: 429 }, 3, 1000)).toBe(8000);
  });
});

describe('Telegram delivery policy', () => {
  it('keeps delivery disabled until explicitly allowlisted', () => {
    const disabled = { TELEGRAM_DELIVERY_MODE: 'disabled', telegramAllowedUserIds: new Set(['1']) } as AppConfig;
    const allowlist = { TELEGRAM_DELIVERY_MODE: 'allowlist', telegramAllowedUserIds: new Set(['1']) } as AppConfig;
    expect(canDeliverToTelegram(disabled, '1')).toBe(false);
    expect(canDeliverToTelegram(allowlist, '1')).toBe(true);
    expect(canDeliverToTelegram(allowlist, '2')).toBe(false);
  });

  it('routes an active shadow test only to its single recipient and scoped Assigned Users', () => {
    const shadow = {
      SHADOW_TEST_ENABLED: true,
      SHADOW_TEST_RECIPIENT_TELEGRAM_ID: 'dmitry',
      SHADOW_TEST_SALES_GHL_IDS: 'mary,anton',
      SHADOW_TEST_UNTIL: '',
      shadowTestSalesGhlIds: new Set(['mary', 'anton']),
      TELEGRAM_DELIVERY_MODE: 'all',
      telegramAllowedUserIds: new Set(['kate', 'mary-tg', 'anton-tg'])
    } as unknown as AppConfig;

    expect(shouldProcessAssignedSales(shadow, 'mary')).toBe(true);
    expect(shouldProcessAssignedSales(shadow, 'anton')).toBe(true);
    expect(shouldProcessAssignedSales(shadow, 'kate')).toBe(false);
    expect(canDeliverToTelegram(shadow, 'dmitry')).toBe(true);
    expect(canDeliverToTelegram(shadow, 'mary-tg')).toBe(false);
    expect(canDeliverToTelegram(shadow, 'anton-tg')).toBe(false);
    expect(canDeliverToTelegram(shadow, 'kate')).toBe(false);
    expect(prependShadowTestPrefix(shadow, 'card', 'Mary Razumna')).toBe('[SHADOW TEST — Mary Razumna]\ncard');
  });

  it('fails closed when a configured shadow test has expired', () => {
    const expired = {
      SHADOW_TEST_ENABLED: true,
      SHADOW_TEST_RECIPIENT_TELEGRAM_ID: 'dmitry',
      SHADOW_TEST_UNTIL: '2020-01-01T00:00:00Z',
      shadowTestSalesGhlIds: new Set(['mary'])
    } as unknown as AppConfig;
    expect(shouldProcessAssignedSales(expired, 'mary')).toBe(false);
    expect(canDeliverToTelegram(expired, 'dmitry')).toBe(false);
  });
});
