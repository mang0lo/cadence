import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, get, run } from '../src/db/db';
import type { DeriveChanges, DeriveContext } from '../src/features/types';
import { classifyEcg, reclassifyEcgs } from '../src/features/health/ecg';
import { rebuildSleepNights, sleepStep } from '../src/features/health/sleep';
import { updateSettings } from '../src/core/settings';
import { addDays } from '../src/lib/time';
import { createHealthFixture, ts, type HealthFixture } from './health-fixture';

let fx: HealthFixture;
const SLEEP = 'HKCategoryTypeIdentifierSleepAnalysis';
const FIRST = '2026-03-01'; // wake days 2026-03-01 … 2026-03-10
const NIGHTS = 10;
const LAST = addDays(FIRST, NIGHTS - 1);

const sourceOf = (day: string) =>
  get<{ source: string | null }>(fx.db, "SELECT source FROM health_sleep_nights WHERE kind = 'night' AND day = ?", [day])?.source;
const markStale = () => run(fx.db, "UPDATE health_sleep_nights SET source = 'stale'");

const ctx = (changes: DeriveChanges | undefined, sinceDay: string | null = FIRST): DeriveContext => ({
  db: fx.db,
  athleteId: 1,
  workoutIds: [],
  sinceDay,
  report: () => {},
  checkCancelled: () => {},
  log: () => {},
  changes,
});
const changes = (recordTypes: DeriveChanges['recordTypes']): DeriveChanges => ({ recordTypes, effortBasis: false, duplicateFlips: [] });

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.sleep = fx.addType(1, SLEEP, 'category', null, 'duration');
  fx.T.hr = fx.addType(2, 'HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg');
  for (let i = 0; i < NIGHTS; i++) {
    const wake = addDays(FIRST, i);
    fx.rec(fx.T.sleep, `${addDays(wake, -1)}T23:00:00+01:00`, `${wake}T03:00:00+01:00`, { text: 'AsleepCore' });
    fx.rec(fx.T.sleep, `${wake}T03:00:00+01:00`, `${wake}T06:30:00+01:00`, { text: 'AsleepDeep' });
  }
  fx.refreshStats();
  updateSettings(fx.db, 1, { watch: 'apple', sources: { workouts: 'auto', heart: 'auto' } });
  rebuildSleepNights(fx.db, 1, null);
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('health.sleep derive step', () => {
  beforeEach(() => {
    rebuildSleepNights(fx.db, 1, null);
    markStale();
  });

  it('leaves the nights alone when the run brought other records only (or none)', async () => {
    await sleepStep.run(ctx(changes(new Map([['HKQuantityTypeIdentifierHeartRate', ts(`${FIRST}T10:00:00+01:00`)]]))));
    expect(sourceOf(FIRST)).toBe('stale');
    expect(sourceOf(LAST)).toBe('stale');
    await sleepStep.run(ctx(changes(new Map())));
    expect(sourceOf(LAST)).toBe('stale');
  });

  it('rebuilds the nights around new sleep records only', async () => {
    const recordTypes = new Map([
      [SLEEP, ts(`${addDays(LAST, -1)}T23:00:00+01:00`)],
      ['HKQuantityTypeIdentifierHeartRate', ts(`${FIRST}T10:00:00+01:00`)],
    ]);
    await sleepStep.run(ctx(changes(recordTypes)));
    expect(sourceOf(LAST)).toBe('Apple Watch von Hannes');
    expect(sourceOf(FIRST)).toBe('stale'); // a week before the new sleep records
  });

  it('rebuilds from sinceDay when every record type may have changed, or nothing says what changed', async () => {
    await sleepStep.run(ctx(changes('all')));
    expect(sourceOf(FIRST)).toBe('Apple Watch von Hannes');
    markStale();
    await sleepStep.run(ctx(undefined));
    expect(sourceOf(FIRST)).toBe('Apple Watch von Hannes');
  });

  it('still rebuilds every night after the heart source preference changed', async () => {
    updateSettings(fx.db, 1, { watch: 'coros' });
    try {
      await sleepStep.run(ctx(changes(new Map()), LAST));
      // no COROS nights here: Apple's nights again, but rebuilt for the new preference
      expect(sourceOf(FIRST)).toBe('Apple Watch von Hannes');
    } finally {
      updateSettings(fx.db, 1, { watch: 'apple' });
    }
  });
});

describe('ECG classifications in other languages', () => {
  it('maps French, Spanish and Japanese wording onto the stable keys', () => {
    const cases: [string, string][] = [
      ['Rythme sinusal', 'sinus'],
      ['Ritmo sinusal', 'sinus'],
      ['洞調律', 'sinus'],
      ['Fibrillation auriculaire', 'afib'],
      ['Fibrilación auricular', 'afib'],
      ['心房細動', 'afib'],
      ['Fréquence cardiaque élevée', 'highHr'],
      ['Fréquence cardiaque supérieure à 150', 'highHr'],
      ['Frecuencia cardiaca alta', 'highHr'],
      ['Frecuencia cardíaca superior a 120', 'highHr'],
      ['高心拍数', 'highHr'],
      ['Fréquence cardiaque faible', 'lowHr'],
      ['Fréquence cardiaque basse', 'lowHr'],
      ['Frecuencia cardiaca baja', 'lowHr'],
      ['Frecuencia cardíaca inferior a 50', 'lowHr'],
      ['低心拍数', 'lowHr'],
      ['Enregistrement de mauvaise qualité', 'poor'],
      ['Registro deficiente', 'poor'],
      ['記録不良', 'poor'],
      ['Non concluant', 'inconclusive'],
      ['Résultat non concluant', 'inconclusive'],
      ['No concluyente', 'inconclusive'],
      ['判定不能', 'inconclusive'],
      ['Non reconnu', 'unrecognized'],
      ['No reconocido', 'unrecognized'],
    ];
    for (const [text, key] of cases) expect(classifyEcg(text), text).toBe(key);
    // the English and German wording keeps its keys
    expect(classifyEcg('Sinus Rhythm')).toBe('sinus');
    expect(classifyEcg('Inconclusive: High Heart Rate')).toBe('highHr');
    expect(classifyEcg('Nicht eindeutig')).toBe('inconclusive');
    expect(classifyEcg('Something else')).toBe('other');
  });

  it('re-classifies the stored recordings of an older version', () => {
    run(fx.db, "INSERT INTO ecg_readings (id, athlete_id, recorded_ts, classification) VALUES (1, 1, 1000, 'Rythme sinusal'), (2, 1, 2000, 'Sinus Rhythm')");
    run(fx.db, "INSERT INTO health_ecg_stats (ecg_id, athlete_id, class_key) VALUES (1, 1, 'other'), (2, 1, 'sinus')");
    expect(reclassifyEcgs(fx.db)).toBe(1);
    expect(all<{ class_key: string }>(fx.db, 'SELECT class_key FROM health_ecg_stats ORDER BY ecg_id').map((r) => r.class_key)).toEqual([
      'sinus',
      'sinus',
    ]);
  });
});
