import { describe, expect, it } from 'vitest';
import { elevationGainLoss } from '../src/derive/metrics';
import { buildStreams, isTrackBreak, toDto, trackParts, type StreamInput } from '../src/derive/streams';
import type { Track } from '../src/import/track';
import {
  decodePolyline,
  decodePolylineParts,
  destination,
  encodePolylineParts,
  haversine,
  type LatLon,
} from '../src/lib/geo';

/** A track along a bearing at constant speed, one fix per second, starting at `start` (absolute ts). */
function leg(from: LatLon, bearing: number, speed: number, seconds: number, start: number, ele0 = 10) {
  const pts: { t: number; lat: number; lon: number; ele: number }[] = [];
  for (let i = 0; i < seconds; i++) {
    const [lat, lon] = destination(from[0], from[1], bearing, i * speed);
    pts.push({ t: start + i, lat, lon, ele: ele0 + Math.sin(i / 60) * 2 });
  }
  return pts;
}

function toTrack(pts: { t: number; lat: number; lon: number; ele: number }[]): Track {
  return {
    t: Float64Array.from(pts, (p) => p.t),
    lat: Float64Array.from(pts, (p) => p.lat),
    lon: Float64Array.from(pts, (p) => p.lon),
    ele: Float32Array.from(pts, (p) => p.ele),
    speed: null,
    course: null,
    hAcc: null,
    vAcc: null,
  };
}

const ROSTOCK: LatLon = [54.0887, 12.1405];
const BERLIN: LatLon = [52.52, 13.405];
const T0 = 1_750_000_000;

/** 10 min ride in Rostock, paused 2 h (train), 10 min ride in Berlin, 50 m higher. */
function trainRide(): StreamInput {
  const a = leg(ROSTOCK, 90, 7, 600, T0);
  const b = leg(BERLIN, 0, 7, 600, T0 + 600 + 7200, 60);
  return {
    sport: 'ride',
    startTs: T0,
    endTs: T0 + 600 + 7200 + 600,
    track: toTrack([...a, ...b]),
    hr: null,
    power: null,
    cadence: null,
    steps: null,
    distance: null,
    appleDistanceM: 8400,
    pauses: [[T0 + 600, T0 + 600 + 7200]],
  };
}

describe('track breaks', () => {
  it('classifies gaps between consecutive fixes', () => {
    // travelled while paused
    expect(isTrackBreak(180_000, 7200, true, 35)).toBe(true);
    // short walk while paused, or GPS noise at a red light: no break
    expect(isTrackBreak(120, 600, true, 35)).toBe(false);
    // tunnel without a fix, plausible speed: keep the distance
    expect(isTrackBreak(1200, 150, false, 35)).toBe(false);
    // the position was lost for a long way
    expect(isTrackBreak(8000, 1800, false, 35)).toBe(true);
    // a persistent, implausibly fast jump
    expect(isTrackBreak(900, 20, false, 12)).toBe(true);
  });

  it('splits a workout paused for a train ride into two parts', () => {
    const b = buildStreams(trainRide())!;
    expect(b.gps).toBe(true);
    expect(b.breaks).toEqual([600]);
    // ~8.4 km ridden (Apple's distance), not the ~180 km between Rostock and Berlin
    expect(b.dist![b.t.length - 1]!).toBeGreaterThan(8000);
    expect(b.dist![b.t.length - 1]!).toBeLessThan(9000);
    expect(b.dist![600]).toBe(b.dist![599]);
    expect(b.moving[600]).toBe(0);
    expect(haversine(b.lat![599]!, b.lon![599]!, b.lat![600]!, b.lon![600]!)).toBeGreaterThan(150_000);
    expect(toDto(b).breaks).toEqual([600]);
    expect(trackParts(b.t.length, b.breaks)).toEqual([
      [0, 600],
      [600, 1200],
    ]);
  });

  it('keeps the first fixes after the pause even when they are implausibly far for the sport', () => {
    const run = { ...trainRide(), sport: 'run', appleDistanceM: 8400 };
    const b = buildStreams(run)!;
    // without the pause exception the glitch filter dropped the first 8 fixes in Berlin
    expect(b.t.length).toBe(1200);
    expect(b.breaks).toEqual([600]);
  });

  it('does not split an ordinary track', () => {
    const inp = trainRide();
    const a = leg(ROSTOCK, 90, 7, 1200, T0);
    const b = buildStreams({ ...inp, track: toTrack(a), endTs: T0 + 1200, pauses: [] })!;
    expect(b.breaks).toEqual([]);
    expect(toDto(b).breaks).toBeUndefined();
    expect(trackParts(b.t.length, b.breaks)).toEqual([[0, 1200]]);
  });

  it('does not count the elevation difference between parts', () => {
    const ele = new Float64Array(200);
    for (let i = 0; i < 200; i++) ele[i] = i < 100 ? 10 : 400;
    expect(elevationGainLoss(ele).gain).toBeGreaterThan(380);
    expect(elevationGainLoss(ele, 2, 5, [100])).toEqual({ gain: 0, loss: 0 });
  });

  it('encodes and decodes multi-part polylines', () => {
    const a: LatLon[] = [
      [54.08, 12.14],
      [54.09, 12.15],
    ];
    const b: LatLon[] = [
      [52.52, 13.4],
      [52.53, 13.41],
      [52.54, 13.42],
    ];
    const enc = encodePolylineParts([a, b, [[1, 1]]]);
    expect(enc.split(' ')).toHaveLength(2);
    const parts = decodePolylineParts(enc);
    expect(parts.map((p) => p.length)).toEqual([2, 3]);
    expect(parts[1]![2]![0]).toBeCloseTo(52.54, 5);
    // the flat decoder still returns every point
    expect(decodePolyline(enc)).toHaveLength(5);
    expect(decodePolylineParts(encodePolylineParts([a]))).toHaveLength(1);
  });
});
