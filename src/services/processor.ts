import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { BrandKey, GhlMessage, WebhookKind } from '../types.js';
import { sha256 } from '../utils/hash.js';
import { isWithinWorkHours, nextWorkStart } from '../utils/time.js';
import { AiRateLimitError, AiService } from './ai.js';
import { buildAppointmentCard, buildCallCard, buildReplyCard, buildTaskReminderCard, hydrateCardCallbacks } from './cards.js';
import { ContextService } from './context.js';
import { canDeliverToTelegram } from './delivery-policy.js';
import { GhlClient } from './ghl.js';
import { resolveRecipients } from './recipients.js';
import { TelegramClient } from './telegram.js';
import { normalizeWebhook } from './webhook-normalizer.js';

export class EventProcessor {
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly ghl: GhlClient,
    private readonly telegram: TelegramClient,
    private readonly ai: AiService,
    private readonly contextService: ContextService,
    private readonly logger: { info: Function; warn: Function; error: Function }
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      try {
        const event = await this.db.claimNextEvent();
        if (!event) {
          await sleep(1200);
          continue;
        }
        try {
          await this.processEvent(String(event.kind) as WebhookKind, event.payload, String(event.source));
          await this.db.markEventDone(String(event.id));
        } catch (error: any) {
          this.logger.error({ eventId: event.id, kind: event.kind, err: safeError(error) }, 'event processing failed');
          const rateLimit = error instanceof AiRateLimitError ? error : null;
          await this.db.markEventFailed(String(event.id), safeError(error), Number(event.attempts ?? 1), {
            rateLimited: Boolean(rateLimit),
            retryAfterSeconds: rateLimit?.retryAfterSeconds
          });
        }
      } catch (error) {
        this.logger.error({ err: safeError(error) }, 'processor loop error');
        await sleep(3000);
      }
    }
  }

  async processEvent(kind: WebhookKind, payload: any, source = 'unknown') {
    const n = normalizeWebhook(kind, payload);
    this.logger.info({ kind, source, locationId: n.locationId, contactId: n.contactId, messageId: n.messageId }, 'processing event');

    if (kind === 'customer_replied' || kind === 'poll_message') {
      await this.processCustomerReply(n);
      return;
    }
    if (kind === 'transcript_generated' || kind === 'poll_call') {
      await this.processTranscript(n);
      return;
    }
    if (kind === 'task_reminder') {
      await this.processTaskReminder(n);
      return;
    }
    if (kind === 'appointment_reminder') {
      await this.processAppointmentReminder(n);
      return;
    }
  }

  private async processCustomerReply(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    const locationId = this.ghl.locationId(brand);
    let contactId = n.contactId;
    let conversationId = n.conversationId;
    const inputMessageId = n.messageId;

    let triggerMessage: GhlMessage | null = null;
    if (inputMessageId) {
      try {
        triggerMessage = await this.ghl.getMessage(brand, inputMessageId);
        contactId ||= triggerMessage?.contactId;
        conversationId ||= triggerMessage?.conversationId;
      } catch {
        // fallback to context search below
      }
    }

    if (!contactId && conversationId) {
      const conversation = await this.ghl.getConversation(brand, conversationId);
      contactId = conversation?.contactId;
    }
    if (!contactId) throw new Error('customer reply event has no contactId and could not resolve it');

    const context = await this.contextService.build({ brand, contactId, conversationId, messageId: inputMessageId });
    const effectiveMessage = triggerMessage ?? context.triggerMessage;
    if (effectiveMessage?.direction && effectiveMessage.direction !== 'inbound') return;
    const effectiveMessageId = inputMessageId ?? effectiveMessage?.id;

    let claimed = false;
    if (effectiveMessageId) {
      claimed = await this.db.markMessageProcessed(locationId, effectiveMessageId, effectiveMessage?.direction ?? 'inbound', effectiveMessage?.messageType);
      if (!claimed) return;
    }

    try {
      const lessons = await this.db.getLessons();
      const ai = await this.ai.analyzeReply(context, lessons);
      const { recipients, assignedSales } = await resolveRecipients(this.config, this.db, brand, context.assignedGhlUserId);

      const draft = buildReplyCard(this.config, this.ghl, context, ai, assignedSales?.name);
      const cardId = await this.db.createCard({
        kind: 'reply',
        brand,
        locationId: context.locationId,
        contactId: context.contactId,
        conversationId: context.conversationId,
        messageId: effectiveMessageId,
        assignedGhlUserId: context.assignedGhlUserId,
        contactName: context.contactName,
        stageName: context.stageName,
        clientMessage: effectiveMessage?.body,
        contextSummary: ai.summaryRu,
        suggestedReply: ai.suggestedReply,
        nextAction: ai.nextActionRu,
        priority: ai.priority,
        shouldReply: ai.shouldReply,
        payload: { whyRu: ai.whyRu, contextTokensEstimate: ai.contextTokensEstimate }
      });
      const keyboard = hydrateCardCallbacks(draft.keyboard, cardId);
      await this.deliverOrDefer(cardId, recipients, draft.text, keyboard);
    } catch (error) {
      if (claimed && effectiveMessageId) await this.db.unmarkMessageProcessed(locationId, effectiveMessageId);
      throw error;
    }
  }

  private async processTranscript(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    const locationId = this.ghl.locationId(brand);
    let contactId = n.contactId;
    const messageId = n.messageId;
    let transcript = n.transcript;
    let callMessage: GhlMessage | null = null;

    if (messageId) {
      try {
        callMessage = await this.ghl.getMessage(brand, messageId);
        contactId ||= callMessage?.contactId;
      } catch {
        // continue; webhook may carry contact id
      }
    }
    if (!contactId) throw new Error('transcript event has no contactId');

    const analysisMessageId = messageId ?? n.eventKey;
    const processedKey = `transcript:${analysisMessageId}`;
    const claimed = await this.db.markMessageProcessed(locationId, processedKey, callMessage?.direction, callMessage?.messageType ?? 'TYPE_CALL');
    if (!claimed) return;

    try {
      if (messageId) {
        const raw = await this.ghl.getTranscription(brand, locationId, messageId);
        const highLevelTranscript = flattenTranscript(raw);
        if (highLevelTranscript.trim()) transcript = highLevelTranscript;
      }
      if (!transcript?.trim()) throw new Error('transcript not available yet');

      const context = await this.contextService.build({ brand, contactId, conversationId: callMessage?.conversationId, messageId });
      const analysis = await this.ai.analyzeCall({
        contactName: context.contactName,
        brandLabel: context.brandLabel,
        transcript,
        previousMemory: context.relationshipSummary
      });

      await this.db.saveCallAnalysis({
        locationId,
        contactId,
        messageId: analysisMessageId,
        transcriptSha256: sha256(transcript),
        analysis,
        aiProvider: this.config.AI_PROVIDER,
        aiModel: this.config.aiModel
      });
      const { recipients, assignedSales } = await resolveRecipients(this.config, this.db, brand, context.assignedGhlUserId);
      const card = buildCallCard(this.config, this.ghl, {
        brandLabel: context.brandLabel,
        locationId,
        contactId,
        contactName: context.contactName,
        assignedName: assignedSales?.name,
        analysis,
        callDate: callMessage?.dateAdded
      });
      const cardId = await this.db.createCard({
        kind: 'call', brand, locationId, contactId, conversationId: context.conversationId, messageId,
        assignedGhlUserId: context.assignedGhlUserId, contactName: context.contactName,
        contextSummary: analysis.summary, nextAction: analysis.nextSteps[0] ?? 'Review call summary', priority: 'medium', shouldReply: false,
        payload: analysis
      });
      await this.deliverOrDefer(cardId, recipients, card.text, card.keyboard);
    } catch (error) {
      if (claimed) await this.db.unmarkMessageProcessed(locationId, processedKey);
      throw error;
    }
  }

  private async processTaskReminder(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    if (!n.contactId) throw new Error('task reminder missing contactId');
    const context = await this.contextService.build({ brand, contactId: n.contactId, conversationId: n.conversationId });
    const { recipients, assignedSales } = await resolveRecipients(this.config, this.db, brand, n.assignedUserId ?? context.assignedGhlUserId);
    const taskTitle = n.taskTitle ?? context.openTasks[0]?.title ?? 'Task due';
    const dueDate = n.dueDate ?? context.openTasks[0]?.dueDate;
    const card = buildTaskReminderCard(this.config, this.ghl, {
      brandLabel: context.brandLabel,
      locationId: context.locationId,
      contactId: context.contactId,
      contactName: context.contactName,
      taskTitle,
      dueDate,
      stage: context.stageName,
      assignedName: assignedSales?.name
    });
    const cardId = await this.db.createCard({
      kind: 'task', brand, locationId: context.locationId, contactId: context.contactId,
      assignedGhlUserId: n.assignedUserId ?? context.assignedGhlUserId, contactName: context.contactName,
      stageName: context.stageName, nextAction: taskTitle, priority: 'high', shouldReply: false,
      payload: { dueDate }
    });
    await this.deliverOrDefer(cardId, recipients, card.text, card.keyboard);
  }

  private async processAppointmentReminder(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    if (!n.contactId) throw new Error('appointment reminder missing contactId');
    const context = await this.contextService.build({ brand, contactId: n.contactId, conversationId: n.conversationId });
    const { recipients, assignedSales } = await resolveRecipients(this.config, this.db, brand, n.assignedUserId ?? context.assignedGhlUserId);
    const brief = [context.relationshipSummary, context.lastCallSummary].filter(Boolean).join(' ');
    const card = buildAppointmentCard(this.config, this.ghl, {
      brandLabel: context.brandLabel,
      locationId: context.locationId,
      contactId: context.contactId,
      contactName: context.contactName,
      startTime: n.appointmentStart,
      context: brief || 'Open the client in HighLevel to review recent context.',
      assignedName: assignedSales?.name
    });
    const cardId = await this.db.createCard({
      kind: 'appointment', brand, locationId: context.locationId, contactId: context.contactId,
      assignedGhlUserId: n.assignedUserId ?? context.assignedGhlUserId, contactName: context.contactName,
      stageName: context.stageName, nextAction: 'Prepare for appointment', priority: 'high', shouldReply: false,
      payload: { startTime: n.appointmentStart }
    });
    await this.deliverOrDefer(cardId, recipients, card.text, card.keyboard);
  }

  async deliverDeferredNow() {
    if (this.config.TELEGRAM_DELIVERY_MODE === 'disabled') return;
    const allowed = this.config.TELEGRAM_DELIVERY_MODE === 'allowlist'
      ? [...this.config.telegramAllowedUserIds]
      : undefined;
    const due = await this.db.claimDueDeferred(50, allowed);
    for (const item of due) {
      try {
        const card = await this.db.getCard(String(item.card_id));
        if (!card) {
          await this.db.markDeferredDone(String(item.id));
          continue;
        }
        const rendered = await this.renderStoredCard(card);
        const result = await this.telegram.sendMessage({ chatId: String(item.telegram_user_id), ...rendered });
        await this.db.recordDelivery(String(card.id), String(item.telegram_user_id), result.message_id, 'deferred');
        await this.db.markDeferredDone(String(item.id));
      } catch (error) {
        this.logger.error({ deferredId: item.id, err: safeError(error) }, 'deferred delivery failed');
        await this.db.markDeferredPending(String(item.id));
      }
    }
  }

  private async renderStoredCard(card: any) {
    const brand = String(card.brand) as BrandKey;
    if (card.kind === 'reply') {
      const context = await this.contextService.build({
        brand,
        contactId: String(card.contact_id),
        conversationId: card.conversation_id ? String(card.conversation_id) : undefined,
        messageId: card.message_id ? String(card.message_id) : undefined
      });
      const ai = {
        summaryRu: String(card.context_summary ?? ''),
        whyRu: String(card.payload?.whyRu ?? ''),
        suggestedReply: String(card.suggested_reply ?? ''),
        nextActionRu: String(card.next_action ?? ''),
        priority: (card.priority ?? 'medium') as 'high' | 'medium' | 'low',
        shouldReply: Boolean(card.should_reply),
        contextTokensEstimate: Number(card.payload?.contextTokensEstimate ?? 0)
      };
      const { assignedSales } = await resolveRecipients(this.config, this.db, brand, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined);
      const built = buildReplyCard(this.config, this.ghl, context, ai, assignedSales?.name);
      return { text: built.text, keyboard: hydrateCardCallbacks(built.keyboard, String(card.id)) };
    }
    const link = [[{ text: '↗️ Open in GHL', url: this.ghl.contactUrl(String(card.location_id), String(card.contact_id)) }]] as any;
    return { text: `<b>${String(card.kind).toUpperCase()}</b>\n${String(card.context_summary ?? card.next_action ?? '')}`, keyboard: link };
  }

  private async deliverOrDefer(cardId: string, recipients: string[], text: string, keyboard: any[][]) {
    const permittedRecipients = recipients.filter((id) => canDeliverToTelegram(this.config, id));
    if (!permittedRecipients.length) {
      this.logger.warn({ cardId }, 'no Telegram recipients resolved');
      return;
    }
    if (!isWithinWorkHours(this.config)) {
      const deliverAt = nextWorkStart(this.config).toUTC().toISO()!;
      for (const chatId of permittedRecipients) await this.db.deferDelivery(cardId, chatId, deliverAt);
      return;
    }
    for (const chatId of permittedRecipients) {
      try {
        const result = await this.telegram.sendMessage({ chatId, text, keyboard });
        await this.db.recordDelivery(cardId, chatId, result.message_id, 'primary');
      } catch (error) {
        this.logger.error({ chatId, cardId, err: safeError(error) }, 'Telegram delivery failed');
      }
    }
  }

  private requireBrand(locationId?: string): BrandKey {
    if (!locationId) throw new Error('locationId missing');
    const brand = this.ghl.brandFromLocation(locationId);
    if (!brand) throw new Error(`unknown HighLevel locationId: ${locationId}`);
    return brand;
  }
}

function flattenTranscript(raw: any): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((x) => x?.transcript ?? x?.text ?? '').filter(Boolean).join('\n');
  if (Array.isArray(raw.transcription)) return flattenTranscript(raw.transcription);
  if (Array.isArray(raw.transcript)) return flattenTranscript(raw.transcript);
  if (Array.isArray(raw.data)) return flattenTranscript(raw.data);
  if (typeof raw.transcript === 'string') return raw.transcript;
  if (typeof raw.transcription === 'string') return raw.transcription;
  return '';
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error: any): string { return error instanceof Error ? error.message : String(error); }
