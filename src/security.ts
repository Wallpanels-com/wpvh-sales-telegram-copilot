import { createHash, timingSafeEqual } from 'node:crypto';

const SECRET_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-webhook-secret|x-telegram-bot-api-secret-token|api[_-]?key|token|secret|transcript|fullTranscript|message|email|phone)$/i;
const SECRET_VALUE_PATTERNS = [
  /gsk_[A-Za-z0-9]{16,}/g,
  /(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/gi,
  /Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(?<![A-Za-z0-9])\+?\d[\d().\s-]{8,}\d/g
];

export function timingSafeSecretEqual(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of SECRET_VALUE_PATTERNS) result = result.replace(pattern, '[REDACTED]');
  return result;
}

export function redactUrl(rawUrl: string): string {
  const [path, query = ''] = rawUrl.split('?', 2);
  if (!query) return path || '/';
  const params = new URLSearchParams(query);
  for (const key of [...params.keys()]) {
    if (SECRET_KEY_PATTERN.test(key)) params.set(key, '[REDACTED]');
  }
  return `${path}?${params.toString()}`;
}

export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw).slice(0, 500);
}

export function auditRef(value?: string | null): string | null {
  if (!value) return null;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function isSafeExternalId(value: string | undefined, maxLength = 160): boolean {
  return Boolean(value && value.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value));
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.buckets.size > 10_000) this.cleanup(now);
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }

  private cleanup(now: number) {
    for (const [key, value] of this.buckets) {
      if (value.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export function assertAllowedHttpsBase(rawUrl: string, allowedHosts: Set<string>, label: string): void {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`${label} must use an approved HTTPS host`);
  }
}
