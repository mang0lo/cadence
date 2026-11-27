import { describe, expect, it } from 'vitest';
import { durationParts } from '@/features/health/lib/metrics';
import { createFormatter } from '@/lib/format';

describe('health metric formatting', () => {
  it('splits a short duration into numbers and units, as the app writes it', () => {
    const de = createFormatter('metric', 'de-DE', 'de');
    const en = createFormatter('metric', 'en-US', 'en');
    // 413.8 asleep minutes, the sleep tile of the dashboard
    expect(durationParts(de.durationShort(413.8 * 60))).toEqual([
      { value: '6', unit: 'Std.' },
      { value: '53', unit: 'Min.' },
    ]);
    expect(durationParts(en.durationShort(413.8 * 60))).toEqual([
      { value: '6', unit: 'h' },
      { value: '53', unit: 'm' },
    ]);
    expect(durationParts(de.durationShort(10 * 3600))).toEqual([{ value: '10', unit: 'Std.' }]);
    expect(durationParts(en.durationShort(45 * 60))).toEqual([{ value: '45', unit: 'm' }]);
    expect(durationParts(en.durationShort(null))).toEqual([{ value: '–', unit: '' }]);
  });
});
