import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ path: ['.env.local', '.env'], quiet: true });

const boolFromEnv = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return v;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().optional().or(z.literal('')),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),

  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().optional().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16),
  TELEGRAM_DELIVERY_MODE: z.enum(['disabled', 'allowlist', 'all']).default('disabled'),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(''),
  ADMIN_TELEGRAM_USER_IDS: z.string().default(''),
  SALES_MAPPINGS_JSON: z.string().default('[]'),

  SHADOW_TEST_ENABLED: boolFromEnv.default(false),
  SHADOW_TEST_RECIPIENT_TELEGRAM_ID: z.string().default(''),
  SHADOW_TEST_SALES_GHL_IDS: z.string().default(''),
  SHADOW_TEST_LOCATION_IDS: z.string().default(''),
  SHADOW_TEST_SALES_LABELS_JSON: z.string().default('{}'),
  SHADOW_TEST_STARTED_AT: z.string().default('').refine(
    (value) => !value || !Number.isNaN(Date.parse(value)),
    'SHADOW_TEST_STARTED_AT must be an ISO date/time or empty'
  ),
  SHADOW_TEST_UNTIL: z.string().default('').refine(
    (value) => !value || !Number.isNaN(Date.parse(value)),
    'SHADOW_TEST_UNTIL must be an ISO date/time or empty'
  ),

  AI_PROVIDER: z.enum(['openai', 'openai-compatible', 'groq']).default('openai'),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().optional().default(''),
  AI_BASE_URL: z.string().url().optional().or(z.literal('')),
  // Backward-compatible aliases for the original deployment contract.
  OPENAI_API_KEY: z.string().optional().default(''),
  OPENAI_MODEL: z.string().optional().default(''),
  AI_REPLY_MAX_CHARS: z.coerce.number().int().min(80).max(1000).default(240),
  AI_VALIDATE_ON_STARTUP: boolFromEnv.default(false),
  AI_RATE_LIMIT_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_RATE_LIMIT_BASE_MS: z.coerce.number().int().min(250).max(10000).default(1000),

  GHL_WP_LOCATION_ID: z.string().min(1),
  GHL_WP_TOKEN: z.string().min(1),
  GHL_VH_LOCATION_ID: z.string().min(1),
  GHL_VH_TOKEN: z.string().min(1),
  GHL_WEBHOOK_SHARED_SECRET: z.string().min(16),

  TIMEZONE: z.string().default('America/New_York'),
  WORK_START: z.string().regex(/^\d{2}:\d{2}$/).default('08:45'),
  WORK_END: z.string().regex(/^\d{2}:\d{2}$/).default('20:00'),
  WORK_DAYS: z.string().default('1,2,3,4,5,6'),
  DAILY_BRIEF_TIME: z.string().regex(/^\d{2}:\d{2}$/).default('08:45'),

  AUTOMATION_ENABLED: boolFromEnv.default(true),
  POLLING_ENABLED: boolFromEnv.default(true),
  POLLING_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(900).default(60),
  POLLING_CHANNELS: z.string().default('SMS,Email,WhatsApp,Instagram,Facebook,Call'),
  POLLING_LOOKBACK_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  MAX_OPPORTUNITY_PAGES_PER_SALES: z.coerce.number().int().min(1).max(20).default(5),

  GHL_API_BASE: z.string().url().default('https://services.leadconnectorhq.com'),
  GHL_API_VERSION: z.string().default('v3'),
  GHL_CONTACT_URL_TEMPLATE: z.string().default('https://app.gohighlevel.com/v2/location/{locationId}/contacts/detail/{contactId}')
});

export type AppConfig = z.infer<typeof envSchema> & {
  adminTelegramUserIds: string[];
  telegramAllowedUserIds: Set<string>;
  shadowTestSalesGhlIds: Set<string>;
  shadowTestLocationIds: Set<string>;
  shadowTestSalesLabels: Map<string, string>;
  workDays: Set<number>;
  pollingChannels: string[];
  aiApiKey: string;
  aiModel: string;
  aiBaseUrl?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const aiApiKey = parsed.AI_API_KEY || parsed.OPENAI_API_KEY;
  const aiModel = parsed.AI_MODEL || parsed.OPENAI_MODEL || 'gpt-5.6-luna';
  if ((parsed.AI_PROVIDER === 'openai-compatible' || parsed.AI_PROVIDER === 'groq') && !parsed.AI_BASE_URL) {
    throw new Error('AI_BASE_URL is required when AI_PROVIDER=openai-compatible or groq');
  }
  const shadowTestSalesGhlIds = new Set(parsed.SHADOW_TEST_SALES_GHL_IDS.split(',').map((x) => x.trim()).filter(Boolean));
  const shadowTestLocationIds = new Set(parsed.SHADOW_TEST_LOCATION_IDS.split(',').map((x) => x.trim()).filter(Boolean));
  let shadowLabelsRaw: Record<string, unknown>;
  try {
    shadowLabelsRaw = JSON.parse(parsed.SHADOW_TEST_SALES_LABELS_JSON || '{}');
  } catch {
    throw new Error('SHADOW_TEST_SALES_LABELS_JSON must be a JSON object');
  }
  if (!shadowLabelsRaw || Array.isArray(shadowLabelsRaw) || typeof shadowLabelsRaw !== 'object') {
    throw new Error('SHADOW_TEST_SALES_LABELS_JSON must be a JSON object');
  }
  const shadowLabelEntries: Array<[string, string]> = Object.entries(shadowLabelsRaw)
    .map(([id, label]): [string, string] => [id.trim(), String(label).trim()])
    .filter(([id, label]) => Boolean(id && label));
  const shadowTestSalesLabels = new Map<string, string>(shadowLabelEntries);
  if (parsed.SHADOW_TEST_ENABLED && !parsed.SHADOW_TEST_RECIPIENT_TELEGRAM_ID.trim()) {
    throw new Error('SHADOW_TEST_RECIPIENT_TELEGRAM_ID is required when SHADOW_TEST_ENABLED=true');
  }
  if (parsed.SHADOW_TEST_ENABLED && !shadowTestSalesGhlIds.size) {
    throw new Error('SHADOW_TEST_SALES_GHL_IDS must contain at least one ID when SHADOW_TEST_ENABLED=true');
  }
  if (parsed.SHADOW_TEST_ENABLED && !shadowTestLocationIds.size) {
    throw new Error('SHADOW_TEST_LOCATION_IDS must contain at least one ID when SHADOW_TEST_ENABLED=true');
  }
  if (parsed.SHADOW_TEST_ENABLED && !parsed.SHADOW_TEST_STARTED_AT) {
    throw new Error('SHADOW_TEST_STARTED_AT is required when SHADOW_TEST_ENABLED=true');
  }
  return {
    ...parsed,
    adminTelegramUserIds: parsed.ADMIN_TELEGRAM_USER_IDS.split(',').map((x) => x.trim()).filter(Boolean),
    telegramAllowedUserIds: new Set(parsed.TELEGRAM_ALLOWED_USER_IDS.split(',').map((x) => x.trim()).filter(Boolean)),
    shadowTestSalesGhlIds,
    shadowTestLocationIds,
    shadowTestSalesLabels,
    workDays: new Set(parsed.WORK_DAYS.split(',').map((x) => Number(x.trim())).filter((x) => x >= 1 && x <= 7)),
    pollingChannels: parsed.POLLING_CHANNELS.split(',').map((x) => x.trim()).filter(Boolean),
    aiApiKey,
    aiModel,
    aiBaseUrl: parsed.AI_BASE_URL || undefined
  };
}
