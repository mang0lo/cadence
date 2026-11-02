import { describe, expect, it } from 'vitest';
import { BEST_EFFORTS } from '@cadence/shared';
import {
  bestEfforts,
  computeSplits,
  elevationGainLoss,
  hrHistogram,
  movingTime,
  trimpFromAverage,
  trimpFromHistogram,
  zonesFromHistogram,
} from '../src/derive/metrics';
import { buildStreams, cumulativeAt, pausedIntervals, rateAt, sampleAt } from '../src/derive/streams';

/** t = 0..n-1 s, constant speed v */
function constant(n: number, v: number) {
  const t = Float64Array.from({ length: n }, (_, i) => i);
  const dist = Float64Array.from({ length: n }, (_, i) => i * v);
  return { t, dist };
}

describe('best efforts', () => {
  it('finds exact times at constant speed (with interpolation)', () => {
    const { t, dist } = constant(3601, 3.2); // 1 h at 3.2 m/s = 11.52 km
    const r = bestEfforts(t, dist, BEST_EFFORTS.run!, 'run');
    const by = Object.fromEntries(r.map((e) => [e.key, e.elapsedS]));
    expect(by['1k']).toBeCloseTo(1000 / 3.2, 6);
    expect(by['5k']).toBeCloseTo(5000 / 3.2, 6);
    expect(by['10k']).toBeCloseTo(10000 / 3.2, 6);
    expect(by['15k']).toBeUndefined();
  });

  it('finds the fastest window and its offset', () => {
    // 2 km easy (3 m/s), 1 km fast (5 m/s), 2 km easy
    const t: number[] = [0];
    const d: number[] = [0];
    let s = 0;
    let time = 0;
    while (s < 5000) {
      const v = s >= 2000 && s < 3000 ? 5 : 3;
      time += 1;
      s += v;
      t.push(time);
      d.push(s);
    }
    const r = bestEfforts(
      Float64Array.from(t),
      Float64Array.from(d),
      [{ key: '1k', distanceM: 1000, label: { en: '', de: '' } }],
      'run',
    );
    expect(r[0]!.elapsedS).toBeCloseTo(200, 0);
    expect(r[0]!.startOffsetS).toBeCloseTo(2000 / 3, 0);
  });

  it('rejects physiologically implausible windows (GPS spikes)', () => {
    const { t, dist } = constant(1201, 3);
    // a 300 m jump within one second
    for (let i = 600; i < dist.length; i++) dist[i] = dist[i]! + 300;
    const r = bestEfforts(t, dist, [{ key: '400m', distanceM: 400, label: { en: '', de: '' } }], 'run');
    // 400 m in < 400/10.5 s is impossible on foot → the spike window is skipped
    expect(r[0]!.elapsedS).toBeGreaterThanOrEqual(400 / 10.5);
  });
});

describe('splits', () => {
  it('splits per km with a partial last split', () => {
    const { t, dist } = constant(1001, 2.5); // 2.5 km
    const ele = Float64Array.from({ length: 1001 }, (_, i) => 100 + i * 0.01);
    const hr = Float64Array.from({ length: 1001 }, () => 150);
    const s = computeSplits(t, dist, 1000, { ele, hr });
    expect(s.length).toBe(3);
    expect(s[0]).toMatchObject({ idx: 0, distanceM: 1000 });
    expect(s[0]!.elapsedS).toBeCloseTo(400, 6);
    expect(s[0]!.avgSpeed).toBeCloseTo(2.5, 6);
    expect(s[0]!.elevDiffM).toBeCloseTo(4, 6);
    expect(s[0]!.avgHr).toBeCloseTo(150, 6);
    expect(s[2]!.distanceM).toBeCloseTo(500, 6);
    const mi = computeSplits(t, dist, 1609.344);
    expect(mi.length).toBe(2);
  });

  it('uses moving time for split pace', () => {
    const { t, dist } = constant(1001, 2);
    const moving = new Uint8Array(1001).fill(1);
    for (let i = 100; i < 200; i++) {
      moving[i] = 0;
      dist[i] = dist[99]!;
    }
    for (let i = 200; i < 1001; i++) dist[i] = dist[i]! - 200;
    const s = computeSplits(t, dist, 1000, { moving });
    expect(s[0]!.elapsedS).toBeCloseTo(600, 6);
    expect(s[0]!.movingS).toBeCloseTo(500, 6);
    expect(movingTime(t, moving)).toBe(900);
  });
});

