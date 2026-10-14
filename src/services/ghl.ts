import type { AppConfig } from '../config.js';
import type { BrandKey, GhlMessage, GhlOpportunity } from '../types.js';

export class GhlClient {
  private readonly stageCache = new Map<BrandKey, { expiresAt: number; names: Map<string, string> }>();

  constructor(private readonly config: AppConfig) {}

  brandFromLocation(locationId: string): BrandKey | null {
    if (locationId === this.config.GHL_WP_LOCATION_ID) return 'wp';
    if (locationId === this.config.GHL_VH_LOCATION_ID) return 'vh';
    return null;
  }

  brandLabel(brand: BrandKey): string {
    return brand === 'wp' ? 'WallPanels' : 'Verona Home';
  }

  locationId(brand: BrandKey): string {
    return brand === 'wp' ? this.config.GHL_WP_LOCATION_ID : this.config.GHL_VH_LOCATION_ID;
  }

  token(brand: BrandKey): string {
    return brand === 'wp' ? this.config.GHL_WP_TOKEN : this.config.GHL_VH_TOKEN;
  }


  async getPipelines(brand: BrandKey): Promise<any[]> {
    const data = await this.getJson(brand, '/opportunities/pipelines', { locationId: this.locationId(brand) });
    return Array.isArray(data?.pipelines) ? data.pipelines : [];
  }

  async resolveStageName(brand: BrandKey, stageId?: string): Promise<string | undefined> {
    if (!stageId) return undefined;
    const cached = this.stageCache.get(brand);
    if (cached && cached.expiresAt > Date.now()) return cached.names.get(stageId) ?? stageId;
    const pipelines = await this.getPipelines(brand);
    const names = new Map<string, string>();
    for (const pipeline of pipelines) {
      for (const stage of pipeline?.stages ?? []) {
        if (stage?.id) names.set(String(stage.id), String(stage.name ?? stage.id));
      }
    }
    this.stageCache.set(brand, { expiresAt: Date.now() + 10 * 60_000, names });
    return names.get(stageId) ?? stageId;
  }

  async getContact(brand: BrandKey, contactId: string): Promise<any> {
    const data = await this.getJson(brand, `/contacts/${encodeURIComponent(contactId)}`);
    return data?.contact ?? data;
  }

  async searchConversations(brand: BrandKey, params: Record<string, string | number | boolean | undefined>): Promise<any[]> {
    const data = await this.getJson(brand, '/conversations/search', params);
    return Array.isArray(data?.conversations) ? data.conversations : [];
  }

  async getConversation(brand: BrandKey, conversationId: string): Promise<any> {
    return await this.getJson(brand, `/conversations/${encodeURIComponent(conversationId)}`);
  }

  async getMessages(brand: BrandKey, conversationId: string, limit = 20): Promise<GhlMessage[]> {
    const data = await this.getJson(
      brand,
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
      { limit }
    );
    const wrapper = data?.messages;
    const messages = Array.isArray(wrapper) ? wrapper : wrapper?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  async getMessage(brand: BrandKey, messageId: string): Promise<GhlMessage | null> {
    const data = await this.getJson(brand, `/conversations/messages/${encodeURIComponent(messageId)}`);
    return (data?.message ?? data ?? null) as GhlMessage | null;
  }

  async searchOpportunities(
    brand: BrandKey,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<{ opportunities: GhlOpportunity[]; meta?: any }> {
    const locationId = this.locationId(brand);
    const data = await this.getJson(brand, '/opportunities/search', { locationId, ...params });
    return {
      opportunities: Array.isArray(data?.opportunities) ? data.opportunities : [],
      meta: data?.meta
    };
  }

  async getTasks(brand: BrandKey, contactId: string): Promise<any[]> {
    const data = await this.getJson(brand, `/contacts/${encodeURIComponent(contactId)}/tasks`);
    return Array.isArray(data?.tasks) ? data.tasks : [];
  }

  async getTranscription(brand: BrandKey, locationId: string, messageId: string): Promise<any> {
    return await this.getJson(
      brand,
      `/conversations/locations/${encodeURIComponent(locationId)}/messages/${encodeURIComponent(messageId)}/transcription`
    );
  }

  async exportMessages(
    brand: BrandKey,
    params: {
      channel: string;
      startDate: string;
      endDate?: string;
      limit?: number;
      sortOrder?: 'asc' | 'desc';
      cursor?: string;
    }
  ): Promise<{ messages: GhlMessage[]; nextCursor?: string | null; total?: number }> {
    const data = await this.getJson(
      brand,
      '/conversations/messages/export',
      {
        locationId: this.locationId(brand),
        channel: params.channel,
        startDate: params.startDate,
        endDate: params.endDate,
        limit: params.limit ?? 1000,
        sortBy: 'createdAt',
        sortOrder: params.sortOrder ?? 'asc',
        cursor: params.cursor
      }
    );
    return {
      messages: Array.isArray(data?.messages) ? data.messages : [],
      nextCursor: data?.nextCursor ?? null,
      total: data?.total
    };
  }

  contactUrl(locationId: string, contactId: string): string {
    return this.config.GHL_CONTACT_URL_TEMPLATE
      .replaceAll('{locationId}', encodeURIComponent(locationId))
      .replaceAll('{contactId}', encodeURIComponent(contactId));
  }

  private async getJson(
    brand: BrandKey,
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    version?: string
  ): Promise<any> {
    const url = new URL(path, this.config.GHL_API_BASE);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token(brand)}`,
        Version: version ?? this.config.GHL_API_VERSION
      }
    });

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(`HighLevel GET ${path} failed: ${res.status}`) as Error & { status?: number; details?: unknown };
      err.status = res.status;
      err.details = data;
      throw err;
    }
    return data;
  }
}
