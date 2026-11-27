/**
 * Messages that combine a count with a noun are plurals ({ one, other }), so a single item reads "1 workout", not
 * "1 workouts" – also when the caller passes the count formatted already (fmt.int).
 */
import { describe, expect, it } from 'vitest';
import { namespaces } from '@/features/registry';
import { createT } from '@/lib/i18n';

const en = createT('en', 'en-US', namespaces);
const de = createT('de', 'de-DE', namespaces);

describe('plural messages', () => {
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
