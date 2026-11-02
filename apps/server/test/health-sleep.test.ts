import { describe, expect, it } from 'vitest';
import { SLEEP_STAGE_CODES } from '@cadence/shared';
import {
  buildSleepNights,
  classifySleepText,
  mergeIntervals,
  resolveSegments,
  unionLength,
  type RawSleepRecord,
} from '../src/features/health/sleep-builder';

const WATCH = { id: 2, name: 'Apple Watch von Hannes' };
const PHONE = { id: 1, name: 'iPhone von Hannes' };
const THIRD = { id: 3, name: 'SleepCycle' };

const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const MIN = 60;
const H = 3600;

/** Record helper: ISO timestamps with offset (e.g. 2026-03-10T23:30:00+01:00). */
function rec(
  start: string,
  end: string,
  text: string,
  src: { id: number; name: string } = WATCH,
  tzMin = 60,
): RawSleepRecord {
  return { startTs: ts(start), endTs: ts(end), tzMin, text, sourceId: src.id, sourceName: src.name };
}

/** A staged Apple Watch night 2026-03-10 23:40 → 2026-03-11 07:10 (+01:00), 7 h 30 min in bed. */
function stagedNight(offset = '+01:00', day1 = '2026-03-10', day2 = '2026-03-11', tzMin = 60): RawSleepRecord[] {
  return [
    rec(`${day1}T23:40:00${offset}`, `${day2}T00:20:00${offset}`, 'AsleepCore', WATCH, tzMin), // 40
    rec(`${day2}T00:20:00${offset}`, `${day2}T01:10:00${offset}`, 'AsleepDeep', WATCH, tzMin), // 50
    rec(`${day2}T01:10:00${offset}`, `${day2}T01:20:00${offset}`, 'Awake', WATCH, tzMin), // 10
    rec(`${day2}T01:20:00${offset}`, `${day2}T03:20:00${offset}`, 'AsleepCore', WATCH, tzMin), // 120
    rec(`${day2}T03:20:00${offset}`, `${day2}T04:10:00${offset}`, 'AsleepREM', WATCH, tzMin), // 50
    rec(`${day2}T04:10:00${offset}`, `${day2}T04:12:00${offset}`, 'Awake', WATCH, tzMin), // 2
    rec(`${day2}T04:12:00${offset}`, `${day2}T06:50:00${offset}`, 'AsleepCore', WATCH, tzMin), // 158
    rec(`${day2}T06:50:00${offset}`, `${day2}T07:10:00${offset}`, 'AsleepREM', WATCH, tzMin), // 20
  ];
}

describe('sleep text classification', () => {
  it('maps category values and tolerates the raw HealthKit prefix', () => {
    expect(classifySleepText('InBed')).toBe('inbed');
    expect(classifySleepText('Asleep')).toBe('asleep');
    expect(classifySleepText('AsleepUnspecified')).toBe('asleep');
    expect(classifySleepText('AsleepCore')).toBe('core');
    expect(classifySleepText('HKCategoryValueSleepAnalysisAsleepDeep')).toBe('deep');
    expect(classifySleepText('AsleepREM')).toBe('rem');
    expect(classifySleepText('Awake')).toBe('awake');
    expect(classifySleepText('Whatever')).toBeNull();
  });
});

describe('interval helpers', () => {
  it('merges overlapping intervals and measures their union', () => {
    expect(
      mergeIntervals([
        { s: 10, e: 20 },
        { s: 0, e: 5 },
        { s: 15, e: 30 },
        { s: 30, e: 31 },
      ]),
    ).toEqual([
      { s: 0, e: 5 },
      { s: 10, e: 31 },
    ]);
    expect(unionLength([{ s: 0, e: 10 }, { s: 5, e: 12 }])).toBe(12);
  });

  it('resolves overlaps of one source: awake carves out sleep, a stage beats generic asleep', () => {
    const r = resolveSegments([
      { s: 0, e: 100, stage: 'asleep' },
      { s: 40, e: 50, stage: 'awake' },
      { s: 60, e: 80, stage: 'deep' },
    ]);
    expect(r).toEqual([
      { s: 0, e: 40, stage: 'asleep' },
      { s: 40, e: 50, stage: 'awake' },
      { s: 50, e: 60, stage: 'asleep' },
      { s: 60, e: 80, stage: 'deep' },
      { s: 80, e: 100, stage: 'asleep' },
    ]);
    // exact duplicates do not double count
    expect(
      resolveSegments([
        { s: 0, e: 10, stage: 'core' },
        { s: 0, e: 10, stage: 'core' },
      ]),
    ).toEqual([{ s: 0, e: 10, stage: 'core' }]);
  });
});

