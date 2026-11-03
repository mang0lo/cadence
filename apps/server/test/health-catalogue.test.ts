import { describe, expect, it } from 'vitest';
import {
  HEALTH_CATEGORIES,
  METRIC_DEFS,
  autoDigits,
  bmi,
  bmiSeries,
  categoryValueLabel,
  classifyBloodPressure,
  compareWindows,
  dayFromNumber,
  dayNumber,
  displaySpec,
  inferKind,
  leanMassSeries,
  mean,
  meanBetween,
  median,
  metricCategory,
  metricDef,
  metricGood,
  metricName,
  midnightOffsetMin,
  minutesOfDay,
  monthlyAverages,
  prettifyIdentifier,
  rollingMeanByDay,
  shiftDay,
  splitMetric,
  stdev,
  trailingChange,
} from '@cadence/shared';

describe('health catalogue', () => {
  it('has ~150 unique identifiers with en + de names and a known category', () => {
    expect(METRIC_DEFS.length).toBeGreaterThanOrEqual(140);
    const ids = new Set(METRIC_DEFS.map((d) => d.identifier));
    expect(ids.size).toBe(METRIC_DEFS.length);
    const cats = new Set(HEALTH_CATEGORIES.map((c) => c.key));
    for (const d of METRIC_DEFS) {
      // HealthKit types, plus the values synced from the COROS cloud (kept apart from Apple's)
      expect(d.identifier).toMatch(/^(HK(Quantity|Category)TypeIdentifier|COROS)[A-Za-z0-9]+$/);
      expect(d.en.length).toBeGreaterThan(1);
      expect(d.de.length).toBeGreaterThan(1);
      expect(cats.has(d.category)).toBe(true);
    }
    // every category of the explorer is used by at least one definition
    for (const c of HEALTH_CATEGORIES) expect(METRIC_DEFS.some((d) => d.category === c.key)).toBe(true);
  });

  it('names known identifiers in both languages and prettifies unknown ones', () => {
    expect(metricName('HKQuantityTypeIdentifierRestingHeartRate', 'en')).toBe('Resting heart rate');
    expect(metricName('HKQuantityTypeIdentifierRestingHeartRate', 'de')).toBe('Ruheherzfrequenz');
    expect(metricName('HKQuantityTypeIdentifierSomethingNewAndShiny', 'en')).toBe('Something New And Shiny');
    expect(prettifyIdentifier('HKQuantityTypeIdentifierVO2MaxEstimate')).toBe('VO2 Max Estimate');
    expect(prettifyIdentifier('HKCategoryTypeIdentifierABCTest')).toBe('ABC Test');
    expect(prettifyIdentifier('HKDataTypeIdentifierAudiogram')).toBe('Audiogram');
  });

  it('resolves composite category metrics to their type', () => {
    expect(splitMetric('HKCategoryTypeIdentifierSleepAnalysis:AsleepCore')).toEqual({
      identifier: 'HKCategoryTypeIdentifierSleepAnalysis',
      value: 'AsleepCore',
    });
    expect(metricDef('HKCategoryTypeIdentifierSleepAnalysis:AsleepCore')?.category).toBe('sleep');
    expect(metricName('HKCategoryTypeIdentifierMindfulSession:NotApplicable', 'de')).toBe('Achtsamkeitsminuten');
    expect(categoryValueLabel('AsleepREM', 'de')).toBe('REM');
    expect(categoryValueLabel('SomeNewValue', 'en')).toBe('Some New Value');
  });

  it('knows which direction is good', () => {
    expect(metricGood('HKQuantityTypeIdentifierRestingHeartRate')).toBe('down');
    expect(metricGood('HKQuantityTypeIdentifierHeartRateVariabilitySDNN')).toBe('up');
    expect(metricGood('HKQuantityTypeIdentifierBodyMass')).toBeNull();
    expect(metricGood('HKQuantityTypeIdentifierUnknownThing')).toBeNull();
  });

  it('guesses a category for unknown identifiers', () => {
    expect(metricCategory('HKQuantityTypeIdentifierDietaryNewNutrient')).toBe('nutrition');
    expect(metricCategory('HKQuantityTypeIdentifierHeartRateSomething')).toBe('heart');
    expect(metricCategory('HKQuantityTypeIdentifierTotallyUnknown')).toBe('other');
  });
});

