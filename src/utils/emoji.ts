import type { GhlMessage } from '../types.js';

// Match whole emoji sequences, not the broader Emoji property (which includes
// ordinary digits). Covers skin tones, ZWJ families, flags and keycaps.
const emojiPart = String.raw`\p{Extended_Pictographic}[\uFE0E\uFE0F]?\p{Emoji_Modifier}?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?`;
const emojiOnly = new RegExp(
  String.raw`^(?:\s|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|${emojiPart}(?:\u200D${emojiPart})*|\p{Emoji_Modifier})+$`,
  'u'
);

export function isEmojiOnlyMessage(message?: GhlMessage | null): boolean {
  if (!message || message.attachments?.length) return false;
  const body = message.body?.trim();
  return Boolean(body && emojiOnly.test(body));
}