describe('heart rate metrics', () => {
  it('builds a histogram and derives zones and TRIMP', () => {
    const t = Float64Array.from({ length: 3601 }, (_, i) => i);
    const hr = Float64Array.from({ length: 3601 }, (_, i) => (i < 1800 ? 120 : 160));
    const h = hrHistogram(t, hr)!;
    // 1 s intervals: 1799 at 120 bpm, the transition interval averages 140, 1800 at 160 bpm
    expect(h[120]).toBe(1799);
    expect(h[140]).toBe(1);
    expect(h[160]).toBe(1800);
    expect(zonesFromHistogram(h, [114, 133, 152, 171])).toEqual([0, 1799, 1, 1800, 0]);
    const male = trimpFromHistogram(h, 60, 190, 'male');
    const female = trimpFromHistogram(h, 60, 190, 'female');
    expect(male).toBeGreaterThan(female);
    // 1 h at HRr 0.5 (male): 60 · 0.5 · 0.64 · e^(0.96) ≈ 50
    expect(trimpFromAverage(125, 3600, 60, 190, 'male')).toBeCloseTo(
      60 * 0.5 * 0.64 * Math.exp(1.92 * 0.5),
      3,
    );
  });

  it('computes elevation gain with hysteresis', () => {
    const ele = Float64Array.from(
      { length: 400 },
      (_, i) => 100 + 20 * Math.sin(i / 40) + (i % 2 ? 0.4 : -0.4),
    );
    const { gain, loss } = elevationGainLoss(ele);
    expect(gain).toBeGreaterThan(50);
    expect(gain).toBeLessThan(100);
    expect(loss).toBeGreaterThan(30);
  });
});

describe('stream building blocks', () => {
  it('interpolates samples but not across gaps > 30 s', () => {
    const series = { t: Float64Array.from([0, 10, 100]), v: Float64Array.from([100, 120, 140]) };
    const out = sampleAt(series, Float64Array.from([0, 5, 10, 50, 98, 104, 200]), 30);
    expect(out[0]).toBe(100);
    expect(out[1]).toBe(110);
    expect(out[2]).toBe(120);
    expect(Number.isNaN(out[3]!)).toBe(true);
    expect(out[4]).toBe(140);
    expect(out[5]).toBe(140);
    expect(Number.isNaN(out[6]!)).toBe(true);
  });

  it('integrates interval records and converts them to rates', () => {
    const iv = {
      s: Float64Array.from([0, 60]),
      e: Float64Array.from([60, 120]),
      v: Float64Array.from([170, 180]),
    };
    expect(Array.from(cumulativeAt(iv, Float64Array.from([0, 30, 60, 90, 120, 200])))).toEqual([
      0, 85, 170, 260, 350, 350,
    ]);
    expect(Array.from(rateAt(iv, Float64Array.from([30, 90])))).toEqual([170, 180]);
  });

  it('turns pause/resume events into intervals', () => {
    expect(
      pausedIntervals(
        [
          { type: 'pause', ts: 100 },
          { type: 'resume', ts: 160 },
          { type: 'motion_paused', ts: 300 },
        ],
        400,
      ),
    ).toEqual([
      [100, 160],
      [300, 400],
    ]);
  });

  it('builds a 5 s grid for workouts without GPS', () => {
    const b = buildStreams({
      sport: 'run',
      startTs: 1000,
      endTs: 1000 + 600,
      track: null,
      hr: {
        t: Float64Array.from({ length: 121 }, (_, i) => 1000 + i * 5),
        v: new Float64Array(121).fill(150),
      },
      power: null,
      cadence: null,
      steps: null,
      distance: {
        s: Float64Array.from([1000, 1300]),
        e: Float64Array.from([1300, 1600]),
        v: Float64Array.from([900, 900]),
      },
      appleDistanceM: 1800,
      pauses: [],
    })!;
    expect(b.gps).toBe(false);
    expect(b.t.length).toBe(121);
    expect(b.dist![120]).toBeCloseTo(1800, 6);
    expect(b.speed![60]).toBeCloseTo(3, 6);
    expect(b.hr![50]).toBe(150);
  });
});
