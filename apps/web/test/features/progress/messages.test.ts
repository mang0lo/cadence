/** The progress dictionaries (apps/web/src/features/progress/messages.ts). */
import { describe, expect, it } from 'vitest';
import { messages } from '@/features/progress/messages';
import type { Messages } from '@/lib/i18n';
import { makeT } from './i18n';

const keys = (m: Messages, prefix = ''): string[] =>
  Object.entries(m).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));

describe('progress messages', () => {
  it('has every key in English and German', () => {
    expect(keys(messages.de).sort()).toEqual(keys(messages.en).sort());
  });

  it('prints activity counts with the locale grouping', () => {
    expect(makeT('en', 'en-US')('progress.common.activityCount', { count: 1234 })).toBe('1,234 activities');
    expect(makeT('de', 'de-DE')('progress.common.activityCount', { count: 1234 })).toBe('1.234 Aktivitäten');
    expect(makeT('de', 'de-DE')('progress.common.activityCount', { count: 1 })).toBe('1 Aktivität');
  });
});
