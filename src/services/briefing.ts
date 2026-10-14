import { DateTime } from 'luxon';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { BrandKey, GhlOpportunity, SalesUser } from '../types.js';
import { escapeHtml, clip } from '../utils/html.js';
import { GhlClient } from './ghl.js';

export type BriefItem = {
  brand: BrandKey;
  brandLabel: string;
  contactId: string;
  opportunityId?: string;
  clientName: string;
  title: string;
  dueDate?: string;
  overdue: boolean;
  kind: 'task' | 'appointment';
};

export class BriefingService {
  constructor(private readonly config: AppConfig, private readonly db: Db, private readonly ghl: GhlClient) {}

  async forSales(user: SalesUser): Promise<{ text: string; items: BriefItem[] }> {
    const items: BriefItem[] = [];
    for (const brand of ['wp', 'vh'] as BrandKey[]) {
      const ghlUserId = brand === 'wp' ? user.wpGhlUserId : user.vhGhlUserId;
      if (!ghlUserId) continue;
      const opportunities = await this.loadAssignedOpportunities(brand, ghlUserId);
      for (const opp of opportunities) items.push(...await this.extractItems(brand, opp));
    }

    items.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return new Date(a.dueDate ?? '9999-12-31').getTime() - new Date(b.dueDate ?? '9999-12-31').getTime();
    });

    const today = DateTime.now().setZone(this.config.TIMEZONE);
    const overdue = items.filter((x) => x.kind === 'task' && x.overdue).length;
    const dueToday = items.filter((x) => x.kind === 'task' && !x.overdue).length;
    const meetings = items.filter((x) => x.kind === 'appointment').length;

    const lines = [
      `☀️ <b>Today · ${escapeHtml(user.name)}</b>`,
      `${today.toFormat('cccc, LLL d')} · ${escapeHtml(this.config.TIMEZONE)}`,
      '',
      `🔴 Overdue tasks: <b>${overdue}</b>`,
      `📌 Tasks due today: <b>${dueToday}</b>`,
      `📅 Meetings today: <b>${meetings}</b>`
    ];

    const top = items.slice(0, 12);
    if (top.length) {
      lines.push('', '<b>Priority</b>');
      top.forEach((item, i) => {
        const icon = item.kind === 'appointment' ? '📅' : item.overdue ? '🔴' : '📌';
        const when = item.dueDate ? DateTime.fromISO(item.dueDate, { zone: 'utc' }).setZone(this.config.TIMEZONE).toFormat('h:mm a') : '';
        lines.push(`${i + 1}. ${icon} <b>${escapeHtml(item.clientName)}</b> · ${escapeHtml(item.brandLabel)}${when ? ` · ${escapeHtml(when)}` : ''}`);
        lines.push(`   ${escapeHtml(clip(item.title, 180))}`);
      });
    } else {
      lines.push('', '✅ No tasks or meetings due today.');
    }

    return { text: lines.join('\n'), items };
  }

  async allSales(): Promise<SalesUser[]> {
    return (await this.db.listSalesUsers()).filter((u) => !u.isAdmin && (u.wpGhlUserId || u.vhGhlUserId));
  }

  private async loadAssignedOpportunities(brand: BrandKey, ghlUserId: string): Promise<GhlOpportunity[]> {
    const out: GhlOpportunity[] = [];
    for (let page = 1; page <= this.config.MAX_OPPORTUNITY_PAGES_PER_SALES; page += 1) {
      const result = await this.ghl.searchOpportunities(brand, {
        assignedTo: ghlUserId,
        status: 'open',
        page,
        limit: 100,
        order: 'added_desc',
        getTasks: true,
        getCalendarEvents: true
      });
      out.push(...result.opportunities);
      if (result.opportunities.length < 100) break;
    }
    return out;
  }

  private async extractItems(brand: BrandKey, opp: GhlOpportunity): Promise<BriefItem[]> {
    const items: BriefItem[] = [];
    const today = DateTime.now().setZone(this.config.TIMEZONE);
    const start = today.startOf('day');
    const end = today.endOf('day');
    const clientName = opp.name || 'Client';
    const brandLabel = this.ghl.brandLabel(brand);

    for (const task of opp.tasks ?? []) {
      if (task.completed || !task.dueDate || !task.contactId) continue;
      const due = DateTime.fromISO(task.dueDate, { zone: 'utc' }).setZone(this.config.TIMEZONE);
      if (!due.isValid || due > end) continue;
      items.push({
        brand,
        brandLabel,
        contactId: task.contactId,
        opportunityId: opp.id,
        clientName,
        title: task.title || task.body || 'Task',
        dueDate: task.dueDate,
        overdue: due < start,
        kind: 'task'
      });
    }

    for (const raw of opp.calendarEvents ?? []) {
      const startTime = pickDate(raw, ['startTime', 'start_time', 'startDateTime', 'startDate', 'date']);
      const contactId = String((raw as any).contactId ?? opp.contactId ?? '');
      if (!startTime || !contactId) continue;
      const dt = DateTime.fromISO(startTime, { zone: 'utc' }).setZone(this.config.TIMEZONE);
      if (!dt.isValid || dt < start || dt > end) continue;
      items.push({
        brand,
        brandLabel,
        contactId,
        opportunityId: opp.id,
        clientName,
        title: String((raw as any).title ?? (raw as any).name ?? 'Appointment'),
        dueDate: startTime,
        overdue: false,
        kind: 'appointment'
      });
    }

    return items;
  }
}

function pickDate(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}
