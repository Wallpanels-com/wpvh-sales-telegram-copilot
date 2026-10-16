import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { BrandKey, ClientContext, GhlMessage, GhlTask, WebhookKind } from '../types.js';
import { sha256 } from '../utils/hash.js';
import { isWithinWorkHours, nextWorkStart } from '../utils/time.js';
import { AiRateLimitError, AiService } from './ai.js';
import { buildAppointmentCard, buildCallCard, buildReplyCard, buildTaskReminderCard, hydrateCardCallbacks } from './cards.js';
import { ContextService } from './context.js';
import {
  canDeliverToTelegram,
  isEventAfterShadowStart,
  isShadowTestActive,
  prependShadowTestPrefix,
  shouldProcessAssignedSales,
  shouldProcessShadowLocation
} from './delivery-policy.js';
import { GhlClient } from './ghl.js';
import { resolveRecipients } from './recipients.js';
import { TelegramClient } from './telegram.js';
import { normalizeWebhook } from './webhook-normalizer.js';
import { auditRef, safeErrorMessage } from '../security.js';

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
          if (!isEventAfterShadowStart(this.config, event.created_at as Date | string | undefined)) {
            await this.db.markEventDiscarded(String(event.id), 'Discarded: event predates shadow test start');
            this.logger.info({ eventId: event.id, kind: event.kind, createdAt: event.created_at }, 'event discarded before shadow start');
            continue;
          }
          await this.processEvent(String(event.kind) as WebhookKind, event.payload, String(event.source));
          await this.db.markEventDone(String(event.id));
        } catch (error: any) {
          this.logger.error({ eventId: event.id, kind: event.kind, error: safeErrorMessage(error) }, 'event processing failed');
          const rateLimit = error instanceof AiRateLimitError ? error : null;
          await this.db.markEventFailed(String(event.id), safeErrorMessage(error), Number(event.attempts ?? 1), {
            rateLimited: Boolean(rateLimit),
            retryAfterSeconds: rateLimit?.retryAfterSeconds
          });
        }
      } catch (error) {
        this.logger.error({ error: safeErrorMessage(error) }, 'processor loop error');
        await sleep(3000);
      }
    }
  }

  async processEvent(kind: WebhookKind, payload: any, source = 'unknown') {
    const n = normalizeWebhook(kind, payload);
    this.logger.info({ kind, source, locationRef: auditRef(n.locationId), contactRef: auditRef(n.contactId), messageRef: auditRef(n.messageId) }, 'processing event');
    if (!shouldProcessShadowLocation(this.config, n.locationId)) {
      this.logger.info({ kind, locationRef: auditRef(n.locationId), eventKey: n.eventKey }, 'event skipped by shadow location scope');
      return;
    }

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
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(contactId) }, 'contact resolved');

    const context = await this.contextService.build({ brand, contactId, conversationId, messageId: inputMessageId });
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), assignedSalesRef: auditRef(context.assignedGhlUserId) }, 'assigned sales resolved');
    if (!this.shouldHandleAssignedSales(context.assignedGhlUserId, 'customer reply', context.contactId)) return;
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), recentMessages: context.recentMessages.length }, 'context built');
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
      this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), provider: this.config.AI_PROVIDER, model: this.config.aiModel }, 'Groq completed');
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
      await this.deliverOrDefer(
        cardId,
        recipients,
        prependShadowTestPrefix(this.config, draft.text, assignedSales?.name, context.assignedGhlUserId),
        keyboard
      );
    } catch (error) {
      if (claimed && effectiveMessageId) await this.db.unmarkMessageProcessed(locationId, effectiveMessageId);
      throw error;
    }
  }

  private async processTranscript(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    const locationId = this.ghl.locationId(brand);
    let contactId = n.contactId;
    const inputMessageId = n.messageId;
    let transcript: string | undefined;
    let callMessage: GhlMessage | null = null;
    let voiceAiLog: any = null;
    let callType: 'normal_call' | 'voice_ai' = n.callType ?? 'normal_call';

    if (n.voiceAiCallId) {
      voiceAiLog = await this.ghl.getVoiceAiCallLog(brand, n.voiceAiCallId);
      contactId ||= stringValue(voiceAiLog?.contactId ?? voiceAiLog?.contact?.id);
      transcript = flattenTranscript(voiceAiLog) || undefined;
      callType = 'voice_ai';
    }

    if (inputMessageId) {
      try {
        callMessage = await this.ghl.getMessage(brand, inputMessageId);
        contactId ||= callMessage?.contactId;
      } catch {
        // continue; webhook may carry contact id
      }
    }
    if (!contactId) throw new Error('transcript event has no contactId');
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(contactId), callType }, 'contact resolved');

    const context = await this.contextService.build({ brand, contactId, conversationId: callMessage?.conversationId, messageId: inputMessageId });
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), assignedSalesRef: auditRef(context.assignedGhlUserId) }, 'assigned sales resolved');
    if (!this.shouldHandleAssignedSales(context.assignedGhlUserId, 'transcript', context.contactId)) return;
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), recentMessages: context.recentMessages.length, callType }, 'context built');
    callMessage ??= [...context.recentMessages].reverse().find(isCallMessage) ?? null;
    let messageId = inputMessageId ?? stringValue(voiceAiLog?.messageId) ?? callMessage?.id;

    const analysisMessageId = n.voiceAiCallId ?? messageId ?? n.eventKey;
    const processedKey = `transcript:${analysisMessageId}`;
    const claimed = await this.db.markMessageProcessed(locationId, processedKey, callMessage?.direction, callMessage?.messageType ?? 'TYPE_CALL');
    if (!claimed) return;

    try {
      if (!transcript?.trim() && messageId) {
        try {
          const raw = await this.ghl.getTranscription(brand, locationId, messageId);
          const highLevelTranscript = flattenTranscript(raw);
          if (highLevelTranscript.trim()) transcript = highLevelTranscript;
        } catch (error) {
          this.logger.warn({ eventKey: n.eventKey, messageRef: auditRef(messageId), error: safeErrorMessage(error) }, 'normal call transcript lookup failed; checking Voice AI logs');
        }
      }
      if (!transcript?.trim()) {
        const logs = await this.ghl.listVoiceAiCallLogs(brand, contactId);
        voiceAiLog = selectRecentVoiceAiLog(logs, n.eventTimestamp);
        if (voiceAiLog) {
          transcript = flattenTranscript(voiceAiLog);
          messageId ||= stringValue(voiceAiLog.messageId);
          callType = 'voice_ai';
        }
      }
      // Some HighLevel workflow payloads already contain the complete transcript.
      // It is accepted only after the read-only API resolution paths above were attempted.
      transcript ||= n.transcript;
      if (!transcript?.trim()) throw new Error('transcript not available yet');

      const analysis = await this.ai.analyzeCall({
        contactName: context.contactName,
        brandLabel: context.brandLabel,
        transcript,
        previousMemory: context.relationshipSummary
      });
      this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), provider: this.config.AI_PROVIDER, model: this.config.aiModel, callType }, 'Groq completed');

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
        callDate: callMessage?.dateAdded ?? voiceAiLog?.createdAt
      });
      const cardId = await this.db.createCard({
        kind: 'call', brand, locationId, contactId, conversationId: context.conversationId, messageId,
        assignedGhlUserId: context.assignedGhlUserId, contactName: context.contactName,
        contextSummary: analysis.summary, nextAction: analysis.nextSteps[0] ?? 'Review call summary', priority: 'medium', shouldReply: false,
        payload: { ...analysis, callDate: callMessage?.dateAdded ?? voiceAiLog?.createdAt, callType }
      });
      await this.deliverOrDefer(
        cardId,
        recipients,
        prependShadowTestPrefix(this.config, card.text, assignedSales?.name, context.assignedGhlUserId),
        card.keyboard
      );
    } catch (error) {
      if (claimed) await this.db.unmarkMessageProcessed(locationId, processedKey);
      throw error;
    }
  }

  private async processTaskReminder(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    if (!n.contactId) throw new Error('task reminder missing contactId');
    const context = await this.contextService.build({ brand, contactId: n.contactId, conversationId: n.conversationId });
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId) }, 'contact resolved');
    const assignedGhlUserId = context.assignedGhlUserId;
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), assignedSalesRef: auditRef(assignedGhlUserId) }, 'assigned sales resolved');
    if (!this.shouldHandleAssignedSales(assignedGhlUserId, 'task reminder', context.contactId)) return;
    const tasks = n.taskId
      ? [await this.ghl.getTask(brand, context.contactId, n.taskId)].filter((task): task is GhlTask => Boolean(task))
      : await this.ghl.getTasks(brand, context.contactId);
    const task = selectReminderTask(tasks, n.taskId, n.dueDate);
    if (!task) throw new Error('task reminder could not resolve current HighLevel task');
    if (task.contactId && task.contactId !== context.contactId) {
      throw new Error('task reminder HighLevel contact mismatch');
    }
    if (task.completed === true || ['completed', 'done', 'closed'].includes(String(task.status ?? '').toLowerCase())) {
      this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), taskRef: auditRef(task.id) }, 'completed task reminder skipped');
      return;
    }
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), recentMessages: context.recentMessages.length }, 'context built');
    const { recipients, assignedSales } = await resolveRecipients(this.config, this.db, brand, assignedGhlUserId);
    const taskTitle = task.title ?? 'Task due';
    const dueDate = task.dueDate ?? n.dueDate;
    const overdue = isPastDue(dueDate);
    const brief = buildTaskBrief(context);
    const card = buildTaskReminderCard(this.config, this.ghl, {
      brandLabel: context.brandLabel,
      locationId: context.locationId,
      contactId: context.contactId,
      contactName: context.contactName,
      taskTitle,
      taskBody: task.body,
      dueDate,
      overdue,
      context: brief,
      pipeline: context.pipelineName,
      stage: context.stageName,
      assignedName: assignedSales?.name
    });
    const cardId = await this.db.createCard({
      kind: 'task', brand, locationId: context.locationId, contactId: context.contactId,
      assignedGhlUserId, contactName: context.contactName,
      stageName: context.stageName, contextSummary: brief, nextAction: taskTitle, priority: overdue ? 'high' : 'medium', shouldReply: false,
      payload: { taskBody: task.body, dueDate, overdue, pipelineName: context.pipelineName }
    });
    await this.deliverOrDefer(cardId, recipients, prependShadowTestPrefix(this.config, card.text, assignedSales?.name, assignedGhlUserId), card.keyboard);
  }

  private async processAppointmentReminder(n: ReturnType<typeof normalizeWebhook>) {
    const brand = this.requireBrand(n.locationId);
    if (!n.contactId) throw new Error('appointment reminder missing contactId');
    const context = await this.contextService.build({ brand, contactId: n.contactId, conversationId: n.conversationId });
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId) }, 'contact resolved');
    const assignedGhlUserId = context.assignedGhlUserId;
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), assignedSalesRef: auditRef(assignedGhlUserId) }, 'assigned sales resolved');
    if (!this.shouldHandleAssignedSales(assignedGhlUserId, 'appointment reminder', context.contactId)) return;
    const appointment = n.appointmentId ? await this.ghl.getAppointment(brand, n.appointmentId) : null;
    if (appointment?.contactId && appointment.contactId !== context.contactId) {
      throw new Error('appointment reminder HighLevel contact mismatch');
    }
    if (appointment?.locationId && appointment.locationId !== context.locationId) {
      throw new Error('appointment reminder HighLevel location mismatch');
    }
    const appointmentStatus = String(
      appointment?.status ?? appointment?.appointmentStatus ?? n.appointmentStatus ?? context.nextAppointment?.status ?? ''
    ).toLowerCase();
    if (['cancelled', 'canceled', 'invalid'].includes(appointmentStatus)) {
      this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), appointmentRef: auditRef(n.appointmentId) }, 'cancelled appointment reminder skipped');
      return;
    }
    const appointmentStart = appointment?.startTime ?? n.appointmentStart ?? context.nextAppointment?.startTime;
    if (!appointmentStart) throw new Error('appointment reminder missing current appointment start time');
    const calendarId = appointment?.calendarId ?? n.calendarId;
    let calendarName = n.calendarName;
    if (calendarId) {
      try {
        const calendar = await this.ghl.getCalendar(brand, calendarId);
        calendarName = stringValue(calendar?.name) ?? calendarName;
      } catch (error) {
        this.logger.warn({ eventKey: n.eventKey, calendarRef: auditRef(calendarId), error: safeErrorMessage(error) }, 'calendar lookup failed; using webhook context');
      }
    }
    const latestCall = await this.db.getLatestCallContext(context.locationId, context.contactId);
    const briefItems = buildAppointmentBrief(context, asStringList(latestCall?.client_needs));
    this.logger.info({ eventKey: n.eventKey, contactRef: auditRef(context.contactId), recentMessages: context.recentMessages.length }, 'context built');
    const { recipients, assignedSales } = await resolveRecipients(this.config, this.db, brand, assignedGhlUserId);
    const card = buildAppointmentCard(this.config, this.ghl, {
      brandLabel: context.brandLabel,
      locationId: context.locationId,
      contactId: context.contactId,
      contactName: context.contactName,
      startTime: appointmentStart,
      appointmentTitle: appointment?.title ?? n.appointmentTitle ?? context.nextAppointment?.title,
      calendarName,
      pipeline: context.pipelineName,
      stage: context.stageName,
      briefItems,
      assignedName: assignedSales?.name
    });
    const brief = briefItems.join('\n');
    const cardId = await this.db.createCard({
      kind: 'appointment', brand, locationId: context.locationId, contactId: context.contactId,
      assignedGhlUserId, contactName: context.contactName,
      stageName: context.stageName, contextSummary: brief, nextAction: 'Prepare for appointment', priority: 'high', shouldReply: false,
      payload: {
        startTime: appointmentStart,
        appointmentTitle: appointment?.title ?? n.appointmentTitle ?? context.nextAppointment?.title,
        calendarName,
        pipelineName: context.pipelineName,
        briefItems
      }
    });
    await this.deliverOrDefer(cardId, recipients, prependShadowTestPrefix(this.config, card.text, assignedSales?.name, assignedGhlUserId), card.keyboard);
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
        this.logger.info({ cardId: card.id, recipientRef: auditRef(String(item.telegram_user_id)), deferredId: item.id }, 'Telegram delivered');
      } catch (error) {
        this.logger.error({ deferredId: item.id, error: safeErrorMessage(error) }, 'deferred delivery failed');
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
      return {
        text: prependShadowTestPrefix(this.config, built.text, assignedSales?.name, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined),
        keyboard: hydrateCardCallbacks(built.keyboard, String(card.id))
      };
    }
    const { assignedSales } = await resolveRecipients(this.config, this.db, brand, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined);
    if (card.kind === 'call') {
      const built = buildCallCard(this.config, this.ghl, {
        brandLabel: this.ghl.brandLabel(brand), locationId: String(card.location_id), contactId: String(card.contact_id),
        contactName: String(card.contact_name ?? 'Client'), assignedName: assignedSales?.name,
        analysis: card.payload, callDate: card.payload?.callDate
      });
      return { text: prependShadowTestPrefix(this.config, built.text, assignedSales?.name, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined), keyboard: built.keyboard };
    }
    if (card.kind === 'task') {
      const built = buildTaskReminderCard(this.config, this.ghl, {
        brandLabel: this.ghl.brandLabel(brand), locationId: String(card.location_id), contactId: String(card.contact_id),
        contactName: String(card.contact_name ?? 'Client'), taskTitle: String(card.next_action ?? 'Task due'),
        taskBody: card.payload?.taskBody, dueDate: card.payload?.dueDate, overdue: Boolean(card.payload?.overdue),
        context: card.context_summary ? String(card.context_summary) : undefined,
        pipeline: card.payload?.pipelineName, stage: card.stage_name ? String(card.stage_name) : undefined, assignedName: assignedSales?.name
      });
      return { text: prependShadowTestPrefix(this.config, built.text, assignedSales?.name, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined), keyboard: built.keyboard };
    }
    if (card.kind === 'appointment') {
      const built = buildAppointmentCard(this.config, this.ghl, {
        brandLabel: this.ghl.brandLabel(brand), locationId: String(card.location_id), contactId: String(card.contact_id),
        contactName: String(card.contact_name ?? 'Client'), startTime: card.payload?.startTime,
        appointmentTitle: card.payload?.appointmentTitle, calendarName: card.payload?.calendarName,
        pipeline: card.payload?.pipelineName, stage: card.stage_name ? String(card.stage_name) : undefined,
        briefItems: Array.isArray(card.payload?.briefItems) ? card.payload.briefItems.map(String) : [], assignedName: assignedSales?.name
      });
      return { text: prependShadowTestPrefix(this.config, built.text, assignedSales?.name, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined), keyboard: built.keyboard };
    }
    const link = [[{ text: '↗️ Open in GHL', url: this.ghl.contactUrl(String(card.location_id), String(card.contact_id)) }]] as any;
    const text = `<b>${String(card.kind).toUpperCase()}</b>\n${String(card.context_summary ?? card.next_action ?? '')}`;
    return { text: prependShadowTestPrefix(this.config, text, assignedSales?.name, card.assigned_ghl_user_id ? String(card.assigned_ghl_user_id) : undefined), keyboard: link };
  }

  private async deliverOrDefer(cardId: string, recipients: string[], text: string, keyboard: any[][]) {
    const permittedRecipients = recipients.filter((id) => canDeliverToTelegram(this.config, id));
    if (!permittedRecipients.length) {
      this.logger.warn({ cardId }, 'no Telegram recipients resolved');
      return;
    }
    if (!isShadowTestActive(this.config) && !isWithinWorkHours(this.config)) {
      const deliverAt = nextWorkStart(this.config).toUTC().toISO()!;
      for (const chatId of permittedRecipients) await this.db.deferDelivery(cardId, chatId, deliverAt);
      this.logger.info({ cardId, recipientCount: permittedRecipients.length, deliverAt }, 'Telegram deferred');
      return;
    }
    for (const chatId of permittedRecipients) {
      try {
        const result = await this.telegram.sendMessage({ chatId, text, keyboard });
        await this.db.recordDelivery(cardId, chatId, result.message_id, 'primary');
        this.logger.info({ cardId, recipientRef: auditRef(chatId) }, 'Telegram delivered');
      } catch (error) {
        this.logger.error({ recipientRef: auditRef(chatId), cardId, error: safeErrorMessage(error) }, 'Telegram delivery failed');
      }
    }
  }

  private requireBrand(locationId?: string): BrandKey {
    if (!locationId) throw new Error('locationId missing');
    const brand = this.ghl.brandFromLocation(locationId);
    if (!brand) throw new Error('unknown HighLevel locationId');
    return brand;
  }

  private shouldHandleAssignedSales(assignedGhlUserId: string | undefined, eventType: string, contactId: string): boolean {
    const allowed = shouldProcessAssignedSales(this.config, assignedGhlUserId);
    if (!allowed) {
      this.logger.info({ eventType, contactRef: auditRef(contactId), assignedSalesRef: auditRef(assignedGhlUserId) }, 'event skipped by shadow test scope');
    }
    return allowed;
  }
}

