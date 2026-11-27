/** Sorting of the route and segment effort tables (apps/web/src/features/maps/lib/effortSort.ts). */
import { describe, expect, it } from 'vitest';
import { defaultSortDir, sortEfforts, type SortableEffort } from '@/features/maps/lib/effortSort';
import { createFormatter, showsPace, speedLabelKey } from '@/lib/format';

const fmt = createFormatter('metric', 'en-US', 'en');
const effort = (day: number, avgSpeed: number | null, rank = 1): SortableEffort & { day: number } => ({
  day,
  startTs: 1_750_000_000 + day * 86_400,
  timeS: 1800,
  avgSpeed,
  avgHr: null,
  rank,
});
const runs = [effort(0, 3.0), effort(1, 3.5), effort(2, 2.8), effort(3, null)];

describe('effort table pace column', () => {
  it('lists the fastest run first with ascending paces under an ascending arrow', () => {
    const dir = defaultSortDir('pace', showsPace('run'));
    expect(dir).toBe('asc');
    const sorted = sortEfforts(runs, { col: 'pace', dir }, showsPace('run'));
    expect(sorted.map((e) => fmt.pace(e.avgSpeed, 'run'))).toEqual(['4:46 /km', '5:33 /km', '5:57 /km', '–']);
  });

  it('lists the fastest ride first with descending speeds under a descending arrow', () => {
    const dir = defaultSortDir('pace', showsPace('ride'));
    expect(dir).toBe('desc');
    const sorted = sortEfforts(runs, { col: 'pace', dir }, showsPace('ride'));
    expect(sorted.map((e) => fmt.pace(e.avgSpeed, 'ride'))).toEqual(['12.6 km/h', '10.8 km/h', '10.1 km/h', '–']);
  });

  it('reverses on a second click: slowest pace first', () => {
    const sorted = sortEfforts(runs, { col: 'pace', dir: 'desc' }, true);
    expect(sorted.map((e) => e.day)).toEqual([3, 2, 0, 1]);
  });

  it('labels the column the way the values are formatted', () => {
    expect(speedLabelKey('run')).toBe('common.pace');
    expect(speedLabelKey('swim')).toBe('common.pace');
    expect(speedLabelKey('ride')).toBe('common.speed');
    // no speed mode: fmt.pace prints km/h, so the header must not say "Pace"
    expect(fmt.pace(3, 'soccer')).toBe('10.8 km/h');
    expect(speedLabelKey('soccer')).toBe('common.speed');
  });
});

describe('effort table other columns', () => {
  it('sorts newest first by default and by rank / time ascending', () => {
    expect(defaultSortDir('date', true)).toBe('desc');
    expect(sortEfforts(runs, { col: 'date', dir: 'desc' }, true).map((e) => e.day)).toEqual([3, 2, 1, 0]);
    const ranked = [effort(0, 3, 2), effort(1, 3, 1), effort(2, 3, 3)];
    expect(sortEfforts(ranked, { col: 'rank', dir: defaultSortDir('rank', true) }, true).map((e) => e.rank)).toEqual([
      1, 2, 3,
    ]);
  });
});
