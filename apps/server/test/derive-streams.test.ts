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

const input = (tr: Track, pauses: [number, number][] = [], endTs = T0 + 600): StreamInput => ({
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
  pauses,
});

describe('first GPS fix', () => {
  it('drops a stale cached position before the real start', () => {
    const tr = track([{ t: T0, lat: TULLN[0], lon: TULLN[1] }, ...fixes(PRATER, 600, 1)]);
    const idx = cleanTrackIndices(tr, T0, T0 + 600, 'run');
    expect(idx).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
    const b = buildStreams(input(tr))!;
    expect(b.breaks).toEqual([]);
    expect(haversine(b.lat![0]!, b.lon![0]!, PRATER[0], PRATER[1])).toBeLessThan(1);
    expect(b.dist![b.dist!.length - 1]).toBeCloseTo(599 * 3, -1);
  });

  it('keeps a real first fix when a short glitch follows it', () => {
    const pts = fixes(PRATER, 600);
    for (let i = 1; i <= 3; i++) [pts[i]!.lat, pts[i]!.lon] = TULLN;
    const idx = cleanTrackIndices(track(pts), T0, T0 + 600, 'run');
    expect(idx[0]).toBe(0);
    expect(idx).not.toContain(1);
    expect(idx).toHaveLength(597);
  });

  it('keeps the first fix of a workout paused right away and resumed elsewhere', () => {
    // started in Tulln, paused for the train, resumed in the Prater an hour later
    const tr = track([{ t: T0, lat: TULLN[0], lon: TULLN[1] }, ...fixes(PRATER, 600, 3600)]);
    const b = buildStreams(input(tr, [[T0 + 1, T0 + 3600]], T0 + 4200))!;
    expect(haversine(b.lat![0]!, b.lon![0]!, TULLN[0], TULLN[1])).toBeLessThan(1);
    expect(b.breaks).toEqual([1]);
  });
});