describe('display specs', () => {
  it('shows fractions as percent', () => {
    const s = displaySpec('HKQuantityTypeIdentifierOxygenSaturation', '%', 'metric');
    expect(s.unit).toBe('%');
    expect(s.convert(0.965)).toBeCloseTo(96.5, 6);
    const bf = displaySpec('HKQuantityTypeIdentifierBodyFatPercentage', '%', 'metric');
    expect(bf.digits).toBe(1);
  });

  it('converts weight, distance, length, speed and temperature for imperial units', () => {
    const w = displaySpec('HKQuantityTypeIdentifierBodyMass', 'kg', 'imperial');
    expect(w.unit).toBe('lb');
    expect(w.convert(75)).toBeCloseTo(165.35, 1);
    expect(displaySpec('HKQuantityTypeIdentifierBodyMass', 'kg', 'metric').convert(75)).toBe(75);
    const d = displaySpec('HKQuantityTypeIdentifierDistanceWalkingRunning', 'm', 'imperial');
    expect(d.unit).toBe('mi');
    expect(d.convert(1609.344)).toBeCloseTo(1, 6);
    expect(displaySpec('HKQuantityTypeIdentifierDistanceWalkingRunning', 'm', 'metric').convert(12_500)).toBe(12.5);
    const step = displaySpec('HKQuantityTypeIdentifierWalkingStepLength', 'm', 'metric');
    expect(step.unit).toBe('cm');
    expect(step.convert(0.74)).toBeCloseTo(74, 6);
    const speed = displaySpec('HKQuantityTypeIdentifierWalkingSpeed', 'm/s', 'metric');
    expect(speed.unit).toBe('km/h');
    expect(speed.convert(1.5)).toBeCloseTo(5.4, 6);
    const t = displaySpec('HKQuantityTypeIdentifierBodyTemperature', 'degC', 'imperial');
    expect(t.unit).toBe('°F');
    expect(t.convert(37)).toBeCloseTo(98.6, 1);
    expect(displaySpec('HKQuantityTypeIdentifierDistanceSwimming', 'm', 'imperial').unit).toBe('yd');
  });

  it('formats durations in minutes and overrides unit labels', () => {
    const e = displaySpec('HKQuantityTypeIdentifierAppleExerciseTime', 'min', 'metric');
    expect(e.duration).toBe('minutes');
    expect(displaySpec('HKCategoryTypeIdentifierMindfulSession', null, 'metric').duration).toBe('minutes');
    expect(displaySpec('HKQuantityTypeIdentifierCyclingCadence', 'count/min', 'metric').unit).toBe('rpm');
    expect(displaySpec('HKQuantityTypeIdentifierBodyMassIndex', 'count', 'metric').unit).toBe('kg/m²');
  });

  it('infers the format of unknown identifiers from the canonical unit', () => {
    expect(inferKind('HKQuantityTypeIdentifierX', 'count/min')).toBe('perMin');
    expect(inferKind('HKQuantityTypeIdentifierSomeHeartRateX', 'count/min')).toBe('bpm');
    expect(inferKind('HKQuantityTypeIdentifierX', '%', 0.97)).toBe('fraction');
    expect(inferKind('HKQuantityTypeIdentifierX', '%', 42)).toBe('percent');
    expect(inferKind('HKQuantityTypeIdentifierDietaryX', 'kg')).toBe('massG');
    expect(inferKind('HKQuantityTypeIdentifierDistanceNew', 'm')).toBe('distance');
    expect(inferKind('HKQuantityTypeIdentifierX', 'weird/unit')).toBe('decimal');
    const unknown = displaySpec('HKQuantityTypeIdentifierMysteryValue', 'mg/dL', 'metric');
    expect(unknown.unit).toBe('mg/dL');
    // dietary grams are stored as kg
    const protein = displaySpec('HKQuantityTypeIdentifierDietaryProtein', 'kg', 'metric');
    expect(protein.unit).toBe('g');
    expect(protein.convert(0.03)).toBeCloseTo(30, 6);
    expect(autoDigits(250)).toBe(0);
    expect(autoDigits(25)).toBe(1);
    expect(autoDigits(2.5)).toBe(2);
  });
});

