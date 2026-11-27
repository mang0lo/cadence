/**
 * Maps messages (apps/web/src/features/maps/messages.ts): counts read the way the locale writes them, and plural
 * messages pick their form from the number. t() writes a numeric `{count}` as the locale does ('1.234 Aktivitäten'),
 * so plural messages print `{count}` and callers pass the number.
 */
import { describe, expect, it } from 'vitest';
import { createT, type Messages } from '@/lib/i18n';
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

/** The app's t() for the maps namespace, with keys relative to it. */
function tFor(lang: 'en' | 'de', locale: string) {
  const t = createT(lang, locale, { maps: messages });
  return (key: string, vars?: Record<string, string | number>): string => t(`maps.${key}`, vars);
}

const en = createFormatter('metric', 'en-US', 'en');
const de = createFormatter('metric', 'de-DE', 'de');
const tEn = tFor('en', 'en-US');
const tDe = tFor('de', 'de-DE');

describe('maps messages', () => {
  it('print the count of plural messages as {count}, never a pre-formatted {n}', () => {
    for (const lang of ['en', 'de'] as const)
      for (const [path, text] of leaves(messages[lang]))
        if (/\.(zero|one|two|few|many|other)$/.test(path)) expect(text, `${lang}: ${path}`).not.toContain('{n}');
  });

  it('have the same keys and placeholders in English and German', () => {
    const shape = (m: Messages) =>
      leaves(m)
        .map(([path, text]) => `${path} ${[...new Set(text.match(/\{\w+\}/g) ?? [])].sort().join(' ')}`)
        .sort();
    expect(shape(messages.de)).toEqual(shape(messages.en));
  });

  it('show counts as the locale writes them, in the right plural form', () => {
    expect(tEn('heatmap.activities', { count: 1234 })).toBe('1,234 activities');
    expect(tDe('heatmap.activities', { count: 1234 })).toBe('1.234 Aktivitäten');
    expect(tDe('heatmap.activities', { count: 1000 })).toBe('1.000 Aktivitäten');
    expect(tDe('routes.showAllEfforts', { count: de.int(1000) })).toBe(tDe('routes.showAllEfforts', { count: 1000 }));
    expect(tEn('workoutCard.rank', { rank: 1234, count: 5678 })).toBe('#1,234 of 5,678');
    expect(tDe('workoutCard.routeDone', { count: 1 })).toBe('Einmal absolviert');
    // the callers that still use countVars get the same texts
    expect(tEn('heatmap.activities', countVars(en, 1234))).toBe('1,234 activities');
    expect(tDe('heatmap.activities', countVars(de, 1234))).toBe('1.234 Aktivitäten');
    expect(tDe('heatmap.activities', countVars(de, 1000))).toBe('1.000 Aktivitäten');
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
