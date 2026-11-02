import { describe, expect, it } from 'vitest';
import { canonicalUnit, normalizeUnit } from '@cadence/shared';
import { parseDevice, deviceKey } from '../src/import/device';
import {
  aggregationOf,
  categoryText,
  isCumulative,
  parseHumidity,
  parseQuantityString,
  recordKind,
  summarizeStats,
  toSeconds,
  workoutEventType,
} from '../src/import/hk';
import { parseEcgCsv } from '../src/import/ecg';

describe('unit normalisation', () => {
  it('converts Apple units into canonical units', () => {
    expect(normalizeUnit(5, 'km')).toEqual({ value: 5000, unit: 'm' });
    expect(normalizeUnit(1, 'mi').value).toBeCloseTo(1609.344);
    expect(normalizeUnit(154.3236, 'lb').value).toBeCloseTo(70, 3);
    expect(normalizeUnit(418.4, 'kJ').value).toBeCloseTo(100);
    expect(normalizeUnit(50, 'degF').value).toBeCloseTo(10);
    expect(normalizeUnit(36, 'km/hr').value).toBeCloseTo(10);
    expect(normalizeUnit(182, 'cm').value).toBeCloseTo(1.82);
    expect(normalizeUnit(72, 'count/min')).toEqual({ value: 72, unit: 'count/min' });
    expect(canonicalUnit('kcal')).toBe('kcal');
    expect(canonicalUnit(null)).toBeNull();
  });

  it('parses metadata quantities with units', () => {
    expect(parseQuantityString('4500 cm')).toEqual({ value: 45, unit: 'm' });
    expect(parseQuantityString('50 degF')!.value).toBeCloseTo(10);
    expect(parseQuantityString('25 m')).toEqual({ value: 25, unit: 'm' });
    expect(parseQuantityString('25 yd')!.value).toBeCloseTo(22.86);
    expect(parseQuantityString('10.5 kcal/hr·kg')).toEqual({ value: 10.5, unit: 'kcal/hr·kg' });
    expect(parseQuantityString('abc')).toBeNull();
    expect(parseHumidity('8000 %')).toBe(80);
    expect(parseHumidity('58 %')).toBe(58);
    expect(toSeconds(30.5, 'min')).toBe(1830);
    expect(toSeconds(2, 'hr')).toBe(7200);
    expect(toSeconds(90, 's')).toBe(90);
  });
});

describe('HealthKit vocabulary', () => {
  it('classifies record types', () => {
    expect(recordKind('HKQuantityTypeIdentifierHeartRate')).toBe('quantity');
    expect(recordKind('HKCategoryTypeIdentifierSleepAnalysis')).toBe('category');
    expect(recordKind('HKDataTypeSleepDurationGoal')).toBe('other');
    expect(isCumulative('HKQuantityTypeIdentifierStepCount')).toBe(true);
    expect(isCumulative('HKQuantityTypeIdentifierDietaryProtein')).toBe(true);
    expect(isCumulative('HKQuantityTypeIdentifierHeartRate')).toBe(false);
    expect(aggregationOf('HKQuantityTypeIdentifierActiveEnergyBurned', 'quantity')).toBe('sum');
    expect(aggregationOf('HKQuantityTypeIdentifierBodyMass', 'quantity')).toBe('avg');
    expect(aggregationOf('HKCategoryTypeIdentifierMindfulSession', 'category')).toBe('duration');
  });

  it('strips category value prefixes', () => {
    expect(
      categoryText('HKCategoryTypeIdentifierSleepAnalysis', 'HKCategoryValueSleepAnalysisAsleepCore'),
    ).toBe('AsleepCore');
    expect(categoryText('HKCategoryTypeIdentifierAppleStandHour', 'HKCategoryValueAppleStandHourStood')).toBe(
      'Stood',
    );
    expect(categoryText('HKCategoryTypeIdentifierMindfulSession', 'HKCategoryValueNotApplicable')).toBe(
      'NotApplicable',
    );
    expect(categoryText('HKCategoryTypeIdentifierHeadache', 'HKCategoryValueSeverityMild')).toBe(
      'SeverityMild',
    );
    expect(categoryText('HKCategoryTypeIdentifierSleepAnalysis', '0')).toBe('0');
  });

  it('names workout events in snake_case', () => {
    expect(workoutEventType('HKWorkoutEventTypePause')).toBe('pause');
    expect(workoutEventType('HKWorkoutEventTypeMotionResumed')).toBe('motion_resumed');
    expect(workoutEventType('HKWorkoutEventTypePauseOrResumeRequest')).toBe('pause_or_resume_request');
  });

  it('summarises workout statistics', () => {
    const st = (type: string, o: object) => ({
      type: `HKQuantityTypeIdentifier${type}`,
      sum: null,
      average: null,
      minimum: null,
      maximum: null,
      unit: null,
      ...o,
    });
    const s = summarizeStats('run', [
      st('DistanceWalkingRunning', { sum: 10000 }),
      st('ActiveEnergyBurned', { sum: 700 }),
      st('HeartRate', { average: 150, minimum: 100, maximum: 180 }),
      st('RunningPower', { average: 250, maximum: 400 }),
    ]);
    expect(s).toMatchObject({
      distanceM: 10000,
      energyKcal: 700,
      avgHr: 150,
      minHr: 100,
      maxHr: 180,
      avgPower: 250,
      maxPower: 400,
    });
    const multi = summarizeStats('multisport', [
      st('DistanceSwimming', { sum: 1500 }),
      st('DistanceCycling', { sum: 40000 }),
      st('DistanceWalkingRunning', { sum: 10000 }),
    ]);
    expect(multi.distanceM).toBe(51500);
  });
});

