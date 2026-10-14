import { DateTime } from 'luxon';
import type { AppConfig } from '../config.js';

function parseHm(v: string): { hour: number; minute: number } {
  const [h, m] = v.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

export function nowInZone(config: AppConfig): DateTime {
  return DateTime.now().setZone(config.TIMEZONE);
}

export function isWithinWorkHours(config: AppConfig, at = nowInZone(config)): boolean {
  if (!config.workDays.has(at.weekday)) return false;
  const startParts = parseHm(config.WORK_START);
  const endParts = parseHm(config.WORK_END);
  const start = at.set({ hour: startParts.hour, minute: startParts.minute, second: 0, millisecond: 0 });
  const end = at.set({ hour: endParts.hour, minute: endParts.minute, second: 0, millisecond: 0 });
  return at >= start && at <= end;
}

export function nextWorkStart(config: AppConfig, from = nowInZone(config)): DateTime {
  const parts = parseHm(config.WORK_START);
  for (let i = 0; i <= 8; i += 1) {
    const day = from.plus({ days: i }).set({ hour: parts.hour, minute: parts.minute, second: 0, millisecond: 0 });
    if (config.workDays.has(day.weekday) && day > from) return day;
  }
  return from.plus({ days: 1 }).set({ hour: parts.hour, minute: parts.minute, second: 0, millisecond: 0 });
}

export function formatEt(iso?: string, timezone = 'America/New_York'): string {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone);
  if (!dt.isValid) return '';
  const today = DateTime.now().setZone(timezone).startOf('day');
  if (dt.hasSame(today, 'day')) return `Today, ${dt.toFormat('h:mm a')}`;
  if (dt.hasSame(today.minus({ days: 1 }), 'day')) return `Yesterday, ${dt.toFormat('h:mm a')}`;
  return dt.toFormat('LLL d, h:mm a');
}

export function endOfTodayUtc(config: AppConfig): string {
  return nowInZone(config).endOf('day').toUTC().toISO()!;
}
