import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeTrack, encodeTrack, type Track } from '../src/import/track';
import { gunzip, gunzipFloat32, gunzipJson, gzipFloat32, gzipJson } from '../src/lib/gzip';

/** gzip header byte 8 (XFL): 4 = written with the fastest level. */
const XFL = 8;

describe('stored blobs', () => {
  it('are compressed with the fastest gzip level', () => {
    const streams = { t: [...Array(600).keys()], hr: Array.from({ length: 600 }, (_, i) => 120 + (i % 37)) };
    const blob = gzipJson(streams);
    expect(blob[XFL]).toBe(4);
    expect(gunzipJson(blob)).toEqual(streams);
    const hist = gzipFloat32([0, 12.5, 30, 4]);
    expect(hist[XFL]).toBe(4);
    expect([...gunzipFloat32(hist)]).toEqual([0, 12.5, 30, 4]);
  });

  it('written by earlier versions (gzip level 6) still read the same', () => {
    const streams = { t: [0, 1, 2], lat: [47.1, 47.2, 47.3] };
    expect(gunzipJson(zlib.gzipSync(Buffer.from(JSON.stringify(streams)), { level: 6 }))).toEqual(streams);
    const n = 50;
    const track: Track = {
      t: Float64Array.from({ length: n }, (_, i) => 1_750_000_000 + i),
      lat: Float64Array.from({ length: n }, (_, i) => 47.37 + i * 1e-5),
      lon: Float64Array.from({ length: n }, (_, i) => 8.54 + i * 1e-5),
      ele: Float32Array.from({ length: n }, (_, i) => 400 + i),
      speed: null,
      course: null,
      hAcc: null,
      vAcc: null,
    };
    const blob = encodeTrack(track);
    expect(blob[XFL]).toBe(4);
    const old = zlib.gzipSync(gunzip(blob), { level: 6 });
    expect(old[XFL]).toBe(0);
    expect(decodeTrack(old)).toEqual(decodeTrack(blob));
    expect([...decodeTrack(blob).lat].map((v) => v.toFixed(7))).toEqual([...track.lat].map((v) => v.toFixed(7)));
  });
});

describe('stored routes', () => {
  it('keep their longitudes across the antimeridian', () => {
    // Taveuni (Fiji): back and forth over 180°, plus both ends of the range
    const lon = [179.9998, 179.9999, -179.9999, -179.9998, 179.9999, 180, -180, 0.5, -179.5];
    const n = lon.length;
    const track: Track = {
      t: Float64Array.from({ length: n }, (_, i) => 1_750_000_000 + i),
      lat: Float64Array.from({ length: n }, (_, i) => -16.8 - i * 1e-5),
      lon: Float64Array.from(lon),
      ele: null,
      speed: null,
      course: null,
      hAcc: null,
      vAcc: null,
    };
    const back = decodeTrack(encodeTrack(track));
    const wrap = (v: number) => (v === -180 ? 180 : v); // the same meridian
    expect([...back.lon].map((v) => wrap(v).toFixed(7))).toEqual(lon.map((v) => wrap(v).toFixed(7)));
    expect([...back.lat].map((v) => v.toFixed(7))).toEqual([...track.lat].map((v) => v.toFixed(7)));
  });
});