describe('device strings', () => {
  it('parses HKDevice descriptions and strips the object pointer', () => {
    const raw =
      '<<HKDevice: 0x283a0d2c0>, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:Watch6,2, software:9.0>';
    const d = parseDevice(raw);
    expect(d).toMatchObject({
      name: 'Apple Watch',
      manufacturer: 'Apple Inc.',
      model: 'Watch',
      hardware: 'Watch6,2',
      software: '9.0',
    });
    expect(deviceKey(raw)).toBe(deviceKey(raw.replace('0x283a0d2c0', '0x111111111')));
    expect(parseDevice('Some App').name).toBe('Some App');
  });
});

describe('ECG CSV', () => {
  const samples = Array.from({ length: 100 }, (_, i) => (Math.sin(i / 5) * 500).toFixed(3)).join('\n');
  it('reads English headers and skips personal data', () => {
    const r = parseEcgCsv(
      `Name,Jane Doe\nDate of Birth,"Jan 1, 1990"\nRecorded Date,2024-05-01 07:30:12 +0200\nClassification,Sinus Rhythm\nSymptoms,\nSoftware Version,2\nDevice,"Watch6,2"\nSample Rate,512 hertz\nLead,Lead I\nUnit,µV\n\n${samples}\n`,
    )!;
    expect(r.recordedTs).toBe(Date.UTC(2024, 4, 1, 5, 30, 12) / 1000);
    expect(r).toMatchObject({
      tzMin: 120,
      classification: 'Sinus Rhythm',
      device: 'Watch6,2',
      sampleRateHz: 512,
      lead: 'Lead I',
      unit: 'µV',
    });
    expect(r.samples.length).toBe(100);
    expect(JSON.stringify(r)).not.toContain('Jane');
  });
  it('reads German headers', () => {
    const r = parseEcgCsv(
      `Name,Max Mustermann\nGeburtsdatum,01.01.1990\nAufnahmedatum,2024-05-01 07:30:12 +0200\nKlassifizierung,Sinusrhythmus\nSymptome,\nSoftwareversion,2\nGerät,"Watch6,2"\nAbtastrate,512 Hertz\nAbleitung,Ableitung I\nEinheit,µV\n\n${samples}\n`,
    )!;
    expect(r).toMatchObject({
      classification: 'Sinusrhythmus',
      sampleRateHz: 512,
      lead: 'Ableitung I',
      device: 'Watch6,2',
    });
    expect(r.samples.length).toBe(100);
  });
  it('returns null without a recording date', () => {
    expect(parseEcgCsv('Name,x\n\n1\n2\n')).toBeNull();
  });
});
