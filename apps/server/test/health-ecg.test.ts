import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EcgDetail, EcgSummary } from '@cadence/shared';
import { run } from '../src/db/db';
import { averageHeartRate, classifyEcg, detectRPeaks, ensureEcgStats } from '../src/features/health/ecg';
import { gzipFloat32 } from '../src/lib/gzip';
import { createHealthFixture, ts, type HealthFixture } from './health-fixture';

const RATE = 512;

/** seeded PRNG (mulberry32) so the tests are deterministic */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bump = (t: number, centre: number, sigma: number, amp: number) => amp * Math.exp(-((t - centre) ** 2) / (2 * sigma * sigma));

/**
 * A synthetic lead-I strip: P wave, QRS (small Q and S around a tall R), T wave per beat, baseline wander and noise.
 * `rr` = RR intervals in seconds (cycled). Returns the samples and the true beat times.
 */
function synthEcg(opts: { seconds?: number; rr: number[]; wander?: number; noise?: number; polarity?: 1 | -1; seed?: number }) {
  const seconds = opts.seconds ?? 30;
  const n = seconds * RATE;
  const rnd = prng(opts.seed ?? 1);
  const beats: number[] = [];
  let t = 0.6;
  for (let k = 0; t < seconds - 0.5; k++) {
    beats.push(t);
    t += opts.rr[k % opts.rr.length]!;
  }
  const pol = opts.polarity ?? 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const time = i / RATE;
    let v = (opts.wander ?? 0) * Math.sin(2 * Math.PI * 0.3 * time) + (opts.noise ?? 0) * (rnd() - 0.5) * 2;
    for (const b of beats) {
      if (Math.abs(time - b) > 0.5) continue;
      v +=
        pol *
        (bump(time, b - 0.18, 0.03, 90) + // P
          bump(time, b - 0.025, 0.008, -140) + // Q
          bump(time, b, 0.009, 1100) + // R
          bump(time, b + 0.028, 0.009, -260) + // S
          bump(time, b + 0.26, 0.045, 260)); // T
    }
    x[i] = v;
  }
  return { x, beats };
}

const trueRate = (beats: number[]) => ((beats.length - 1) / (beats[beats.length - 1]! - beats[0]!)) * 60;

describe('R-peak detection', () => {
  it('finds every beat of a regular rhythm and its heart rate', () => {
    const { x, beats } = synthEcg({ rr: [0.8] }); // 75 bpm
    const peaks = detectRPeaks(x, RATE);
    expect(peaks.length).toBe(beats.length);
    // every detected peak lies on a true R wave (±10 ms)
    peaks.forEach((p, i) => expect(Math.abs(p / RATE - beats[i]!)).toBeLessThan(0.01));
    expect(averageHeartRate(peaks, RATE)).toBeCloseTo(75, 0);
  });

  it('copes with baseline wander and noise', () => {
    const { x, beats } = synthEcg({ rr: [0.95], wander: 450, noise: 40, seed: 7 });
    const peaks = detectRPeaks(x, RATE);
    expect(Math.abs(peaks.length - beats.length)).toBeLessThanOrEqual(1);
    expect(Math.abs(averageHeartRate(peaks, RATE)! - trueRate(beats))).toBeLessThan(1.5);
  });

  it('measures the mean rate of an irregular rhythm (atrial fibrillation like)', () => {
    const rnd = prng(3);
    const rr = Array.from({ length: 60 }, () => 0.45 + rnd() * 0.65);
    const { x, beats } = synthEcg({ rr, noise: 20, seed: 11 });
    const peaks = detectRPeaks(x, RATE);
    expect(Math.abs(peaks.length - beats.length)).toBeLessThanOrEqual(1);
    expect(Math.abs(averageHeartRate(peaks, RATE)! - trueRate(beats))).toBeLessThan(3);
  });

  it('also detects inverted QRS complexes and fast rhythms', () => {
    const inverted = synthEcg({ rr: [0.7], polarity: -1 });
    expect(detectRPeaks(inverted.x, RATE).length).toBe(inverted.beats.length);
    const fast = synthEcg({ rr: [0.42] }); // ~143 bpm
    expect(averageHeartRate(detectRPeaks(fast.x, RATE), RATE)).toBeCloseTo(143, -1);
  });

  it('returns nothing for flat, tiny or invalid strips', () => {
    expect(detectRPeaks(new Float32Array(15_360), RATE)).toEqual([]);
    expect(detectRPeaks(new Float32Array(100), RATE)).toEqual([]);
    expect(detectRPeaks(new Float32Array(15_360).fill(Number.NaN), RATE)).toEqual([]);
    expect(detectRPeaks(synthEcg({ rr: [0.8] }).x, 5)).toEqual([]);
    expect(averageHeartRate([100, 700], RATE)).toBeNull();
    expect(averageHeartRate([], RATE)).toBeNull();
    // implausible rates are rejected
    expect(averageHeartRate([0, 10, 20, 30], RATE)).toBeNull();
  });
});

