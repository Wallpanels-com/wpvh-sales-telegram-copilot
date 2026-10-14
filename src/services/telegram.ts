import type { AppConfig } from '../config.js';

type TelegramConfig = Pick<AppConfig, 'TELEGRAM_BOT_TOKEN' | 'TELEGRAM_WEBHOOK_SECRET'>;

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; copy_text: { text: string } };

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly config: TelegramConfig) {
    this.baseUrl = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`;
  }

  async getMe(): Promise<any> {
    return this.call('getMe', {});
  }

  async getWebhookInfo(): Promise<any> {
    return this.call('getWebhookInfo', {});
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    keyboard?: InlineButton[][];
    disablePreview?: boolean;
  }): Promise<any> {
    return this.call('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      parse_mode: 'HTML',
      disable_web_page_preview: input.disablePreview ?? true,
      reply_markup: input.keyboard ? { inline_keyboard: input.keyboard } : undefined
    });
  }

  async editMessageReplyMarkup(input: { chatId: string; messageId: number; keyboard?: InlineButton[][] }): Promise<any> {
    return this.call('editMessageReplyMarkup', {
      chat_id: input.chatId,
      message_id: input.messageId,
      reply_markup: { inline_keyboard: input.keyboard ?? [] }
    });
  }

  async answerCallbackQuery(id: string, text?: string, showAlert = false): Promise<any> {
    return this.call('answerCallbackQuery', {
      callback_query_id: id,
      text,
      show_alert: showAlert
    });
  }

  async setWebhook(url: string): Promise<any> {
    return this.call('setWebhook', {
      url,
      secret_token: this.config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false
    });
  }

  async deleteWebhook(): Promise<any> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async setCommands(): Promise<any> {
    return this.call('setMyCommands', {
      commands: [
        { command: 'today', description: 'Tasks and calls for today' },
        { command: 'status', description: 'Bot status' },
        { command: 'help', description: 'How to use Sales Copilot' }
      ]
    });
  }

  private async call(method: string, payload: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(`Telegram ${method} failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return data.result;
  }
}
