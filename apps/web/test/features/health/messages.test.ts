import { describe, expect, it } from 'vitest';
import type { Messages } from '@/lib/i18n';
import { messages } from '@/features/health/messages';

const at = (m: Messages, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], m);
const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();

/** Counts that can be 1 ("1 recordings", "1 Tage" before they became plurals). */
const PLURALS = ['ecg.count', 'explorer.items.count', 'body.bp.readings', 'common.samplesCount', 'metric.typeInfo', 'metric.chart.days'];

describe('health messages', () => {
  it.each(PLURALS)('%s has a singular and a plural with the same placeholders in en and de', (key) => {
    for (const lang of ['en', 'de'] as const) {
      const msg = at(messages[lang], key) as { one?: string; other?: string };
      expect(typeof msg.one, `${lang}.${key}.one`).toBe('string');
      expect(typeof msg.other, `${lang}.${key}.other`).toBe('string');
      expect(vars(msg.one!)).toEqual(vars(msg.other!));
      expect(vars(msg.other!)).toEqual(vars((at(messages.en, key) as { other: string }).other));
    }
  });

  it('has every English string in German too', () => {
    const missing: string[] = [];
    const walk = (en: Messages, de: Messages | undefined, path: string) => {
      for (const [k, v] of Object.entries(en)) {
        const d = de?.[k];
        if (typeof v === 'string') {
          if (typeof d !== 'string') missing.push(`${path}${k}`);
        } else if (v.one !== undefined || v.other !== undefined) {
          if (!d || typeof d === 'string' || d.other === undefined) missing.push(`${path}${k}`);
        } else walk(v, typeof d === 'object' ? d : undefined, `${path}${k}.`);
      }
    };
    walk(messages.en, messages.de, '');
    expect(missing).toEqual([]);
  });
});
