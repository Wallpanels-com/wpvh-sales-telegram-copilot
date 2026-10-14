import { describe, expect, it } from 'vitest';
import { clip, escapeHtml } from '../src/utils/html.js';

describe('html helpers', () => {
  it('escapes Telegram HTML-sensitive characters', () => {
    expect(escapeHtml('<John & "Co">')).toBe('&lt;John &amp; &quot;Co&quot;&gt;');
  });

  it('clips long text', () => {
    expect(clip('1234567890', 6)).toBe('12345…');
  });
});
