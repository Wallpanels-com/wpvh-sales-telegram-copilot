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
    eventKey,
    raw
  };
}

export function mergeQueryIntoPayload(body: any, query: Record<string, unknown>): any {
  return { ...(typeof body === 'object' && body ? body : {}), ...query };
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
