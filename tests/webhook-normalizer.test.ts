import { describe, expect, it } from 'vitest';
import { canonicalWebhookPayload, normalizeWebhook } from '../src/services/webhook-normalizer.js';

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

  it('normalizes a native Task Reminder payload without persisting CRM text', () => {
    const payload = {
      locationId: 'wp-location',
      contact: { id: 'contact-1' },
      task: {
        title: 'Call client about updated estimate',
        body: 'Client requested updated installation pricing',
        dueDate: '2026-10-16T19:00:00.000Z'
      }
    };
    const first = normalizeWebhook('task_reminder', payload);
    const retry = normalizeWebhook('task_reminder', payload);

    expect(first).toMatchObject({
      locationId: 'wp-location',
      contactId: 'contact-1',
      taskTitle: payload.task.title,
      taskBody: payload.task.body,
      dueDate: payload.task.dueDate
    });
    expect(first.eventKey).toBe(retry.eventKey);
    expect(canonicalWebhookPayload(first)).toEqual({
      locationId: 'wp-location',
      contactId: 'contact-1',
      dueDate: payload.task.dueDate
    });
  });

  it('normalizes the native appointment calendar object and deduplicates retries', () => {
    const payload = {
      locationId: 'wp-location',
      contactId: 'contact-1',
      calendar: {
        id: 'calendar-1',
        calendarName: 'Sales Calls',
        appointmentId: 'appointment-1',
        title: 'Estimate review',
        startTime: '2026-10-17T20:00:00.000Z',
        status: 'confirmed'
      }
    };
    const first = normalizeWebhook('appointment_reminder', payload);
    const retry = normalizeWebhook('appointment_reminder', payload);

    expect(first).toMatchObject({
      appointmentId: 'appointment-1',
      calendarId: 'calendar-1',
      calendarName: 'Sales Calls',
      appointmentStart: payload.calendar.startTime,
      appointmentStatus: 'confirmed'
    });
    expect(first.eventKey).toBe(retry.eventKey);
    expect(canonicalWebhookPayload(first)).toMatchObject({
      appointmentId: 'appointment-1',
      calendarId: 'calendar-1',
      appointmentStart: payload.calendar.startTime
    });
  });

  it('recognizes a Voice AI call end payload without treating every generic id as a call id', () => {
    const voice = normalizeWebhook('transcript_generated', {
      type: 'VoiceAiCallEnd', id: 'voice-call-1', locationId: 'loc', contactId: 'contact', messageId: 'message'
    });
    expect(voice.callType).toBe('voice_ai');
    expect(voice.voiceAiCallId).toBe('voice-call-1');

    const normal = normalizeWebhook('transcript_generated', {
      id: 'workflow-event', locationId: 'loc', contactId: 'contact', messageId: 'message'
    });
    expect(normal.callType).toBe('normal_call');
    expect(normal.voiceAiCallId).toBeUndefined();
  });
});
