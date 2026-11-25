/**
 * Sport-dependent display values of the activities feature (apps/web/src/features/activities/lib/display.ts).
 */
import { describe, expect, it } from 'vitest';
import { createFormatter } from '@/lib/format';
import {
  cadenceUnit,
  isCycling,
  minutesAxis,
  minutesTick,
  paceUnitM,
  paceValue,
  relativeTime,
  speedDiff,
  weekdayShort,
} from '@/features/activities/lib/display';
import { routeColoring, routeGeometry } from '@/features/activities/lib/route';
import type { ChartTheme } from '@/components/charts/theme';
import type { WorkoutStreams } from '@cadence/shared';
import { M_PER_DEG, prep, synth } from './synth';

/** A zig-zag north and south of the straight synthetic track, so the simplified route keeps many vertices. */
function wiggle(s: WorkoutStreams): WorkoutStreams {
  return { ...s, lat: s.lat!.map((v, i) => (v === null ? v : v + (40 * Math.sin(i / 8)) / M_PER_DEG)) };
}

const en = createFormatter('metric', 'en-US', 'en');
const us = createFormatter('imperial', 'en-US', 'en');
const de = createFormatter('metric', 'de-DE', 'de');

describe('display: pace and speed values', () => {
  it('uses the pace unit of the sport: per km / mi, per 100 m / 100 yd for swims', () => {
    expect(paceValue(4, 'run', 'metric')).toBeCloseTo(250, 9); // 4:10 /km
    expect(paceValue(4, 'run', 'imperial')).toBeCloseTo(1609.344 / 4, 9);
    expect(paceValue(1, 'swim', 'metric')).toBeCloseTo(100, 9); // 1:40 /100m
    expect(paceValue(1, 'swim', 'imperial')).toBeCloseTo(91.44, 9);
    expect(paceUnitM('swim', 'metric')).toBe(100);
    expect(paceUnitM('row', 'metric')).toBe(1000);
  });

  it('gives km/h or mph for speed sports and NaN without a speed', () => {
    expect(paceValue(10, 'ride', 'metric')).toBeCloseTo(36, 9);
    expect(paceValue(10, 'ride', 'imperial')).toBeCloseTo(36 / 1.609344, 9);
    expect(paceValue(0, 'run', 'metric')).toBeNaN();
    expect(paceValue(Number.NaN, 'ride', 'metric')).toBeNaN();
  });

  it('agrees with fmt.pace', () => {
    for (const [sport, mps] of [
      ['run', 3.3],
      ['swim', 1.2],
      ['walk', 1.4],
    ] as const) {
      const v = paceValue(mps, sport, 'metric');
      const m = Math.floor(Math.round(v) / 60);
      const s = Math.round(v) % 60;
      expect(en.pace(mps, sport)).toBe(`${m}:${String(s).padStart(2, '0')} ${en.paceParts(1, sport).unit}`);
    }
  });
});

describe('display: compare differences', () => {
  it('compares paces from the speeds, also below the walking speed the charts hide', () => {
    // a km with an hour-long stop (1:05:00 /km) against 5:00 /km: A was an hour slower
    expect(speedDiff(1000 / 3900, 1000 / 300, 'hike', en)!.text).toBe('+1:00:00 /km');
    expect(speedDiff(1000 / 300, 1000 / 3900, 'hike', en)!.value).toBe(-3600);
    expect(speedDiff(1000 / 290, 1000 / 300, 'run', en)!.text).toBe('−0:10 /km');
    expect(speedDiff(1, 1, 'swim', de)!.text).toBe('±0:00 /100m');
  });

  it('compares speeds in km/h or mph and needs both values', () => {
    expect(speedDiff(10, 35 / 3.6, 'ride', en)!.text).toBe('+1.0 km/h'); // 36 vs 35 km/h
    expect(speedDiff(10, 35 / 3.6, 'ride', de)!.text).toBe('+1,0 km/h');
    expect(speedDiff(0.2, 10, 'ride', en)!.value).toBeCloseTo(-35.3, 9);
    expect(speedDiff(0, 3, 'run', en)).toBeNull();
    expect(speedDiff(Number.NaN, 3, 'ride', en)).toBeNull();
  });
});

describe('display: cadence', () => {
  it('says rpm for every cycling sport, spm otherwise', () => {
    expect(cadenceUnit('ride')).toBe('rpm');
    expect(cadenceUnit('handcycle')).toBe('rpm');
    expect(cadenceUnit('run')).toBe('spm');
    expect(isCycling('handcycle')).toBe(true);
    expect(isCycling('wheelchair')).toBe(false);
    expect(en.cadence(80, 'handcycle')).toBe(`80 ${cadenceUnit('handcycle')}`);
  });
});

describe('display: minute ticks', () => {
  it('formats axis minutes as localized durations', () => {
    expect(minutesTick(0, en)).toBe('0');
    expect(minutesTick(30, en)).toBe('30m');
    expect(minutesTick(120, en)).toBe('2h');
    expect(minutesTick(30, de)).toBe('30 Min.');
    expect(minutesTick(120, de)).toBe('2 Std.');
  });
});

