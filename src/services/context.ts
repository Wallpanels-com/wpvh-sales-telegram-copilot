import type { Db } from '../db.js';
import type { BrandKey, ClientContext, GhlMessage, GhlOpportunity } from '../types.js';
import { GhlClient } from './ghl.js';

export class ContextService {
  constructor(private readonly ghl: GhlClient, private readonly db: Db) {}

  async build(input: {
    brand: BrandKey;
    contactId: string;
    conversationId?: string;
    messageId?: string;
  }): Promise<ClientContext> {
    const { brand, contactId } = input;
    const locationId = this.ghl.locationId(brand);

    const [contact, oppResult, memory, contactTasks] = await Promise.all([
      this.ghl.getContact(brand, contactId),
      this.ghl.searchOpportunities(brand, {
        contactId,
        status: 'all',
        limit: 20,
        page: 1,
        order: 'added_desc',
        getTasks: true,
        getNotes: true,
        getCalendarEvents: true
      }),
      this.db.getClientMemory(locationId, contactId),
      this.ghl.getTasks(brand, contactId)
    ]);

    const opportunity = chooseOpportunity(oppResult.opportunities);

    let conversationId = input.conversationId;
    let conversation: any = null;
    if (conversationId) {
      try {
        conversation = await this.ghl.getConversation(brand, conversationId);
      } catch {
        conversation = null;
      }
    }

    if (!conversationId) {
      const conversations = await this.ghl.searchConversations(brand, {
        locationId,
        contactId,
        limit: 10,
        sort: 'desc',
        sortBy: 'last_message_date'
      });
      conversation = conversations[0] ?? null;
      conversationId = conversation?.id;
    }

    let recentMessages: GhlMessage[] = [];
    if (conversationId) {
      recentMessages = await this.ghl.getMessages(brand, conversationId, 30);
      recentMessages = recentMessages
        .filter((m) => isUsefulMessage(m))
        .sort((a, b) => new Date(a.dateAdded ?? 0).getTime() - new Date(b.dateAdded ?? 0).getTime())
        .slice(-15);
    }

    let triggerMessage: GhlMessage | undefined;
    if (input.messageId) {
      triggerMessage = recentMessages.find((m) => m.id === input.messageId);
      if (!triggerMessage) {
        try {
          triggerMessage = (await this.ghl.getMessage(brand, input.messageId)) ?? undefined;
        } catch {
          // non-fatal; newest inbound below is enough
        }
      }
    }
    if (!triggerMessage) triggerMessage = [...recentMessages].reverse().find((m) => m.direction === 'inbound');

    const assignedGhlUserId = opportunity?.assignedTo
      ?? conversation?.assignedTo
      ?? contact?.assignedTo
      ?? contact?.assignedUserId
      ?? undefined;
    const [pipelineContext, assignedSales] = await Promise.all([
      this.ghl.resolvePipelineContext(brand, opportunity?.pipelineId, opportunity?.pipelineStageId),
      assignedGhlUserId ? this.db.getSalesByGhlUserId(brand, assignedGhlUserId) : Promise.resolve(null)
    ]);
    const allTasks = contactTasks.length ? contactTasks : (opportunity?.tasks ?? []);
    const openTasks = allTasks.filter(isOpenTask).slice(0, 20);
    const nextAppointment = findNextAppointment(opportunity?.calendarEvents ?? []);

    return {
      brand,
      brandLabel: this.ghl.brandLabel(brand),
      locationId,
      contactId,
      contactName: contact?.name || [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || 'Unknown client',
      companyName: contact?.companyName || contact?.company || undefined,
      email: contact?.email || undefined,
      phone: contact?.phone || undefined,
      conversationId,
      assignedGhlUserId,
      assignedSalesName: assignedSales?.name,
      opportunity,
      pipelineName: pipelineContext.pipelineName,
      stageName: pipelineContext.stageName,
      recentMessages,
      openTasks,
      nextAppointment,
      relationshipSummary: memory?.relationship_summary ? String(memory.relationship_summary) : undefined,
      lastCallSummary: memory?.last_call_summary ? String(memory.last_call_summary) : undefined,
      importantFacts: asStringArray(memory?.important_facts),
      objections: asStringArray(memory?.objections),
      commitments: asStringArray(memory?.commitments),
      nextSteps: asStringArray(memory?.next_steps),
      triggerMessage
    };
  }
}

function chooseOpportunity(opportunities: GhlOpportunity[]): GhlOpportunity | undefined {
  if (!opportunities.length) return undefined;
  return (
    opportunities.find((o) => o.status === 'open') ??
    [...opportunities].sort((a, b) => new Date(b.dateUpdated ?? b.dateAdded ?? 0).getTime() - new Date(a.dateUpdated ?? a.dateAdded ?? 0).getTime())[0]
  );
}

function isUsefulMessage(m: GhlMessage): boolean {
  const type = String(m.messageType ?? '');
  if (type.startsWith('TYPE_ACTIVITY_')) return false;
  return Boolean(m.body?.trim()) || type === 'TYPE_CALL' || type === 'Call';
}

function isOpenTask(task: any): boolean {
  if (task?.completed === true || String(task?.completed).toLowerCase() === 'true') return false;
  const status = String(task?.status ?? '').toLowerCase();
  return !['completed', 'done', 'closed'].includes(status);
}

function findNextAppointment(events: Array<Record<string, unknown>>): ClientContext['nextAppointment'] {
  const now = Date.now() - 60 * 60 * 1000;
  const candidates = events.map((event) => {
    const rawStart = event.startTime ?? event.start_time ?? event.startDate ?? event.start_date ?? event.dateStart;
    const startTime = typeof rawStart === 'string' || typeof rawStart === 'number' ? String(rawStart) : '';
    const timestamp = startTime ? new Date(startTime).getTime() : Number.NaN;
    return { event, startTime, timestamp };
  }).filter((item) => Number.isFinite(item.timestamp) && item.timestamp >= now)
    .sort((a, b) => a.timestamp - b.timestamp);
  const next = candidates[0];
  if (!next) return undefined;
  return {
    id: text(next.event.id),
    title: text(next.event.title ?? next.event.name ?? next.event.calendarName),
    startTime: next.startTime,
    status: text(next.event.status)
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}
