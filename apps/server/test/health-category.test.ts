import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExplorerResponse, MetricSeries } from '@cadence/shared';
import { combineCategoryRows, type DailyRow } from '../src/features/health/series';
import { createHealthFixture, type HealthFixture } from './health-fixture';

/** Which category values add up to a day's total: stand hours, sleep from two apps, symptoms "not present". */
const STAND = 'HKCategoryTypeIdentifierAppleStandHour';
const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
const HEADACHE = 'HKCategoryTypeIdentifierHeadache';

const row = (day: string, value: number, n = 1): DailyRow => ({ day, value, min: null, max: null, n });
const by = (entries: [string, DailyRow[]][]) => new Map(entries);

describe('category day totals (pure)', () => {
  it('counts stood hours only; a day worn but never stood is 0', () => {
    const stand = by([
      ['Stood', [row('2026-03-10', 720, 12)]],
      ['Idle', [row('2026-03-10', 240, 4), row('2026-03-11', 900, 15)]],
    ]);
    expect(combineCategoryRows(stand, STAND)).toEqual([row('2026-03-10', 720, 12), row('2026-03-11', 0, 0)]);
  });

  it('counts a night once when the watch wrote stages and another app a generic Asleep', () => {
    const sleep = by([
      ['AsleepCore', [row('2026-03-10', 300, 10)]],
      ['AsleepDeep', [row('2026-03-10', 60, 3)]],
      ['AsleepUnspecified', [row('2026-03-10', 380, 1), row('2026-03-11', 400, 1)]],
      ['InBed', [row('2026-03-10', 480, 1)]],
      ['Awake', [row('2026-03-10', 20, 2)]],
    ]);
    // the 11th has only the generic night: it still counts
    expect(combineCategoryRows(sleep, SLEEP)).toEqual([row('2026-03-10', 360, 13), row('2026-03-11', 400, 1)]);
  });

  it('does not count symptoms logged as not present, nor menstrual flow "None"', () => {
    const headache = by([
      ['SeverityNotPresent', [row('2026-03-10', 0), row('2026-03-11', 0), row('2026-03-12', 0)]],
      ['SeverityMild', [row('2026-03-12', 0)]],
    ]);
    expect(combineCategoryRows(headache, HEADACHE)).toEqual([row('2026-03-12', 0, 1)]);
    const flow = by([
      ['None', [row('2026-03-10', 0)]],
      ['Light', [row('2026-03-11', 0)]],
    ]);
    expect(combineCategoryRows(flow, 'HKCategoryTypeIdentifierMenstrualFlow')).toEqual([row('2026-03-11', 0, 1)]);
  });
});

describe('category types on the metric page and in the explorer', () => {
  let fx: HealthFixture;
  beforeAll(async () => {
    fx = await createHealthFixture();
    fx.T.stand = fx.addType(1, STAND, 'category', null, 'duration');
    fx.T.sleep = fx.addType(2, SLEEP, 'category', null, 'duration');
    // stand hours: 12 h stood + 3 h idle on the 29th, 10 h stood + 5 h idle on the 30th
    fx.daily(`${STAND}:Stood`, '2026-03-29', 720, { n: 12 });
    fx.daily(`${STAND}:Idle`, '2026-03-29', 180, { n: 3 });
    fx.daily(`${STAND}:Stood`, '2026-03-30', 600, { n: 10 });
    fx.daily(`${STAND}:Idle`, '2026-03-30', 300, { n: 5 });
    // sleep: the watch's stages and AutoSleep's generic night on the 29th, only the generic night on the 30th
    fx.daily(`${SLEEP}:AsleepCore`, '2026-03-29', 300, { n: 10 });
    fx.daily(`${SLEEP}:AsleepDeep`, '2026-03-29', 60, { n: 3 });
    fx.daily(`${SLEEP}:AsleepUnspecified`, '2026-03-29', 370);
    fx.daily(`${SLEEP}:AsleepUnspecified`, '2026-03-30', 400);
    fx.rec(fx.T.stand!, '2026-03-30T21:00:00+01:00', '2026-03-30T22:00:00+01:00', { text: 'Idle' });
    fx.rec(fx.T.sleep!, '2026-03-29T23:00:00+01:00', '2026-03-30T05:40:00+01:00', { text: 'AsleepUnspecified' });
    fx.refreshStats();
  }, 60_000);
  afterAll(async () => {
    await fx?.close();
  });

  it('serves stand hours as the hours stood', async () => {
    const s = await fx.getJson<MetricSeries>(`/api/health/metric/series?type=AppleStandHour&fromDay=2026-03-29&toDay=2026-03-30`);
    expect(s.points.map((p) => p.value)).toEqual([720, 600]);
    expect(s.stats).toMatchObject({ total: 1320, max: 720, min: 600, latest: 600 });
    // the stack still shows the idle hours
    expect(s.categories.map((c) => [c.value, c.total])).toEqual([
      ['Stood', 1320],
      ['Idle', 480],
    ]);
  });

  it('serves sleep without the second app doubling the night, in the totals and in the stack', async () => {
    const s = await fx.getJson<MetricSeries>(`/api/health/metric/series?type=SleepAnalysis&fromDay=2026-03-29&toDay=2026-03-30`);
    expect(s.points.map((p) => [p.key, p.value])).toEqual([
      ['2026-03-29', 360],
      ['2026-03-30', 400],
    ]);
    const generic = s.categories.find((c) => c.value === 'AsleepUnspecified')!;
    expect(generic.points.map((p) => p.key)).toEqual(['2026-03-30']);
    expect(generic.total).toBe(400);
  });

  it('draws the explorer sparkline from the same totals', async () => {
    const ex = await fx.getJson<ExplorerResponse>('/api/health/explorer');
    expect(ex.asOf).toBe('2026-03-30');
    const spark = (id: string) => ex.types.find((t) => t.identifier === id)!.spark.slice(-2);
    expect(spark(STAND)).toEqual([720, 600]);
    expect(spark(SLEEP)).toEqual([360, 400]);
  });
});