describe('health analytics helpers', () => {
  it('does day arithmetic without time zones', () => {
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayFromNumber(dayNumber('2026-02-28') + 1)).toBe('2026-03-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('computes mean, median and sample standard deviation', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdev([1])).toBeNull();
  });

  it('computes trailing means over calendar days (not over a number of points)', () => {
    const pts = [
      { day: '2026-01-01', value: 10 },
      { day: '2026-01-02', value: 20 },
      { day: '2026-01-05', value: 30 },
      { day: '2026-01-10', value: 40 },
    ];
    const r = rollingMeanByDay(pts, 7);
    expect(r[0]).toBe(10);
    expect(r[1]).toBe(15);
    expect(r[2]).toBe(20); // Jan 1, 2, 5 all within (Dec 29, Jan 5]
    expect(r[3]).toBe(35); // window (Jan 3, Jan 10] holds Jan 5 and Jan 10
    expect(rollingMeanByDay(pts, 7, 2)[0]).toBeNull();
  });

  it('computes monthly means and the signed change to the previous calendar month', () => {
    const pts = [
      { day: '2026-01-05', value: 80 },
      { day: '2026-01-25', value: 78 },
      { day: '2026-02-10', value: 77 },
      { day: '2026-04-01', value: 75 },
    ];
    const m = monthlyAverages(pts);
    expect(m.map((x) => x.month)).toEqual(['2026-01', '2026-02', '2026-04']);
    expect(m[0]).toMatchObject({ mean: 79, n: 2, change: null });
    expect(m[1]!.change).toBeCloseTo(-2, 6);
    expect(m[2]!.change).toBeNull(); // March is missing
    expect(monthlyAverages([{ day: '2025-12-31', value: 1 }, { day: '2026-01-01', value: 3 }])[1]!.change).toBe(2);
  });

  it('compares windows with a correctly signed difference', () => {
    expect(compareWindows(52, 55)).toEqual({ current: 52, previous: 55, diff: -3, pct: -3 / 55 });
    expect(compareWindows(60, 50).pct).toBeCloseTo(0.2, 6);
    expect(compareWindows(null, 50).diff).toBeNull();
    expect(compareWindows(5, 0).pct).toBeNull();
  });

  it('classifies blood pressure (ACC/AHA)', () => {
    expect(classifyBloodPressure(115, 75)).toBe('normal');
    expect(classifyBloodPressure(124, 78)).toBe('elevated');
    expect(classifyBloodPressure(128, 84)).toBe('stage1');
    expect(classifyBloodPressure(135, 70)).toBe('stage1');
    expect(classifyBloodPressure(145, 85)).toBe('stage2');
    expect(classifyBloodPressure(120, 95)).toBe('stage2');
    expect(classifyBloodPressure(190, 100)).toBe('crisis');
  });

  it('maps clock times around midnight to continuous offsets', () => {
    // 2026-01-10 23:30 local (UTC+1) = 22:30 UTC
    const bed = Date.UTC(2026, 0, 10, 22, 30) / 1000;
    expect(minutesOfDay(bed, 60)).toBe(23 * 60 + 30);
    expect(midnightOffsetMin(bed, 60)).toBe(-30);
    const after = Date.UTC(2026, 0, 11, 0, 30) / 1000; // 01:30 local
    expect(midnightOffsetMin(after, 60)).toBe(90);
    const wake = Date.UTC(2026, 0, 11, 6, 45) / 1000; // 07:45 local
    expect(midnightOffsetMin(wake, 60)).toBe(465);
    // negative offsets (west of Greenwich) wrap correctly
    expect(minutesOfDay(Date.UTC(2026, 0, 11, 2, 0) / 1000, -300)).toBe(21 * 60);
  });

  it('computes BMI only for plausible inputs', () => {
    expect(bmi(75, 1.82)).toBeCloseTo(22.64, 2);
    expect(bmi(75, 0)).toBeNull();
    expect(bmi(0, 1.8)).toBeNull();
  });

  it('averages values within a day range', () => {
    const pts = [
      { day: '2026-03-01', value: 10 },
      { day: '2026-03-05', value: 20 },
      { day: '2026-03-09', value: 30 },
    ];
    expect(meanBetween(pts, '2026-03-02', '2026-03-09')).toBe(25);
    expect(meanBetween(pts, '2026-04-01', '2026-04-30')).toBeNull();
  });

  it('compares the latest weeks of a sparse measure with the weeks a month earlier', () => {
    const pts: { day: string; value: number }[] = [];
    // weight every third day: 80 kg until Feb 10, then 78 kg
    for (let i = 0; i < 60; i += 3) {
      const day = dayFromNumber(dayNumber('2026-01-01') + i);
      pts.push({ day, value: day <= '2026-02-10' ? 80 : 78 });
    }
    const c = trailingChange(pts, 30, 14)!;
    expect(c.recent).toBe(78);
    expect(c.prior).toBe(80);
    expect(c.diff).toBe(-2);
    expect(trailingChange([], 30, 14)).toBeNull();
    // no data in the window a month earlier
    expect(trailingChange([{ day: '2026-03-01', value: 70 }], 30, 14)).toBeNull();
  });

  it('derives BMI and lean mass series where the inputs exist', () => {
    const weight = [
      { day: '2026-03-01', value: 80 },
      { day: '2026-03-02', value: 79 },
    ];
    expect(bmiSeries(weight, 1.8).map((p) => Math.round(p.value * 10) / 10)).toEqual([24.7, 24.4]);
    expect(bmiSeries(weight, null)).toEqual([]);
    const lean = leanMassSeries(weight, [{ day: '2026-03-02', value: 0.2 }, { day: '2026-03-03', value: 0.2 }]);
    expect(lean).toHaveLength(1);
    expect(lean[0]!.day).toBe('2026-03-02');
    expect(lean[0]!.value).toBeCloseTo(63.2, 6);
    // body fat given as a percentage instead of a fraction is ignored
    expect(leanMassSeries(weight, [{ day: '2026-03-01', value: 20 }])).toEqual([]);
  });
});