describe('buildSleepNights', () => {
  it('builds a staged night from Apple Watch stages and an iPhone InBed record', () => {
    const records = [
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T07:20:00+01:00', 'InBed', PHONE),
      ...stagedNight(),
    ];
    const nights = buildSleepNights(records);
    expect(nights).toHaveLength(1);
    const n = nights[0]!;
    expect(n.kind).toBe('night');
    expect(n.day).toBe('2026-03-11'); // the night belongs to the day it ends on
    expect(n.source).toBe(WATCH.name);
    expect(n.staged).toBe(true);
    expect(n.bedTs).toBe(ts('2026-03-10T23:30:00+01:00'));
    expect(n.wakeTs).toBe(ts('2026-03-11T07:20:00+01:00'));
    expect(n.inBedS).toBe(7 * H + 50 * MIN);
    expect(n.coreS).toBe((40 + 120 + 158) * MIN);
    expect(n.deepS).toBe(50 * MIN);
    expect(n.remS).toBe((50 + 20) * MIN);
    expect(n.unspecS).toBe(0);
    expect(n.asleepS).toBe((318 + 50 + 70) * MIN);
    // in bed minus asleep = 10 min before falling asleep, 12 min awake in the night, 10 min after the last stage
    expect(n.awakeS).toBe(n.inBedS - n.asleepS);
    expect(n.awakeS).toBe((10 + 10 + 2 + 10) * MIN);
    expect(n.onsetTs).toBe(ts('2026-03-10T23:40:00+01:00'));
    expect(n.finalTs).toBe(ts('2026-03-11T07:10:00+01:00'));
    expect(n.latencyS).toBe(10 * MIN);
    expect(n.efficiency).toBeCloseTo(n.asleepS / n.inBedS, 9);
    // the 10-minute awake period counts, the 2-minute one counts too (≥ 60 s)
    expect(n.awakenings).toBe(2);
    expect(n.tzBedMin).toBe(60);
    expect(n.tzWakeMin).toBe(60);
  });

  it('produces contiguous segments that add up to the time in bed', () => {
    const n = buildSleepNights([
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T07:20:00+01:00', 'InBed', PHONE),
      ...stagedNight(),
    ])[0]!;
    let t = 0;
    for (const [off, dur] of n.segments) {
      expect(off).toBe(t);
      expect(dur).toBeGreaterThan(0);
      t += dur;
    }
    expect(t).toBe(n.inBedS);
    // starts with 10 min awake (in bed, not yet asleep), ends with 10 min awake
    expect(SLEEP_STAGE_CODES[n.segments[0]![2]]).toBe('awake');
    expect(n.segments[0]![1]).toBe(10 * MIN);
    expect(SLEEP_STAGE_CODES[n.segments[n.segments.length - 1]![2]]).toBe('awake');
    // adjacent segments never share a stage
    for (let i = 1; i < n.segments.length; i++) expect(n.segments[i]![2]).not.toBe(n.segments[i - 1]![2]);
  });

  it('prefers the best staged source and does not double count overlapping sources', () => {
    const records = [
      ...stagedNight(),
      // a third-party app with a generic, slightly longer asleep interval for the same night
      rec('2026-03-10T23:20:00+01:00', '2026-03-11T07:30:00+01:00', 'Asleep', THIRD),
      rec('2026-03-10T23:15:00+01:00', '2026-03-11T07:35:00+01:00', 'InBed', PHONE),
    ];
    const nights = buildSleepNights(records);
    expect(nights).toHaveLength(1);
    const n = nights[0]!;
    expect(n.source).toBe(WATCH.name);
    expect(n.staged).toBe(true);
    expect(n.unspecS).toBe(0); // the generic source contributes no stage minutes
    expect(n.asleepS).toBe((318 + 50 + 70) * MIN);
    // InBed (any source) widens the time in bed
    expect(n.bedTs).toBe(ts('2026-03-10T23:15:00+01:00'));
    expect(n.wakeTs).toBe(ts('2026-03-11T07:35:00+01:00'));
    expect(n.inBedS).toBe(8 * H + 20 * MIN);
    expect(n.latencyS).toBe(25 * MIN);
  });

  it('falls back to a generic source when no source has stages (pre iOS 16)', () => {
    const records = [
      rec('2026-03-10T23:00:00+01:00', '2026-03-11T07:00:00+01:00', 'InBed', PHONE),
      rec('2026-03-10T23:20:00+01:00', '2026-03-11T06:40:00+01:00', 'Asleep', WATCH),
    ];
    const n = buildSleepNights(records)[0]!;
    expect(n.staged).toBe(false);
    expect(n.unspecS).toBe(7 * H + 20 * MIN);
    expect(n.coreS + n.deepS + n.remS).toBe(0);
    expect(n.asleepS).toBe(7 * H + 20 * MIN);
    expect(n.inBedS).toBe(8 * H);
    expect(n.efficiency).toBeCloseTo((7 * H + 20 * MIN) / (8 * H), 9);
  });

  it('picks the source with more coverage when both are staged, and Apple Watch when they are about equal', () => {
    const watch = [
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T05:30:00+01:00', 'AsleepCore', WATCH),
      rec('2026-03-11T05:30:00+01:00', '2026-03-11T06:00:00+01:00', 'AsleepREM', WATCH),
    ]; // 6.5 h
    const ring = (end: string) => [
      rec('2026-03-10T23:30:00+01:00', end, 'AsleepCore', THIRD),
      rec(end, '2026-03-11T07:00:00+01:00', 'AsleepDeep', THIRD),
    ];
    // ring: 7.5 h vs watch: 6.5 h → the ring has clearly more coverage
    expect(buildSleepNights([...watch, ...ring('2026-03-11T06:00:00+01:00')])[0]!.source).toBe(THIRD.name);
    // ring 6.58 h vs watch 6.5 h (within 10 %) → Apple Watch
    const close = [
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T06:05:00+01:00', 'AsleepCore', THIRD),
    ];
    expect(buildSleepNights([...watch, ...close])[0]!.source).toBe(WATCH.name);
  });

  it('resolves overlaps inside one source (awake inside a generic asleep, repeated stage samples)', () => {
    const records = [
      rec('2026-03-10T23:00:00+01:00', '2026-03-11T07:00:00+01:00', 'Asleep', THIRD),
      rec('2026-03-11T03:00:00+01:00', '2026-03-11T03:30:00+01:00', 'Awake', THIRD),
      rec('2026-03-11T03:00:00+01:00', '2026-03-11T03:30:00+01:00', 'Awake', THIRD),
    ];
    const n = buildSleepNights(records)[0]!;
    expect(n.asleepS).toBe(7 * H + 30 * MIN);
    expect(n.awakeS).toBe(30 * MIN);
    expect(n.awakenings).toBe(1);
  });

  it('handles a night that spans midnight and one that is entirely after midnight on the same day', () => {
    const a = buildSleepNights([
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T07:30:00+01:00', 'Asleep', WATCH),
    ]);
    expect(a[0]!.day).toBe('2026-03-11');
    const b = buildSleepNights([
      rec('2026-03-11T00:30:00+01:00', '2026-03-11T08:00:00+01:00', 'Asleep', WATCH),
    ]);
    expect(b[0]!.day).toBe('2026-03-11');
    // two consecutive nights get consecutive days
    const both = buildSleepNights([
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T07:30:00+01:00', 'Asleep', WATCH),
      rec('2026-03-11T23:50:00+01:00', '2026-03-12T07:10:00+01:00', 'Asleep', WATCH),
    ]);
    expect(both.map((x) => x.day)).toEqual(['2026-03-11', '2026-03-12']);
    expect(both.every((x) => x.kind === 'night')).toBe(true);
  });

  it('separates sessions by a gap of more than two hours (nap) and keeps shorter gaps together', () => {
    const night = rec('2026-03-10T23:30:00+01:00', '2026-03-11T07:30:00+01:00', 'Asleep', WATCH);
    const nap = rec('2026-03-11T14:00:00+01:00', '2026-03-11T14:40:00+01:00', 'Asleep', WATCH);
    const r = buildSleepNights([night, nap]);
    expect(r).toHaveLength(2);
    expect(r[0]!).toMatchObject({ kind: 'night', day: '2026-03-11' });
    expect(r[1]!).toMatchObject({ kind: 'nap', day: '2026-03-11', asleepS: 40 * MIN });
    // a 1.5 hour wake period inside the night does not split it
    const split = buildSleepNights([
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T03:00:00+01:00', 'Asleep', WATCH),
      rec('2026-03-11T04:30:00+01:00', '2026-03-11T07:30:00+01:00', 'Asleep', WATCH),
    ]);
    expect(split).toHaveLength(1);
    expect(split[0]!.asleepS).toBe(6 * H + 30 * MIN);
    expect(split[0]!.awakeS).toBe(90 * MIN);
  });

  it('classifies a lone short daytime sleep as a nap but not a short night', () => {
    const lone = buildSleepNights([rec('2026-03-11T14:00:00+01:00', '2026-03-11T14:45:00+01:00', 'Asleep', WATCH)]);
    expect(lone[0]!.kind).toBe('nap');
    const shortNight = buildSleepNights([rec('2026-03-11T02:00:00+01:00', '2026-03-11T04:00:00+01:00', 'Asleep', WATCH)]);
    expect(shortNight[0]!.kind).toBe('night');
    // a long daytime sleep (night shift) stays the main sleep of its day
    const shift = buildSleepNights([rec('2026-03-11T09:30:00+01:00', '2026-03-11T16:30:00+01:00', 'Asleep', WATCH)]);
    expect(shift[0]!.kind).toBe('night');
  });

  it('drops noise: a few minutes of asleep without time in bed', () => {
    expect(buildSleepNights([rec('2026-03-11T08:00:00+01:00', '2026-03-11T08:03:00+01:00', 'AsleepCore', WATCH)])).toEqual([]);
    expect(buildSleepNights([rec('2026-03-11T08:00:00+01:00', '2026-03-11T08:03:00+01:00', 'Unknown', WATCH)])).toEqual([]);
    // zero / negative / absurdly long records are ignored
    expect(buildSleepNights([rec('2026-03-11T08:00:00+01:00', '2026-03-11T08:00:00+01:00', 'Asleep', WATCH)])).toEqual([]);
    expect(buildSleepNights([rec('2026-03-10T08:00:00+01:00', '2026-03-12T08:00:00+01:00', 'InBed', PHONE)])).toEqual([]);
  });

  it('keeps an InBed-only night (no sleep tracking) without asleep minutes', () => {
    const n = buildSleepNights([rec('2026-03-10T23:00:00+01:00', '2026-03-11T07:00:00+01:00', 'InBed', PHONE)])[0]!;
    expect(n.asleepS).toBe(0);
    expect(n.inBedS).toBe(8 * H);
    expect(n.staged).toBe(false);
    expect(n.onsetTs).toBeNull();
    expect(n.efficiency).toBe(0);
    expect(n.kind).toBe('night');
    expect(n.source).toBeNull();
  });

  it('has no latency without an InBed record', () => {
    const n = buildSleepNights(stagedNight())[0]!;
    expect(n.latencyS).toBeNull();
    expect(n.bedTs).toBe(n.onsetTs);
  });

  it('does not count short awake blips or awake time at the edges as awakenings', () => {
    const records = [
      rec('2026-03-10T23:00:00+01:00', '2026-03-10T23:30:00+01:00', 'Awake', WATCH), // before sleep
      rec('2026-03-10T23:30:00+01:00', '2026-03-11T02:00:00+01:00', 'AsleepCore', WATCH),
      rec('2026-03-11T02:00:00+01:00', '2026-03-11T02:00:30+01:00', 'Awake', WATCH), // 30 s blip
      rec('2026-03-11T02:00:30+01:00', '2026-03-11T05:00:00+01:00', 'AsleepCore', WATCH),
      rec('2026-03-11T05:00:00+01:00', '2026-03-11T05:05:00+01:00', 'Awake', WATCH), // counts
      rec('2026-03-11T05:05:00+01:00', '2026-03-11T06:30:00+01:00', 'AsleepREM', WATCH),
      rec('2026-03-11T06:30:00+01:00', '2026-03-11T06:45:00+01:00', 'Awake', WATCH), // after the last sleep
    ];
    const n = buildSleepNights(records)[0]!;
    expect(n.awakenings).toBe(1);
    expect(n.bedTs).toBe(ts('2026-03-10T23:00:00+01:00'));
    expect(n.onsetTs).toBe(ts('2026-03-10T23:30:00+01:00'));
    expect(n.finalTs).toBe(ts('2026-03-11T06:30:00+01:00'));
  });

  describe('time zones', () => {
    it('keeps absolute durations across the spring DST change and reports the offset at bed and at waking', () => {
      // Europe/Vienna 2026-03-29: 02:00 CET (+1) jumps to 03:00 CEST (+2). Bed 23:00 CET, wake 07:00 CEST = 7 h asleep.
      const records = [
        rec('2026-03-28T23:00:00+01:00', '2026-03-29T01:30:00+01:00', 'Asleep', WATCH, 60),
        rec('2026-03-29T03:30:00+02:00', '2026-03-29T07:00:00+02:00', 'Asleep', WATCH, 120),
        rec('2026-03-29T01:30:00+01:00', '2026-03-29T03:30:00+02:00', 'Asleep', WATCH, 60),
      ];
      const n = buildSleepNights(records)[0]!;
      expect(n.inBedS).toBe(7 * H); // not 8 h
      expect(n.asleepS).toBe(7 * H);
      expect(n.tzBedMin).toBe(60);
      expect(n.tzWakeMin).toBe(120);
      expect(n.day).toBe('2026-03-29');
    });

    it('keeps absolute durations across the autumn DST change (an extra hour)', () => {
      // 2026-10-25: 03:00 CEST (+2) falls back to 02:00 CET (+1). Bed 23:00 CEST, wake 07:00 CET = 9 h.
      const records = [
        rec('2026-10-24T23:00:00+02:00', '2026-10-25T07:00:00+01:00', 'Asleep', WATCH, 120),
      ];
      const n = buildSleepNights(records)[0]!;
      expect(n.inBedS).toBe(9 * H);
      expect(n.day).toBe('2026-10-25');
    });

    it('attributes a night to the local day at the destination after crossing time zones', () => {
      // falls asleep 23:00 Vienna (UTC+1) = 22:00 UTC; wakes 06:00 New York (UTC−5) = 11:00 UTC
      const records = [
        {
          startTs: ts('2026-01-10T22:00:00Z'),
          endTs: ts('2026-01-10T23:00:00Z'),
          tzMin: 60,
          text: 'Asleep',
          sourceId: 2,
          sourceName: WATCH.name,
        },
        {
          startTs: ts('2026-01-10T23:00:00Z'),
          endTs: ts('2026-01-11T11:00:00Z'),
          tzMin: -300,
          text: 'Asleep',
          sourceId: 2,
          sourceName: WATCH.name,
        },
      ];
      const n = buildSleepNights(records)[0]!;
      expect(n.tzBedMin).toBe(60);
      expect(n.tzWakeMin).toBe(-300);
      expect(n.day).toBe('2026-01-11'); // 06:00 local in New York
      expect(n.inBedS).toBe(13 * H);
    });

    it('derives the day from the offset at waking even when UTC is already the next day', () => {
      // wake 00:30 local in Tokyo (UTC+9) on Jan 12 = Jan 11 15:30 UTC
      const n = buildSleepNights([
        {
          startTs: ts('2026-01-11T12:00:00Z'),
          endTs: ts('2026-01-11T15:30:00Z'),
          tzMin: 540,
          text: 'Asleep',
          sourceId: 2,
          sourceName: WATCH.name,
        },
      ])[0]!;
      expect(n.day).toBe('2026-01-12');
    });
  });

  it('returns nights ordered by bedtime and one main night per wake day', () => {
    const records = [
      ...stagedNight('+01:00', '2026-03-11', '2026-03-12'),
      ...stagedNight('+01:00', '2026-03-10', '2026-03-11'),
      rec('2026-03-12T15:00:00+01:00', '2026-03-12T15:30:00+01:00', 'Asleep', WATCH),
    ];
    const r = buildSleepNights(records);
    expect(r.map((x) => [x.day, x.kind])).toEqual([
      ['2026-03-11', 'night'],
      ['2026-03-12', 'night'],
      ['2026-03-12', 'nap'],
    ]);
    for (let i = 1; i < r.length; i++) expect(r[i]!.bedTs).toBeGreaterThan(r[i - 1]!.bedTs);
  });
});
