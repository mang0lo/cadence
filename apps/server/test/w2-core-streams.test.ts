import { describe, expect, it } from 'vitest';
import { buildStreams, cleanTrackIndices, type StreamInput } from '../src/derive/streams';
import type { Track } from '../src/import/track';
import { destination, haversine, type LatLon } from '../src/lib/geo';

const T0 = 1_750_000_000;
const PRATER: LatLon = [48.2082, 16.3938];
/** Where the watch last had a position, 26 km away. */
const TULLN: LatLon = [48.3306, 16.0567];

/** One fix per second at 3 m/s heading east from `from`, starting at T0 + `t0` (good accuracy). */
function fixes(from: LatLon, seconds: number, t0 = 0): { t: number; lat: number; lon: number }[] {
  return Array.from({ length: seconds }, (_, i) => {
    const [lat, lon] = destination(from[0], from[1], 90, i * 3);
    return { t: T0 + t0 + i, lat, lon };
  });
}

/** `n` fixes one second apart at (about) `at`: a cached position the watch repeats until it has a real fix. */
const repeated = (at: LatLon, n: number, driftM = 0) =>
  Array.from({ length: n }, (_, i) => {
    const [lat, lon] = destination(at[0], at[1], 0, i * driftM);
    return { t: T0 + i, lat, lon };
  });

function track(pts: { t: number; lat: number; lon: number }[]): Track {
  return {
    t: Float64Array.from(pts, (p) => p.t),
    lat: Float64Array.from(pts, (p) => p.lat),
    lon: Float64Array.from(pts, (p) => p.lon),
    ele: null,
    speed: null,
    course: null,
    hAcc: Float32Array.from(pts, () => 5),
    vAcc: null,
  };
}

const input = (tr: Track, endTs = T0 + 700): StreamInput => ({
  sport: 'run',
  startTs: T0,
  endTs,
  track: tr,
  hr: null,
  power: null,
  cadence: null,
  steps: null,
  distance: null,
  appleDistanceM: null,
  pauses: [],
});

describe('stale GPS fixes at the start', () => {
  it('drops a cached position the watch repeated before the real start, and keeps every real fix', () => {
    for (const [n, drift] of [[2, 0], [3, 0], [5, 1]] as const) {
      const tr = track([...repeated(TULLN, n, drift), ...fixes(PRATER, 600, n)]);
      const idx = cleanTrackIndices(tr, T0, T0 + 700, 'run');
      expect(idx, `${n} stale fixes`).toEqual(Array.from({ length: 600 }, (_, i) => i + n));
      const b = buildStreams(input(tr))!;
      expect(b.breaks).toEqual([]);
      expect(haversine(b.lat![0]!, b.lon![0]!, PRATER[0], PRATER[1])).toBeLessThan(1);
      expect(b.dist![b.dist!.length - 1]).toBeCloseTo(599 * 3, -1);
    }
  });

  it('keeps a start where the athlete really stood or moved before a jump', () => {
    // standing at the start for longer than a cached position lasts: kept (the jump is a break, not a stale start)
    const standing = track([...repeated(PRATER, 30), ...fixes(TULLN, 600, 30)]);
    expect(cleanTrackIndices(standing, T0, T0 + 700, 'run')[0]).toBe(0);
    // moving at the start: kept as well
    const moving = track([...fixes(PRATER, 20), ...fixes(TULLN, 600, 20)]);
    expect(cleanTrackIndices(moving, T0, T0 + 700, 'run')[0]).toBe(0);
  });
});
