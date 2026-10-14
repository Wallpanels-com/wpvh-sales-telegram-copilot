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

    const [contact, oppResult, memory] = await Promise.all([
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
      this.db.getClientMemory(locationId, contactId)
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
      recentMessages = await this.ghl.getMessages(brand, conversationId, 20);
      recentMessages = recentMessages
        .filter((m) => isUsefulMessage(m))
        .sort((a, b) => new Date(a.dateAdded ?? 0).getTime() - new Date(b.dateAdded ?? 0).getTime())
        .slice(-16);
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

    const assignedGhlUserId = opportunity?.assignedTo ?? conversation?.assignedTo ?? undefined;
    const stageName = await this.ghl.resolveStageName(brand, opportunity?.pipelineStageId);
    const openTasks = (opportunity?.tasks ?? []).filter((t) => !t.completed);

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
      opportunity,
      stageName,
      recentMessages,
      openTasks,
      relationshipSummary: memory?.relationship_summary ? String(memory.relationship_summary) : undefined,
      lastCallSummary: memory?.last_call_summary ? String(memory.last_call_summary) : undefined,
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
