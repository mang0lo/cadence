/**
 * Messages that combine a count with a noun are plurals ({ one, other }), so a single item reads "1 workout", not
 * "1 workouts" – also when the caller passes the count formatted already (fmt.int).
 */
import { describe, expect, it } from 'vitest';
import { namespaces } from '@/features/registry';
import { createT, type Messages } from '@/lib/i18n';

const en = createT('en', 'en-US', namespaces);
const de = createT('de', 'de-DE', namespaces);

/** The texts of a message tree as [path, text]. */
function leaves(m: Messages, path = ''): [string, string][] {
  return Object.entries(m).flatMap(([k, v]) =>
    typeof v === 'string' ? [[`${path}${k}`, v] as [string, string]] : leaves(v, `${path}${k}.`),
  );
}

describe('plural messages', () => {
  it('print their count as {count}, which t() writes as the locale does, never a pre-formatted {n}', () => {
    for (const [ns, dict] of Object.entries(namespaces))
      for (const lang of ['en', 'de'] as const)
        for (const [path, text] of leaves(dict[lang]))
          if (/\.(zero|one|two|few|many|other)$/.test(path)) expect(text, `${lang}: ${ns}.${path}`).not.toContain('{n}');
  });

  it('write the count the way the locale does when the caller passes the number', () => {
    expect(en('platform.whatsNew.activities', { count: 1234 })).toBe('1,234 new activities');
    expect(de('platform.whatsNew.activities', { count: 1234 })).toBe('1.234 neue Aktivitäten');
    expect(en('activities.athlete.activities', { count: 1 })).toBe('1 activity');
    expect(de('consistency.trophies.kinds.activities.title', { count: 1000 })).toBe('1.000 Aktivitäten');
    expect(de('health.metric.typeInfo', { count: 12345, from: 'a', to: 'b' })).toBe('12.345 Messwerte · a – b');
  });

  it('count the workouts of FIT files in the watch hint', () => {
    expect(en('common.watch.otherHint', { count: 1 })).toBe('1 workout from a FIT file');
    expect(en('common.watch.otherHint', { count: 1234 })).toBe('1,234 workouts from FIT files');
    expect(en('common.watch.otherHint', { count: 0 })).toBe('0 workouts from FIT files');
    expect(de('common.watch.otherHint', { count: 1 })).toBe('1 Training aus einer FIT-Datei');
    expect(de('common.watch.otherHint', { count: 1234 })).toBe('1.234 Trainings aus FIT-Dateien');
  });

  it('count the new health records of an import', () => {
    expect(en('platform.whatsNew.healthRecords', { count: '1' })).toBe('1 new health record');
    expect(en('platform.whatsNew.healthRecords', { count: '12,345' })).toBe('12,345 new health records');
    expect(de('platform.whatsNew.healthRecords', { count: '1' })).toBe('1 neuer Gesundheitswert');
    expect(de('platform.whatsNew.healthRecords', { count: '1.000' })).toBe('1.000 neue Gesundheitswerte');
    expect(de('platform.whatsNew.healthRecords', { count: 2 })).toBe('2 neue Gesundheitswerte');
  });
});