function selectReminderTask(tasks: GhlTask[], taskId?: string, dueDate?: string): GhlTask | undefined {
  if (taskId) {
    const exact = tasks.find((task) => task.id === taskId);
    if (exact) return exact;
  }

  const targetDue = dueDate ? Date.parse(dueDate) : Number.NaN;
  if (Number.isFinite(targetDue)) {
    const closest = tasks
      .map((task) => ({ task, delta: Math.abs(Date.parse(String(task.dueDate ?? '')) - targetDue) }))
      .filter(({ delta }) => Number.isFinite(delta))
      .sort((a, b) => a.delta - b.delta)[0];
    if (closest && closest.delta <= 5 * 60_000) return closest.task;
  }

  return tasks
    .filter((task) => task.completed !== true && !['completed', 'done', 'closed'].includes(String(task.status ?? '').toLowerCase()))
    .sort((a, b) => safeDateValue(a.dueDate) - safeDateValue(b.dueDate))[0];
}

function safeDateValue(value?: string): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function isPastDue(dueDate?: string): boolean {
  if (!dueDate) return false;
  const parsed = Date.parse(dueDate);
  return Number.isFinite(parsed) && parsed < Date.now();
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
    : [];
}

function cleanBriefItem(value: string | undefined, maxLength = 300): string | undefined {
  const compact = value?.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function buildTaskBrief(context: ClientContext): string {
  const items = [
    cleanBriefItem(context.relationshipSummary, 320),
    context.lastCallSummary ? cleanBriefItem(`Last call: ${context.lastCallSummary}`, 320) : undefined,
    context.commitments[0] ? cleanBriefItem(`Commitment: ${context.commitments[0]}`, 260) : undefined,
    context.nextSteps[0] ? cleanBriefItem(`Next step: ${context.nextSteps[0]}`, 260) : undefined
  ].filter((item): item is string => Boolean(item)).slice(0, 2);

  return items.join('\n') || 'Review the current client record in HighLevel before completing this task.';
}

function buildAppointmentBrief(context: ClientContext, clientNeeds: string[]): string[] {
  const lastInbound = [...context.recentMessages]
    .reverse()
    .find((message) => message.direction === 'inbound' && message.body?.trim())?.body;
  const candidates = [
    ...clientNeeds.slice(0, 2).map((item) => `Need: ${item}`),
    context.importantFacts[0] ? `Client fact: ${context.importantFacts[0]}` : undefined,
    context.lastCallSummary ? `Last call: ${context.lastCallSummary}` : undefined,
    context.objections[0] ? `Objection: ${context.objections[0]}` : undefined,
    context.commitments[0] ? `Commitment: ${context.commitments[0]}` : undefined,
    context.nextSteps[0] ? `Next step: ${context.nextSteps[0]}` : undefined,
    !context.lastCallSummary && lastInbound ? `Latest client message: ${lastInbound}` : undefined,
    context.relationshipSummary
  ];
  const unique = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    const item = cleanBriefItem(candidate, 300);
    if (!item || unique.has(item)) continue;
    unique.add(item);
    result.push(item);
    if (result.length === 6) break;
  }
  return result.length ? result : ['Review the current client record in HighLevel before the meeting.'];
}

function selectRecentVoiceAiLog(logs: any[], eventTimestamp?: string): any | null {
  const eventTime = eventTimestamp ? Date.parse(eventTimestamp) : Date.now();
  const referenceTime = Number.isFinite(eventTime) ? eventTime : Date.now();
  return logs.find((log) => {
    const created = Date.parse(String(log?.createdAt ?? log?.dateAdded ?? log?.startedAt ?? ''));
    return Number.isFinite(created) && Math.abs(referenceTime - created) <= 24 * 60 * 60 * 1000;
  }) ?? null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
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

function isCallMessage(message: GhlMessage): boolean {
  const type = String(message.messageType ?? '').toUpperCase();
  return type === 'CALL' || type.includes('TYPE_CALL');
}

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