describe('display: week chart axis', () => {
  const ticks = (maxMin: number) => {
    const a = minutesAxis(maxMin);
    return Array.from({ length: a.max / a.interval + 1 }, (_, i) => i * a.interval);
  };

  it('never puts a tick between whole hours above one hour', () => {
    for (let max = 0; max <= 1000; max++) {
      const a = minutesAxis(max);
      expect(a.max).toBeGreaterThanOrEqual(max);
      expect(a.max / a.interval).toBeLessThanOrEqual(3);
      for (const v of ticks(max)) if (v > 60) expect(v % 60).toBe(0);
    }
  });

  it('labels a 70- or 95-minute day with hours and short weeks with minutes', () => {
    expect(ticks(70).map((v) => minutesTick(v, en))).toEqual(['0', '1h', '2h']);
    expect(ticks(95).map((v) => minutesTick(v, de))).toEqual(['0', '1 Std.', '2 Std.']);
    expect(ticks(40).map((v) => minutesTick(v, en))).toEqual(['0', '15m', '30m', '45m']);
    expect(ticks(55).map((v) => minutesTick(v, en))).toEqual(['0', '30m', '1h']);
    expect(ticks(0)).toEqual([0, 15]);
    expect(ticks(200)).toEqual([0, 120, 240]);
  });
});

describe('display: relative time of a feed card', () => {
  // Tuesday, 2026-11-24, 07:00 in Vienna (UTC+1)
  const now = Date.UTC(2026, 10, 24, 6) / 1000;
  const today = '2026-11-24';
  const at = (iso: string, tzMin = 60) => Date.parse(iso) / 1000 - tzMin * 60;
  const rel = (ts: number, tzMin = 60, f = en, weekStart: 0 | 1 = 1) => relativeTime(ts, tzMin, f, weekStart, now, today);

  it('counts calendar days: a Sunday evening run is two days ago on Tuesday morning', () => {
    expect(rel(at('2026-11-22T19:30:00Z'))).toBe('2 days ago');
    expect(rel(at('2026-11-23T21:00:00Z'))).toBe('yesterday');
    expect(rel(at('2026-11-22T19:30:00Z'), 60, de)).toBe('vorgestern');
  });

  it('uses minutes and hours on the same day', () => {
    expect(rel(now - 25 * 60)).toBe('25 minutes ago');
    expect(rel(at('2026-11-24T01:00:00Z'))).toBe('6 hours ago');
  });

  it('counts calendar weeks from the week start, then months and years', () => {
    expect(rel(at('2026-11-14T09:00:00Z'))).toBe('2 weeks ago'); // Saturday of the week before last
    expect(rel(at('2026-11-16T09:00:00Z'))).toBe('last week'); // Monday of last week (8 days)
    expect(rel(at('2026-11-15T09:00:00Z'), 60, en, 0)).toBe('last week'); // a Sunday with weeks starting on Sunday
    expect(rel(at('2026-10-02T09:00:00Z'))).toBe('last month');
    expect(rel(at('2026-03-02T09:00:00Z'))).toBe('8 months ago');
    expect(rel(at('2025-06-02T09:00:00Z'))).toBe('last year');
  });

  it('takes the local day of the activity', () => {
    // 23:30 in New York on Nov 22 (UTC−5) is already Nov 23 in UTC: still two days ago for that athlete
    expect(rel(Date.UTC(2026, 10, 23, 4, 30) / 1000, -300)).toBe('2 days ago');
  });
});

describe('display: weekday names', () => {
  it('gives only the weekday, also for locales without a comma in their date pattern', () => {
    const gb = createFormatter('metric', 'en-GB', 'en');
    expect(weekdayShort('2026-11-24', gb)).toBe('Tue');
    expect(weekdayShort('2026-11-22', en)).toBe('Sun');
    expect(weekdayShort('2026-11-23', de)).toBe('Mo');
  });
});

describe('route legend', () => {
  const theme = {
    seq: ['#eeeeee', '#111111'],
    zones: ['#1', '#2', '#3', '#4', '#5'],
    diverging: { neg: '#00f', mid: '#fff', pos: '#f00' },
  } as unknown as ChartTheme;
  const labels = { slow: 'slow', fast: 'fast', low: 'low', high: 'high', downhill: 'down', uphill: 'up' };

  it('shows swim pace per 100 m with its unit and run pace per km', () => {
    // speeds varying between ~0.8 and ~1.6 m/s
    const P = prep(wiggle(synth(600, { speed: (t) => 1.2 + 0.4 * Math.sin(t / 30) })));
    const g = routeGeometry(P)!;
    const swim = routeColoring('pace', P, g, theme, { sport: 'swim', zoneBounds: [], fmt: en, labels, zoneLabels: [] })!;
    expect(swim.legend.kind).toBe('ramp');
    if (swim.legend.kind !== 'ramp') return;
    expect(swim.legend.from).toMatch(/^[1-2]:\d\d \/100m$/);
    expect(swim.legend.to).toMatch(/^[0-1]:\d\d \/100m$/);
    const run = routeColoring('pace', P, g, theme, { sport: 'run', zoneBounds: [], fmt: us, labels, zoneLabels: [] })!;
    if (run.legend.kind !== 'ramp') return;
    expect(run.legend.from).toMatch(/^\d+:\d\d \/mi$/);
  });

  it('formats the heart-rate legend with fmt', () => {
    const P = prep(wiggle(synth(600, { hr: (t) => 120 + (t % 60) })));
    const g = routeGeometry(P)!;
    const c = routeColoring('hr', P, g, theme, { sport: 'run', zoneBounds: [], fmt: de, labels, zoneLabels: [] })!;
    if (c.legend.kind !== 'ramp') throw new Error('ramp expected');
    expect(c.legend.from).toMatch(/^\d+$/);
    expect(c.legend.to).toMatch(/^\d+ bpm$/);
  });
});
