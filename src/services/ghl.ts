import type { AppConfig } from '../config.js';
import type { BrandKey, GhlAppointment, GhlMessage, GhlOpportunity, GhlTask } from '../types.js';

export class GhlClient {
  private readonly pipelineCache = new Map<BrandKey, {
    expiresAt: number;
    pipelineNames: Map<string, string>;
    stageNames: Map<string, string>;
  }>();

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
    const cached = await this.getPipelineCache(brand);
    return cached.stageNames.get(stageId) ?? stageId;
  }

  async resolvePipelineName(brand: BrandKey, pipelineId?: string): Promise<string | undefined> {
    if (!pipelineId) return undefined;
    const cached = await this.getPipelineCache(brand);
    return cached.pipelineNames.get(pipelineId) ?? pipelineId;
  }

  async resolvePipelineContext(brand: BrandKey, pipelineId?: string, stageId?: string): Promise<{
    pipelineName?: string;
    stageName?: string;
  }> {
    if (!pipelineId && !stageId) return {};
    const cached = await this.getPipelineCache(brand);
    return {
      pipelineName: pipelineId ? cached.pipelineNames.get(pipelineId) ?? pipelineId : undefined,
      stageName: stageId ? cached.stageNames.get(stageId) ?? stageId : undefined
    };
  }

  private async getPipelineCache(brand: BrandKey) {
    const cached = this.pipelineCache.get(brand);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const pipelines = await this.getPipelines(brand);
    const pipelineNames = new Map<string, string>();
    const stageNames = new Map<string, string>();
    for (const pipeline of pipelines) {
      if (pipeline?.id) pipelineNames.set(String(pipeline.id), String(pipeline.name ?? pipeline.id));
      for (const stage of pipeline?.stages ?? []) {
        if (stage?.id) stageNames.set(String(stage.id), String(stage.name ?? stage.id));
      }
    }
    const value = { expiresAt: Date.now() + 10 * 60_000, pipelineNames, stageNames };
    this.pipelineCache.set(brand, value);
    return value;
  }

  async getContact(brand: BrandKey, contactId: string): Promise<any> {
    const data = await this.getJson(brand, `/contacts/${safeGhlId(contactId, 'contactId')}`);
    return data?.contact ?? data;
  }

  async searchConversations(brand: BrandKey, params: Record<string, string | number | boolean | undefined>): Promise<any[]> {
    const data = await this.getJson(brand, '/conversations/search', params);
    return Array.isArray(data?.conversations) ? data.conversations : [];
  }

  async getConversation(brand: BrandKey, conversationId: string): Promise<any> {
    return await this.getJson(brand, `/conversations/${safeGhlId(conversationId, 'conversationId')}`);
  }

  async getMessages(brand: BrandKey, conversationId: string, limit = 20): Promise<GhlMessage[]> {
    const data = await this.getJson(
      brand,
      `/conversations/${safeGhlId(conversationId, 'conversationId')}/messages`,
      { limit }
    );
    const wrapper = data?.messages;
    const messages = Array.isArray(wrapper) ? wrapper : wrapper?.messages;
    return Array.isArray(messages) ? messages : [];
  }

  async getMessage(brand: BrandKey, messageId: string): Promise<GhlMessage | null> {
    const data = await this.getJson(brand, `/conversations/messages/${safeGhlId(messageId, 'messageId')}`);
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

  async getTasks(brand: BrandKey, contactId: string): Promise<GhlTask[]> {
    const data = await this.getJson(brand, `/contacts/${safeGhlId(contactId, 'contactId')}/tasks`);
    return Array.isArray(data?.tasks) ? data.tasks : [];
  }

  async getTask(brand: BrandKey, contactId: string, taskId: string): Promise<GhlTask | null> {
    const data = await this.getJson(
      brand,
      `/contacts/${safeGhlId(contactId, 'contactId')}/tasks/${safeGhlId(taskId, 'taskId')}`
    );
    return (data?.task ?? data ?? null) as GhlTask | null;
  }

  async getAppointment(brand: BrandKey, appointmentId: string): Promise<GhlAppointment | null> {
    const data = await this.getJson(
      brand,
      `/calendars/events/appointments/${safeGhlId(appointmentId, 'appointmentId')}`
    );
    return (data?.event ?? data ?? null) as GhlAppointment | null;
  }

  async getCalendar(brand: BrandKey, calendarId: string): Promise<any | null> {
    const data = await this.getJson(brand, `/calendars/${safeGhlId(calendarId, 'calendarId')}`);
    return data?.calendar ?? data ?? null;
  }

  async getTranscription(brand: BrandKey, locationId: string, messageId: string): Promise<any> {
    if (locationId !== this.locationId(brand)) throw new Error('HighLevel location mismatch');
    return await this.getJson(
      brand,
      `/conversations/locations/${safeGhlId(locationId, 'locationId')}/messages/${safeGhlId(messageId, 'messageId')}/transcription`
    );
  }

  async getVoiceAiCallLog(brand: BrandKey, callId: string): Promise<any> {
    const data = await this.getJson(
      brand,
      `/voice-ai/dashboard/call-logs/${safeGhlId(callId, 'callId')}`,
      { locationId: this.locationId(brand) },
      '2021-07-28'
    );
    return data?.callLog ?? data;
  }

  async listVoiceAiCallLogs(brand: BrandKey, contactId: string): Promise<any[]> {
    const data = await this.getJson(
      brand,
      '/voice-ai/dashboard/call-logs',
      {
        locationId: this.locationId(brand),
        contactId: validateGhlId(contactId, 'contactId'),
        page: 1,
        pageSize: 10,
        sortBy: 'createdAt',
        sort: 'descend'
      },
      '2021-07-28'
    );
    const logs = data?.callLogs ?? data?.logs ?? data?.data;
    return Array.isArray(logs) ? logs : [];
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
    return await this.requestJson('GET', brand, path, query, version);
  }

  private async requestJson(
    method: string,
    brand: BrandKey,
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    version?: string
  ): Promise<any> {
    assertGhlReadOnlyMethod(method);
    assertGhlApiPath(path);
    const url = new URL(path, this.config.GHL_API_BASE);
    if (url.origin !== new URL(this.config.GHL_API_BASE).origin) throw new Error('Invalid HighLevel API path');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(this.config.EXTERNAL_REQUEST_TIMEOUT_MS ?? 30_000),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token(brand)}`,
        Version: version ?? this.config.GHL_API_VERSION
      }
    });

    const declaredLength = Number(res.headers.get('content-length') ?? 0);
    if (declaredLength > 5 * 1024 * 1024) throw new Error('HighLevel response exceeded size limit');
    const text = await res.text();
    if (text.length > 5 * 1024 * 1024) throw new Error('HighLevel response exceeded size limit');
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err = new Error(`HighLevel GET failed: ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

export function assertGhlReadOnlyMethod(method: string): void {
  if (method.toUpperCase() !== 'GET') throw new Error('HighLevel client is read-only; non-GET request blocked');
}

export function assertGhlApiPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://') || /[\r\n]/.test(path)) {
    throw new Error('Invalid HighLevel API path');
  }
}

function safeGhlId(value: string, label: string): string {
  return encodeURIComponent(validateGhlId(value, label));
}

function validateGhlId(value: string, label: string): string {
  if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(`Invalid HighLevel ${label}`);
  }
  return value;
}
