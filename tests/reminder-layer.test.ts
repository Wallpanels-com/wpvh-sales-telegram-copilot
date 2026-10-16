import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { ClientContext } from '../src/types.js';
import { EventProcessor } from '../src/services/processor.js';

function shadowConfig(): AppConfig {
  return {
    GHL_WP_LOCATION_ID: 'wp-location',
    GHL_VH_LOCATION_ID: 'vh-location',
    SHADOW_TEST_ENABLED: true,
    SHADOW_TEST_RECIPIENT_TELEGRAM_ID: 'dmitry',
    SHADOW_TEST_UNTIL: '',
    SHADOW_TEST_STARTED_AT: '2026-10-16T00:00:00.000Z',
    TELEGRAM_DELIVERY_MODE: 'disabled',
    TIMEZONE: 'America/New_York',
    WORK_START: '00:00',
    WORK_END: '23:59',
    shadowTestSalesGhlIds: new Set(['mary-ghl', 'anton-ghl']),
    shadowTestLocationIds: new Set(['wp-location']),
    shadowTestSalesLabels: new Map([['mary-ghl', 'Mary'], ['anton-ghl', 'Anton']]),
    telegramAllowedUserIds: new Set(),
    adminTelegramUserIds: ['kate'],
    workDays: new Set([1, 2, 3, 4, 5, 6, 7])
  } as AppConfig;
}

function context(): ClientContext {
  return {
    brand: 'wp',
    brandLabel: 'WallPanels',
    locationId: 'wp-location',
    contactId: 'contact-1',
    contactName: 'John Smith',
    assignedGhlUserId: 'mary-ghl',
    opportunity: { id: 'opportunity-1', assignedTo: 'mary-ghl' },
    pipelineName: 'Sales',
    stageName: 'Qualified Lead',
    recentMessages: [{ id: 'message-1', direction: 'inbound', body: 'Can we review the estimate tomorrow?' }],
    openTasks: [],
    relationshipSummary: 'Client is waiting for updated installation pricing.',
    lastCallSummary: 'Maria promised to follow up today.',
    importantFacts: ['Interested in walnut wall panels'],
    objections: ['Timing'],
    commitments: ['Send revised estimate'],
    nextSteps: ['Confirm installation scope']
  };
}

function harness() {
  const sendMessage = vi.fn(async (_input: any) => ({ message_id: 123 }));
  const createCard = vi.fn(async () => 'card-1');
  const db = {
    getSalesByGhlUserId: vi.fn(async () => ({
      id: 'sales-1', name: 'Mary Razumna', telegramUserId: 'mary-telegram',
      wpGhlUserId: 'mary-ghl', vhGhlUserId: null, isAdmin: false, active: true
    })),
    createCard,
    recordDelivery: vi.fn(async () => undefined),
    getLatestCallContext: vi.fn(async () => ({ client_needs: ['Updated installation pricing'] }))
  };
  const ghl = {
    brandFromLocation: vi.fn((locationId: string) => locationId === 'wp-location' ? 'wp' : null),
    locationId: vi.fn(() => 'wp-location'),
    brandLabel: vi.fn(() => 'WallPanels'),
    contactUrl: vi.fn((_locationId: string, contactId: string) => `https://app.gohighlevel.com/contact/${contactId}`),
    getTasks: vi.fn(async (): Promise<any[]> => [{
      id: 'task-1', title: 'Call client about updated estimate',
      body: 'Confirm the installation price', dueDate: '2025-10-16T19:00:00.000Z', completed: false
    }]),
    getTask: vi.fn(),
    getAppointment: vi.fn(async () => ({
      id: 'appointment-1', calendarId: 'calendar-1', title: 'Estimate review',
      startTime: new Date(Date.now() + 60 * 60_000).toISOString(), status: 'confirmed'
    })),
    getCalendar: vi.fn(async () => ({ id: 'calendar-1', name: 'WallPanels Sales Calls' }))
  };
  const contextService = { build: vi.fn(async () => context()) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = new EventProcessor(
    shadowConfig(), db as any, ghl as any, { sendMessage } as any, {} as any, contextService as any, logger
  );
  return { processor, sendMessage, createCard, db, ghl };
}

describe('Task and appointment reminder layer', () => {
  it('sends a due task card only to Dmitry in shadow mode', async () => {
    const { processor, sendMessage, createCard } = harness();

    await processor.processEvent('task_reminder', {
      locationId: 'wp-location', contactId: 'contact-1', dueDate: '2025-10-16T19:00:00.000Z'
    }, 'test');

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as any;
    expect(sent.chatId).toBe('dmitry');
    expect(sent.text).toContain('[SHADOW TEST — Mary]');
    expect(sent.text).toContain('TASK OVERDUE');
    expect(sent.text).toContain('Call client about updated estimate');
    expect(sent.text).toContain('Maria promised to follow up today');
    expect(sent.keyboard[0][0].text).toContain('Open in GHL');
    expect(createCard).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task', assignedGhlUserId: 'mary-ghl' }));
  });

  it('builds a one-hour meeting briefing and sends it only to Dmitry', async () => {
    const { processor, sendMessage, createCard, ghl } = harness();

    await processor.processEvent('appointment_reminder', {
      locationId: 'wp-location', contactId: 'contact-1', appointmentId: 'appointment-1', calendarId: 'calendar-1'
    }, 'test');

    expect(ghl.getAppointment).toHaveBeenCalledWith('wp', 'appointment-1');
    expect(ghl.getCalendar).toHaveBeenCalledWith('wp', 'calendar-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessage.mock.calls[0]?.[0] as any;
    expect(sent.chatId).toBe('dmitry');
    expect(sent.text).toContain('[SHADOW TEST — Mary]');
    expect(sent.text).toContain('MEETING IN 1 HOUR');
    expect(sent.text).toContain('WallPanels Sales Calls');
    expect(sent.text).toContain('Need: Updated installation pricing');
    expect(sent.text).toContain('Objection: Timing');
    expect(createCard).toHaveBeenCalledWith(expect.objectContaining({ kind: 'appointment', assignedGhlUserId: 'mary-ghl' }));
  });

  it('does not send a completed task reminder', async () => {
    const { processor, sendMessage, ghl } = harness();
    ghl.getTasks.mockResolvedValueOnce([{
      id: 'task-complete', title: 'Already done', dueDate: '2025-10-16T19:00:00.000Z', completed: true
    }]);

    await processor.processEvent('task_reminder', {
      locationId: 'wp-location', contactId: 'contact-1', dueDate: '2025-10-16T19:00:00.000Z'
    }, 'test');

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
