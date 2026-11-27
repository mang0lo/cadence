/** Speed or pace on the progress charts (speedFormat, apps/web/src/lib/format.ts). */
import { describe, expect, it } from 'vitest';
import { createFormatter, showsPace, speedFormat, speedLabel } from '@/lib/format';
import { makeT } from './i18n';

const en = createFormatter('metric', 'en-US', 'en');
const tEn = makeT('en', 'en-US');
const tDe = makeT('de', 'de-DE');

describe('speed or pace', () => {
  it('labels a sport the way its values are formatted', () => {
    // runs and swims show a pace, rides, nordic skiing and golf km/h (fmt.pace prints speed for them)
    for (const sport of ['run', 'walk', 'hike', 'swim']) {
      expect(showsPace(sport), sport).toBe(true);
      expect(speedLabel(tEn, sport), sport).toBe('Pace');
      expect(speedFormat(en, sport).inverse, sport).toBe(true);
    }
    for (const sport of ['ride', 'nordic_ski', 'golf', 'row', 'other']) {
      expect(showsPace(sport), sport).toBe(speedFormat(en, sport).inverse);
      if (!showsPace(sport)) {
        expect(speedLabel(tEn, sport), sport).toBe('Speed');
        expect(speedFormat(en, sport).format(10), sport).toBe('36.0 km/h');
      }
    }
    expect(speedLabel(tDe, 'ride')).toBe('Geschwindigkeit');
    expect(speedLabel(tDe, 'run')).toBe('Pace');
    expect(en.pace(10, 'ride')).toBe('36.0 km/h');
    expect(en.pace(10, 'golf')).toBe('36.0 km/h');
  });
});
