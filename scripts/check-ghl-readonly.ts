import { config as loadDotenv } from 'dotenv';
import type { AppConfig } from '../src/config.js';
import { GhlClient } from '../src/services/ghl.js';

loadDotenv({ path: ['.env.local', '.env'], quiet: true });

const required = ['GHL_WP_LOCATION_ID', 'GHL_WP_TOKEN', 'GHL_VH_LOCATION_ID', 'GHL_VH_TOKEN'] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const config = {
  GHL_WP_LOCATION_ID: process.env.GHL_WP_LOCATION_ID,
  GHL_WP_TOKEN: process.env.GHL_WP_TOKEN,
  GHL_VH_LOCATION_ID: process.env.GHL_VH_LOCATION_ID,
  GHL_VH_TOKEN: process.env.GHL_VH_TOKEN,
  GHL_API_BASE: process.env.GHL_API_BASE || 'https://services.leadconnectorhq.com',
  GHL_API_VERSION: process.env.GHL_API_VERSION || 'v3',
  GHL_CONTACT_URL_TEMPLATE: process.env.GHL_CONTACT_URL_TEMPLATE || 'https://app.gohighlevel.com/v2/location/{locationId}/contacts/detail/{contactId}'
} as AppConfig;

const client = new GhlClient(config);
const report: Record<string, Record<string, string | number | boolean>> = {};

for (const brand of ['wp', 'vh'] as const) {
  const checks: Record<string, string | number | boolean> = {};
  report[brand] = checks;

  await capture(checks, 'pipelines', async () => (await client.getPipelines(brand)).length);
  const opportunities = await captureValue(checks, 'opportunities', async () => client.searchOpportunities(brand, {
    status: 'all', page: 1, limit: 1, getTasks: true, getNotes: false, getCalendarEvents: true
  }));
  const firstOpportunity = opportunities?.opportunities?.[0];
  if (firstOpportunity?.contactId) {
    await capture(checks, 'contact', async () => Boolean((await client.getContact(brand, firstOpportunity.contactId!))?.id));
    await capture(checks, 'tasks', async () => (await client.getTasks(brand, firstOpportunity.contactId!)).length);
  } else {
    checks.contact = 'skipped:no-contact-id';
    checks.tasks = 'skipped:no-contact-id';
  }

  const conversations = await captureValue(checks, 'conversations', async () => client.searchConversations(brand, {
    locationId: client.locationId(brand), limit: 1, sort: 'desc', sortBy: 'last_message_date'
  }));
  const firstConversation = conversations?.[0];
  if (firstConversation?.id) {
    await capture(checks, 'conversation', async () => Boolean((await client.getConversation(brand, String(firstConversation.id)))?.id));
    await capture(checks, 'messages', async () => (await client.getMessages(brand, String(firstConversation.id), 10)).length);
  } else {
    checks.conversation = 'skipped:no-conversation';
    checks.messages = 'skipped:no-conversation';
  }

  await capture(checks, 'messageExport', async () => (await client.exportMessages(brand, {
    channel: 'SMS',
    startDate: new Date(Date.now() - 5 * 60_000).toISOString(),
    endDate: new Date().toISOString(),
    limit: 10,
    sortOrder: 'asc'
  })).messages.length);
}

console.log(JSON.stringify(report, null, 2));

async function capture(target: Record<string, string | number | boolean>, key: string, fn: () => Promise<string | number | boolean>) {
  try {
    target[key] = await fn();
  } catch (error) {
    target[key] = error instanceof Error ? error.message : String(error);
  }
}

async function captureValue<T>(target: Record<string, string | number | boolean>, key: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const value = await fn();
    target[key] = Array.isArray(value) ? value.length : true;
    return value;
  } catch (error) {
    target[key] = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}