describe('ECG classification', () => {
  it('maps localized classifications of the export onto stable keys', () => {
    expect(classifyEcg('Sinus Rhythm')).toBe('sinus');
    expect(classifyEcg('Sinusrhythmus')).toBe('sinus');
    expect(classifyEcg('Atrial Fibrillation')).toBe('afib');
    expect(classifyEcg('Vorhofflimmern')).toBe('afib');
    expect(classifyEcg('Heart Rate Over 150')).toBe('highHr');
    expect(classifyEcg('Hohe Herzfrequenz')).toBe('highHr');
    expect(classifyEcg('Inconclusive: High Heart Rate')).toBe('highHr');
    expect(classifyEcg('Low Heart Rate')).toBe('lowHr');
    expect(classifyEcg('Niedrige Herzfrequenz')).toBe('lowHr');
    expect(classifyEcg('Poor Recording')).toBe('poor');
    expect(classifyEcg('Schlechte Aufzeichnung')).toBe('poor');
    expect(classifyEcg('Inconclusive')).toBe('inconclusive');
    expect(classifyEcg('Nicht eindeutig')).toBe('inconclusive');
    expect(classifyEcg('Unrecognized')).toBe('unrecognized');
    expect(classifyEcg('')).toBe('unrecognized');
    expect(classifyEcg(null)).toBe('unrecognized');
    expect(classifyEcg('Something else entirely')).toBe('other');
  });
});

describe('ECG endpoints', () => {
  let fx: HealthFixture;
  let id1: number;
  beforeAll(async () => {
    fx = await createHealthFixture();
    const strip = (rr: number) => gzipFloat32(synthEcg({ rr: [rr] }).x);
    const insert = (iso: string, tz: number, cls: string, rr: number, rate: number | null) =>
      run(
        fx.db,
        `INSERT INTO ecg_readings (athlete_id, recorded_ts, tz_min, classification, symptoms, software_version, device, sample_rate_hz, lead, unit, samples)
         VALUES (1, ?, ?, ?, '', '2', 'Watch6,2', ?, 'Lead I', 'µV', ?)`,
        [ts(iso), tz, cls, rate, strip(rr)],
      ).lastInsertRowid;
    id1 = insert('2026-03-01T10:00:00+01:00', 60, 'Sinus Rhythm', 0.8, RATE);
    insert('2026-04-01T10:00:00+02:00', 120, 'Vorhofflimmern', 0.6, RATE);
    insert('2026-05-01T10:00:00+02:00', 120, 'Sinusrhythmus', 1.0, null); // no sample rate recorded
  });
  afterAll(async () => {
    await fx?.close();
  });

  it('lists the recordings newest first with computed average heart rate and class', async () => {
    const list = await fx.getJson<EcgSummary[]>('/api/health/ecg');
    expect(list.map((e) => e.classKey)).toEqual(['sinus', 'afib', 'sinus']);
    expect(list.map((e) => e.recordedTs)).toEqual([ts('2026-05-01T10:00:00+02:00'), ts('2026-04-01T10:00:00+02:00'), ts('2026-03-01T10:00:00+01:00')]);
    const afib = list[1]!;
    expect(afib.classification).toBe('Vorhofflimmern');
    expect(afib.avgHr).toBeCloseTo(100, 0);
    expect(afib.durationS).toBe(30);
    expect(afib.lead).toBe('Lead I');
    expect(afib.symptoms).toBeNull(); // empty string is no symptom
    expect(list[2]!.avgHr).toBeCloseTo(75, 0);
    // without a sample rate nothing can be computed
    expect(list[0]!.avgHr).toBeNull();
    expect(list[0]!.durationS).toBeNull();
  });

  it('serves the waveform with whole microvolts and the R peaks', async () => {
    const d = await fx.getJson<EcgDetail>(`/api/health/ecg/${id1}`);
    expect(d.samples).toHaveLength(15_360);
    expect(d.samples.every((v) => Number.isInteger(v))).toBe(true);
    expect(Math.max(...d.samples)).toBeGreaterThan(900);
    expect(d.rPeaks.length).toBeGreaterThan(30);
    expect(d.rPeaks.length).toBeLessThanOrEqual(38);
    expect(d.sampleRateHz).toBe(512);
    expect((await fx.app.inject({ url: '/api/health/ecg/9999' })).statusCode).toBe(404);
    expect((await fx.app.inject({ url: '/api/health/ecg/abc' })).statusCode).toBe(400);
  });

  it('(re)computes the stats in the derive step helper', () => {
    expect(ensureEcgStats(fx.db, 1)).toBe(0); // all present
    expect(ensureEcgStats(fx.db, 1, true)).toBe(3); // forced rebuild
  });
});
