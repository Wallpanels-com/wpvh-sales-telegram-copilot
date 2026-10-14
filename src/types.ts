export type BrandKey = 'wp' | 'vh';

export type SalesUser = {
  id: string;
  name: string;
  telegramUserId: string;
  wpGhlUserId: string | null;
  vhGhlUserId: string | null;
  isAdmin: boolean;
  active: boolean;
};

export type GhlMessage = {
  id: string;
  locationId?: string;
  contactId?: string;
  conversationId?: string;
  dateAdded?: string;
  body?: string;
  direction?: 'inbound' | 'outbound' | string;
  messageType?: string;
  source?: string;
  userId?: string;
  status?: string;
  meta?: Record<string, unknown>;
};

export type GhlOpportunity = {
  id: string;
  name?: string;
  contactId?: string;
  assignedTo?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  status?: string;
  monetaryValue?: number;
  dateAdded?: string;
  dateUpdated?: string;
  tasks?: Array<{
    id: string;
    title?: string;
    body?: string;
    assignedTo?: string;
    dueDate?: string;
    completed?: boolean;
    contactId?: string;
  }>;
  notes?: unknown[];
  calendarEvents?: Array<Record<string, unknown>>;
};

export type ClientContext = {
  brand: BrandKey;
  brandLabel: string;
  locationId: string;
  contactId: string;
  contactName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  conversationId?: string;
  assignedGhlUserId?: string;
  opportunity?: GhlOpportunity;
  stageName?: string;
  recentMessages: GhlMessage[];
  openTasks: NonNullable<GhlOpportunity['tasks']>;
  relationshipSummary?: string;
  lastCallSummary?: string;
  triggerMessage?: GhlMessage;
};

export type AiReply = {
  summaryRu: string;
  whyRu: string;
  suggestedReply: string;
  nextActionRu: string;
  priority: 'high' | 'medium' | 'low';
  shouldReply: boolean;
};

export type CallAnalysis = {
  summaryRu: string;
  needsRu: string[];
  objectionsRu: string[];
  agreementsRu: string[];
  nextStepRu: string;
  relationshipMemoryRu: string;
};

export type WebhookKind = 'customer_replied' | 'transcript_generated' | 'task_reminder' | 'appointment_reminder' | 'poll_message' | 'poll_call';
