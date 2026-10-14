import type { AppConfig } from '../config.js';
import type { AiReply, CallAnalysis, ClientContext } from '../types.js';
import { escapeHtml, clip } from '../utils/html.js';
import { formatEt } from '../utils/time.js';
import type { InlineButton } from './telegram.js';
import { GhlClient } from './ghl.js';

export function buildReplyCard(config: AppConfig, ghl: GhlClient, context: ClientContext, ai: AiReply, assignedName?: string) {
  const latest = context.triggerMessage;
  const clientMessage = latest?.body?.trim() || '(message without text)';
  const stage = context.stageName ? escapeHtml(context.stageName) : 'Stage unavailable';
  const assigned = assignedName ? `\n👤 <b>Assigned:</b> ${escapeHtml(assignedName)}` : '';
  const time = latest?.dateAdded ? formatEt(latest.dateAdded, config.TIMEZONE) : '';

  const replyBlock = ai.shouldReply && ai.suggestedReply
    ? `\n\n✍️ <b>Suggested reply</b>\n${escapeHtml(ai.suggestedReply)}`
    : `\n\n✅ <b>AI:</b> Reply is not required right now.`;

  const text = [
    `🔔 <b>New client reply · ${escapeHtml(context.brandLabel)}</b>`,
    `\n👤 <b>${escapeHtml(context.contactName)}</b>${context.companyName ? ` · ${escapeHtml(context.companyName)}` : ''}`,
    `\n📍 ${stage}${assigned}`,
    time ? `\n🕒 ${escapeHtml(time)}` : '',
    `\n\n💬 <b>Client</b>\n${escapeHtml(clip(clientMessage, 900))}`,
    `\n\n🧠 <b>Context</b>\n${escapeHtml(clip(ai.summaryRu, 650))}`,
    replyBlock,
    `\n\n🎯 <b>Next</b>\n${escapeHtml(clip(ai.nextActionRu, 350))}`
  ].join('');

  const keyboard: InlineButton[][] = [];
  if (ai.shouldReply && ai.suggestedReply) {
    keyboard.push([{ text: '📋 Copy reply', copy_text: { text: ai.suggestedReply } }]);
    keyboard.push([
      { text: '✂️ Shorter', callback_data: '__CARD__:shorter' },
      { text: '🙂 Friendlier', callback_data: '__CARD__:friendlier' }
    ]);
    keyboard.push([{ text: '🔄 Rewrite', callback_data: '__CARD__:rewrite' }]);
  }
  keyboard.push([{ text: '↗️ Open in GHL', url: ghl.contactUrl(context.locationId, context.contactId) }]);

  return { text, keyboard };
}

export function hydrateCardCallbacks(keyboard: InlineButton[][], cardId: string): InlineButton[][] {
  return keyboard.map((row) => row.map((button) => {
    if ('callback_data' in button && button.callback_data.startsWith('__CARD__:')) {
      return { ...button, callback_data: `card:${cardId}:${button.callback_data.split(':')[1]}` };
    }
    return button;
  }));
}

export function buildCallCard(config: AppConfig, ghl: GhlClient, input: {
  brandLabel: string;
  locationId: string;
  contactId: string;
  contactName: string;
  assignedName?: string;
  analysis: CallAnalysis;
  callDate?: string;
}) {
  const assigned = input.assignedName ? `\n👤 <b>Assigned:</b> ${escapeHtml(input.assignedName)}` : '';
  const lists = [
    input.analysis.clientNeeds.length ? `\n\n🎯 <b>Needs</b>\n${bullets(input.analysis.clientNeeds)}` : '',
    input.analysis.objections.length ? `\n\n⚠️ <b>Objections</b>\n${bullets(input.analysis.objections)}` : '',
    input.analysis.commitments.length ? `\n\n🤝 <b>Commitments</b>\n${bullets(input.analysis.commitments)}` : ''
  ].join('');

  const text = [
    `📞 <b>Call analyzed · ${escapeHtml(input.brandLabel)}</b>`,
    `\n👤 <b>${escapeHtml(input.contactName)}</b>${assigned}`,
    input.callDate ? `\n🕒 ${escapeHtml(formatEt(input.callDate, config.TIMEZONE))}` : '',
    `\n\n🧠 <b>Summary</b>\n${escapeHtml(clip(input.analysis.summary, 1200))}`,
    lists,
    `\n\n➡️ <b>Next step</b>\n${escapeHtml(clip(input.analysis.nextSteps[0] ?? 'Not specified.', 500))}`
  ].join('');

  const keyboard: InlineButton[][] = [[{ text: '↗️ Open in GHL', url: ghl.contactUrl(input.locationId, input.contactId) }]];
  return { text, keyboard };
}

export function buildTaskReminderCard(config: AppConfig, ghl: GhlClient, input: {
  brandLabel: string;
  locationId: string;
  contactId: string;
  contactName: string;
  taskTitle: string;
  dueDate?: string;
  stage?: string;
  assignedName?: string;
}) {
  const text = [
    `📌 <b>Task reminder · ${escapeHtml(input.brandLabel)}</b>`,
    `\n👤 <b>${escapeHtml(input.contactName)}</b>`,
    input.assignedName ? `\n👤 Assigned: ${escapeHtml(input.assignedName)}` : '',
    input.stage ? `\n📍 ${escapeHtml(input.stage)}` : '',
    `\n\n<b>${escapeHtml(input.taskTitle)}</b>`,
    input.dueDate ? `\n🕒 ${escapeHtml(formatEt(input.dueDate, config.TIMEZONE))}` : ''
  ].join('');
  return {
    text,
    keyboard: [[{ text: '↗️ Open in GHL', url: ghl.contactUrl(input.locationId, input.contactId) }]] as InlineButton[][]
  };
}

export function buildAppointmentCard(config: AppConfig, ghl: GhlClient, input: {
  brandLabel: string;
  locationId: string;
  contactId: string;
  contactName: string;
  startTime?: string;
  context?: string;
  assignedName?: string;
}) {
  const text = [
    `📅 <b>Upcoming meeting · ${escapeHtml(input.brandLabel)}</b>`,
    `\n👤 <b>${escapeHtml(input.contactName)}</b>`,
    input.assignedName ? `\n👤 Assigned: ${escapeHtml(input.assignedName)}` : '',
    input.startTime ? `\n🕒 ${escapeHtml(formatEt(input.startTime, config.TIMEZONE))}` : '',
    input.context ? `\n\n🧠 <b>Brief</b>\n${escapeHtml(clip(input.context, 900))}` : ''
  ].join('');
  return {
    text,
    keyboard: [[{ text: '↗️ Open in GHL', url: ghl.contactUrl(input.locationId, input.contactId) }]] as InlineButton[][]
  };
}

function bullets(items: string[]) {
  return items.map((x) => `• ${escapeHtml(clip(x, 300))}`).join('\n');
}
