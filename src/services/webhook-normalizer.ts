import type { BrandKey, WebhookKind } from '../types.js';
import { sha256, stableStringify } from '../utils/hash.js';

export type NormalizedWebhook = {
  kind: WebhookKind;
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  messageId?: string;
  assignedUserId?: string;
  taskTitle?: string;
  dueDate?: string;
  appointmentStart?: string;
  transcript?: string;
  voiceAiCallId?: string;
  callType?: 'normal_call' | 'voice_ai';
  eventTimestamp?: string;
  sourceEventId?: string;
  eventKey: string;
  raw: any;
};

export function normalizeWebhook(kind: WebhookKind, payload: any): NormalizedWebhook {
  const raw = payload ?? {};
  const locationId = first(raw,
    'locationId', 'location_id', 'location.id', 'location.id.value', 'contact.locationId', 'contact.location_id');
  const contactId = first(raw,
    'contactId', 'contact_id', 'contact.id', 'contact._id', 'message.contactId', 'conversation.contactId');
  const conversationId = first(raw,
    'conversationId', 'conversation_id', 'conversation.id', 'message.conversationId');
  const messageId = first(raw,
    'messageId', 'message_id', 'message.id', 'call.messageId', 'call.message_id', 'transcript.messageId');
  const assignedUserId = first(raw,
    'assignedTo', 'assignedUserId', 'assigned_user_id', 'user.id', 'opportunity.assignedTo', 'conversation.assignedTo', 'contact.assignedTo');
  const taskTitle = first(raw, 'task.title', 'taskTitle', 'task_name', 'title');
  const dueDate = first(raw, 'task.dueDate', 'dueDate', 'task_due_date');
  const appointmentStart = first(raw, 'appointment.startTime', 'appointment.start_time', 'startTime', 'appointmentStart');
  const transcript = first(raw, 'fullTranscript', 'full_transcript', 'transcript', 'call.transcript', 'transcription');
  const eventType = first(raw, 'type', 'eventType', 'event_type', 'callType', 'call_type');
  const explicitVoiceAiCallId = first(raw, 'voiceAiCallId', 'voice_ai_call_id', 'callId', 'call_id', 'call.id');
  const voiceAiMarker = [eventType, first(raw, 'agentId', 'agent_id'), first(raw, 'voiceAi')]
    .filter(Boolean)
    .join('|');
  const isVoiceAi = /voice[\s_-]*ai/i.test(String(voiceAiMarker)) || Boolean(first(raw, 'agentId', 'agent_id'));
  const voiceAiCallId = explicitVoiceAiCallId ?? (isVoiceAi ? first(raw, 'id') : undefined);
  const webhookId = first(raw, 'webhookId', 'webhook_id', 'eventId', 'event_id', 'id');
  const timestamp = first(raw, 'timestamp', 'createdAt', 'dateAdded', 'eventTime');

  const basis = webhookId || [kind, locationId, contactId, messageId, conversationId, timestamp, stableStringify(raw)].join('|');
  const eventKey = `${kind}:${sha256(String(basis)).slice(0, 48)}`;

  return {
    kind,
    locationId: str(locationId),
    contactId: str(contactId),
    conversationId: str(conversationId),
    messageId: str(messageId),
    assignedUserId: str(assignedUserId),
    taskTitle: str(taskTitle),
    dueDate: str(dueDate),
    appointmentStart: str(appointmentStart),
    transcript: str(transcript),
    voiceAiCallId: str(voiceAiCallId),
    callType: isVoiceAi ? 'voice_ai' : kind === 'transcript_generated' || kind === 'poll_call' ? 'normal_call' : undefined,
    eventTimestamp: str(timestamp),
    sourceEventId: str(webhookId),
    eventKey,
    raw
  };
}

/** Store only routing identifiers required to process the event. CRM content is fetched
 * from HighLevel at processing time and must not be retained in the webhook queue. */
export function canonicalWebhookPayload(event: NormalizedWebhook): Record<string, string> {
  const values: Record<string, string | undefined> = {
    locationId: event.locationId,
    contactId: event.contactId,
    conversationId: event.conversationId,
    messageId: event.messageId,
    assignedUserId: event.assignedUserId,
    dueDate: event.dueDate,
    appointmentStart: event.appointmentStart,
    voiceAiCallId: event.voiceAiCallId,
    callType: event.callType,
    eventTimestamp: event.eventTimestamp,
    eventId: event.sourceEventId
  };
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])));
}

export function mergeQueryIntoPayload(body: any, query: Record<string, unknown>): any {
  return { ...(isPlainObject(body) ? body : {}), ...query };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function first(obj: any, ...paths: string[]): any {
  for (const path of paths) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current == null || typeof current !== 'object' || !(part in current)) {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null && current !== '') return current;
  }
  return undefined;
}

function str(v: any): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return undefined;
}
