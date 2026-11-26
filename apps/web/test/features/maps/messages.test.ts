/**
 * Maps messages (apps/web/src/features/maps/messages.ts): counts read the way the locale writes them, and plural
 * messages pick their form from the number. t() prints a variable with String(), so a plural message printing
 * `{count}` showed '1234 activities' / '1234 Aktivitäten'; such messages print `{n}` (countVars).
 */
import { describe, expect, it } from 'vitest';
import type { Messages } from '@/lib/i18n';
import { createFormatter } from '@/lib/format';
import { messages } from '@/features/maps/messages';
import { countVars } from '@/features/maps/lib/counts';
import { speedLabel } from '@/features/maps/lib/timelapse';

/** The texts of a message tree as [path, text]. */
function leaves(m: Messages, path = ''): [string, string][] {
  return Object.entries(m).flatMap(([k, v]) =>
    typeof v === 'string' ? [[`${path}${k}`, v] as [string, string]] : leaves(v, `${path}${k}.`),
  );
}

/** t() as lib/i18n.tsx implements it: a plural object picks the form for `count`, `{name}` prints String(vars.name). */
function tFor(lang: 'en' | 'de', locale: string) {
  const plural = new Intl.PluralRules(locale);
  return (key: string, vars: Record<string, string | number> = {}): string => {
    let msg: string | Messages = messages[lang];
    for (const p of key.split('.')) msg = (msg as Messages)[p]!;
    if (typeof msg === 'object') msg = (msg[plural.select(Number(vars.count ?? 0))] ?? msg.other) as string;
    return msg.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name]));
  };
}

const en = createFormatter('metric', 'en-US', 'en');
const de = createFormatter('metric', 'de-DE', 'de');
const tEn = tFor('en', 'en-US');
const tDe = tFor('de', 'de-DE');

describe('maps messages', () => {
  it('print the formatted count {n} in plural messages, never the raw {count}', () => {
    for (const lang of ['en', 'de'] as const)
      for (const [path, text] of leaves(messages[lang]))
        if (/\.(zero|one|two|few|many|other)$/.test(path)) expect(text, `${lang}: ${path}`).not.toContain('{count}');
  });

  it('have the same keys and placeholders in English and German', () => {
    const shape = (m: Messages) =>
      leaves(m)
        .map(([path, text]) => `${path} ${[...new Set(text.match(/\{\w+\}/g) ?? [])].sort().join(' ')}`)
        .sort();
    expect(shape(messages.de)).toEqual(shape(messages.en));
  });

  it('show counts as the locale writes them, in the right plural form', () => {
    expect(tEn('heatmap.activities', countVars(en, 1234))).toBe('1,234 activities');
    expect(tDe('heatmap.activities', countVars(de, 1234))).toBe('1.234 Aktivitäten');
    expect(tDe('heatmap.activities', countVars(de, 1000))).toBe('1.000 Aktivitäten'); // Number('1.000') is 1: 'one'
    expect(tDe('explorer.visitsCount', countVars(de, 1))).toBe('1 Besuch');
    // a 1×1 max square, and a 32×32 one
    expect(tEn('explorer.stats.maxSquareHint', countVars(en, 1))).toBe('1 tile in one block');
    expect(tDe('explorer.stats.maxSquareHint', countVars(de, 1))).toBe('1 Kachel in einem Block');
    expect(tEn('explorer.stats.maxSquareHint', countVars(en, 32 ** 2))).toBe('1,024 tiles in one block');
    expect(tEn('explorer.next.text', countVars(en, 1, { size: 12 }))).toBe(
      'Visit 1 more tile to reach a 12 × 12 square.',
    );
  });

  it('write the time-lapse speeds with the decimal separator of the locale', () => {
    expect([0.5, 1, 2, 4].map((s) => speedLabel(de, s))).toEqual(['0,5×', '1×', '2×', '4×']);
    expect(speedLabel(en, 0.5)).toBe('0.5×');
  });
});
