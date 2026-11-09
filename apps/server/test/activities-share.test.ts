/**
 * Share image of an activity (web: apps/web/src/features/activities/lib/share.ts and the shared tile math in
 * apps/web/src/components/map/tiles.ts — pure functions, tested here because the web workspace has no test runner).
 */
import { describe, expect, it } from 'vitest';
import type { PrivacyZone } from '@cadence/shared';
import { fitTracks, project, thumbnailLayout, unproject, type ThumbnailLayout } from '../../web/src/components/map/tiles';
import {
  SHARE_FORMATS,
  chartSeries,
  hidePrivacyZones,
  shareFileName,
  shareLayout,
  shareSelection,
  slugify,
  type LatLon,
  type Rect,
} from '../../web/src/features/activities/lib/share';
import { decodePolylineParts } from '../../web/src/lib/polyline';
import { encodePolylineParts, haversine } from '../src/lib/geo';

const M_PER_DEG = 111_320;
const LAT = 48.2;
const KX = M_PER_DEG * Math.cos((LAT * Math.PI) / 180);
/** A point `east` / `north` meters from (48.2, 16.37). */
const at = (east: number, north = 0): LatLon => [LAT + north / M_PER_DEG, 16.37 + east / KX];
/** A straight line eastwards from `from` to `to` meters, a point every `step` meters. */
const lineEast = (from: number, to: number, step = 10, north = 0): LatLon[] => {
  const out: LatLon[] = [];
  for (let e = from; e <= to + 1e-9; e += step) out.push(at(e, north));
  return out;
};
const home: PrivacyZone = { lat: LAT, lon: 16.37, radiusM: 200 };
const distTo = (p: LatLon, z: PrivacyZone) => haversine(p[0], p[1], z.lat, z.lon);

describe('share: privacy zones', () => {
  it('leaves the route untouched without zones or outside them', () => {
    const route = [lineEast(0, 1000)];
    expect(hidePrivacyZones(route, []).parts).toBe(route);
    const far = hidePrivacyZones(route, [{ lat: LAT + 0.05, lon: 16.37, radiusM: 300 }]);
    expect(far.changed).toBe(false);
    expect(far.parts).toBe(route);
  });

  it('cuts the start inside a zone exactly at its boundary', () => {
    const r = hidePrivacyZones([lineEast(0, 1000, 25)], [home]);
    expect(r.changed).toBe(true);
    expect(r.startHidden).toBe(true);
    expect(r.endHidden).toBe(false);
    expect(r.parts).toHaveLength(1);
    const first = r.parts[0]![0]!;
    // on the boundary plus the 2 m margin, not at the next point 25 m further
    expect(distTo(first, home)).toBeGreaterThan(200);
    expect(distTo(first, home)).toBeLessThan(203);
    for (const p of r.parts[0]!) expect(distTo(p, home)).toBeGreaterThan(200);
  });

  it('cuts both ends of a loop from home', () => {
    const loop = [...lineEast(0, 1000, 50), ...lineEast(0, 1000, 50, 300).reverse(), at(0, 0)];
    const r = hidePrivacyZones([loop], [home]);
    expect(r.startHidden).toBe(true);
    expect(r.endHidden).toBe(true);
    for (const part of r.parts) for (const p of part) expect(distTo(p, home)).toBeGreaterThan(200);
  });

  it('splits a part where it passes through a zone, also between two far apart points', () => {
    const zone: PrivacyZone = { lat: LAT, lon: 16.37 + 1000 / KX, radiusM: 150 };
    // dense points: the stretch inside is dropped
    const dense = hidePrivacyZones([lineEast(0, 2000, 10)], [zone]);
    expect(dense.parts).toHaveLength(2);
    expect(dense.startHidden).toBe(false);
    expect(dense.endHidden).toBe(false);
    const endOfFirst = dense.parts[0]![dense.parts[0]!.length - 1]!;
    expect(distTo(endOfFirst, zone)).toBeCloseTo(152, 0);
    expect(distTo(dense.parts[1]![0]!, zone)).toBeCloseTo(152, 0);
    // one long segment straight through the zone (no point inside)
    const chord = hidePrivacyZones([[at(0), at(2000)]], [zone]);
    expect(chord.changed).toBe(true);
    expect(chord.parts).toHaveLength(2);
    expect(chord.parts[0]![1]![1]).toBeLessThan(zone.lon);
    expect(chord.parts[1]![0]![1]).toBeGreaterThan(zone.lon);
  });

  it('keeps track parts separate and drops parts entirely inside', () => {
    const parts = [lineEast(0, 150, 10), lineEast(5000, 6000, 10)];
    const r = hidePrivacyZones(parts, [home]);
    expect(r.parts).toHaveLength(1);
    expect(r.parts[0]![0]).toBe(parts[1]![0]);
    expect(r.startHidden).toBe(true);
    expect(r.endHidden).toBe(false);
    const all = hidePrivacyZones([lineEast(0, 150, 10)], [home]);
    expect(all.parts).toEqual([]);
    expect(all.startHidden && all.endHidden).toBe(true);
  });
});

describe('share: layout', () => {
  const inside = (r: Rect, w: number, h: number) =>
    r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= w && r.y + r.h <= h;

  it('places every block inside the canvas, top to bottom without overlaps', () => {
    for (const format of SHARE_FORMATS)
      for (const bg of ['map', 'plain', 'sticker'] as const)
        for (let n = 1; n <= 6; n++) {
          const l = shareLayout(format, bg, n);
          const blocks = [l.header, ...(l.route ? [l.route] : []), l.stats, l.footer];
          for (const b of blocks) expect(inside(b, l.width, l.height), `${format}/${bg}/${n}`).toBe(true);
          for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.y).toBeGreaterThanOrEqual(blocks[i - 1]!.y + blocks[i - 1]!.h);
          expect(l.cols * l.rows).toBeGreaterThanOrEqual(n);
          if (bg === 'sticker') expect(l.route).toBeNull();
          else expect(l.route!.h).toBeGreaterThan(n <= 4 ? 450 : 300);
        }
  });

  it('keeps the story safe zones free and uses 2 × 2 stats there', () => {
    const l = shareLayout('story', 'map', 4);
    expect(l.height).toBe(1920);
    expect(l.header.y).toBeGreaterThanOrEqual(240);
    expect(l.footer.y + l.footer.h).toBeLessThanOrEqual(1920 - 260);
    expect([l.cols, l.rows]).toEqual([2, 2]);
    expect(shareLayout('square', 'plain', 4).cols).toBe(4);
    expect([shareLayout('portrait', 'map', 6).cols, shareLayout('portrait', 'map', 6).rows]).toEqual([3, 2]);
    expect([shareLayout('story', 'map', 6).cols, shareLayout('story', 'map', 6).rows]).toEqual([2, 3]);
    const sticker = shareLayout('square', 'sticker', 3);
    // centered block
    const top = sticker.header.y;
    const bottom = sticker.height - (sticker.footer.y + sticker.footer.h);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
  });
});

describe('share: file name', () => {
  it('builds an ASCII file name from day and title', () => {
    expect(shareFileName('2026-06-20', 'Morning Ride')).toBe('cadence-2026-06-20-morning-ride.png');
    expect(shareFileName('2026-06-20', 'Lauf am Morgen – Prater/Hauptallee')).toBe(
      'cadence-2026-06-20-lauf-am-morgen-prater-hauptallee.png',
    );
    expect(slugify('Größe Über Äcker, Ölsee & Café')).toBe('groesse-ueber-aecker-oelsee-cafe');
    expect(shareFileName('2026-06-20', '🏃‍♀️')).toBe('cadence-2026-06-20.png');
    const long = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith('-')).toBe(false);
  });
});

/** RouteThumbnail's layout before the tile math moved to tiles.ts (reference for the regression test). */
function previousThumbnailLayout(polyline: string, width: number, height: number, pad = 8): ThumbnailLayout | null {
  const parts = decodePolylineParts(polyline)
    .map((p) => p.map(([la, lo]) => project(la, lo)))
    .filter((p) => p.length >= 2);
  if (!parts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of parts)
    for (const [x, y] of p) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  const MAX_Z = 18;
  const fit = Math.min((width - 2 * pad) / (maxX - minX || 1e-12), (height - 2 * pad) / (maxY - minY || 1e-12));
  const scale = Math.min(fit, 256 * 2 ** MAX_Z);
  const ox = (width - (maxX - minX) * scale) / 2;
  const oy = (height - (maxY - minY) * scale) / 2;
  const px = (x: number) => ox + (x - minX) * scale;
  const py = (y: number) => oy + (y - minY) * scale;
  const d = parts
    .map((p) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(y).toFixed(1)}`).join(''))
    .join('');
  const first = parts[0]![0]!;
  const lastPart = parts[parts.length - 1]!;
  const last = lastPart[lastPart.length - 1]!;
  const z = Math.max(0, Math.min(MAX_Z, Math.ceil(Math.log2(scale / 256) - 1e-9)));
  const n = 2 ** z;
  const size = scale / n;
  const ux = (vx: number) => minX + (vx - ox) / scale;
  const uy = (vy: number) => minY + (vy - oy) / scale;
  const tiles: ThumbnailLayout['tiles'] = [];
  const x0 = Math.floor(ux(0) * n);
  const x1 = Math.floor(ux(width) * n);
  const y0 = Math.max(0, Math.floor(uy(0) * n));
  const y1 = Math.min(n - 1, Math.floor(uy(height) * n));
  if (x1 - x0 <= 16 && y1 - y0 <= 16)
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        tiles.push({ z, x: ((tx % n) + n) % n, y: ty, left: px(tx / n), top: py(ty / n), size });
  // new in 0.2.1: the camera of the box, for the rendered (vector) map images
  const view = { cx: ux(width / 2), cy: uy(height / 2), scale };
  return { d, start: [px(first[0]), py(first[1])], end: [px(last[0]), py(last[1])], tiles, view };
}

describe('map tiles (shared by thumbnails and share images)', () => {
  const loop = [...lineEast(0, 3000, 100), ...lineEast(0, 3000, 100, 800).reverse()];
  const twoParts = encodePolylineParts([lineEast(0, 2000, 50), lineEast(30_000, 31_000, 50, 4000)]);
  const tiny = encodePolylineParts([lineEast(0, 40, 5)]);
  const dateline = encodePolylineParts([
    [
      [-16.5, 179.95],
      [-16.6, -179.9],
    ],
  ]);

  it('keeps the route thumbnails exactly as before', () => {
    for (const poly of [encodePolylineParts([loop]), twoParts, tiny, dateline])
      for (const [w, h, pad] of [
        [160, 100, 8],
        [640, 220, 8],
        [784, 300, 8],
        [96, 96, 4],
      ] as const)
        expect(thumbnailLayout(poly, w, h, pad)).toEqual(previousThumbnailLayout(poly, w, h, pad));
    expect(thumbnailLayout('', 160, 100)).toBeNull();
  });

  it('describes the camera of the box for rendered map images', () => {
    const [lat, lon] = [54.17, 12.08];
    const [x, y] = project(lat, lon);
    const [lon2, lat2] = unproject(x, y);
    expect(lat2).toBeCloseTo(lat, 9);
    expect(lon2).toBeCloseTo(lon, 9);
    const l = thumbnailLayout(encodePolylineParts([loop]), 640, 220)!;
    // the box center in view-box units maps back to the view center
    expect(l.view.scale).toBeGreaterThan(0);
    const fit = fitTracks(decodePolylineParts(encodePolylineParts([loop])), 640, 220, 8)!;
    expect(fit.view).toEqual(l.view);
  });

  it('fits into an asymmetric padding box; a zoom bias of −1 draws the tiles twice as large', () => {
    const fit = fitTracks([loop], 1080, 1350, { top: 330, right: 64, bottom: 520, left: 64 })!;
    for (const p of fit.parts[0]!) {
      expect(p[0]).toBeGreaterThanOrEqual(64 - 1e-6);
      expect(p[0]).toBeLessThanOrEqual(1080 - 64 + 1e-6);
      expect(p[1]).toBeGreaterThanOrEqual(330 - 1e-6);
      expect(p[1]).toBeLessThanOrEqual(1350 - 520 + 1e-6);
    }
    // the tiles cover the whole canvas
    const right = Math.max(...fit.tiles.map((t) => t.left + t.size));
    const bottom = Math.max(...fit.tiles.map((t) => t.top + t.size));
    expect(Math.min(...fit.tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.min(...fit.tiles.map((t) => t.top))).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(1080);
    expect(bottom).toBeGreaterThanOrEqual(1350);
    const larger = fitTracks([loop], 1080, 1350, { top: 330, right: 64, bottom: 520, left: 64 }, -1)!;
    expect(larger.tiles[0]!.z).toBe(fit.tiles[0]!.z - 1);
    expect(larger.tiles[0]!.size).toBeCloseTo(2 * fit.tiles[0]!.size, 6);
    expect(larger.tiles.length).toBeLessThan(fit.tiles.length);
    expect(larger.parts).toEqual(fit.parts);
  });
});

describe('share image: values and small charts', () => {
  const ORDER = ['a', 'b', 'c', 'd'] as const;
  it('shows the stored choice in catalog order, limited to what the activity has', () => {
    expect(shareSelection(['c', 'a'], ['a', 'b', 'c'], ['a', 'b'], ORDER, 6)).toEqual(['a', 'c']);
    // nothing chosen yet → defaults (only the available ones)
    expect(shareSelection(null, ['a', 'c'], ['a', 'b'], ORDER, 6)).toEqual(['a']);
    // only unavailable values chosen (e.g. power on an activity without power) → defaults
    expect(shareSelection(['d'], ['a', 'b'], ['b'], ORDER, 6)).toEqual(['b']);
    // an explicit empty choice stays empty
    expect(shareSelection([], ['a', 'b'], ['a'], ORDER, 6)).toEqual([]);
    expect(shareSelection(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'], [], ORDER, 2)).toEqual(['a', 'b']);
  });

  it('downsamples a stream into a normalized line, split at gaps and track breaks', () => {
    const x = Array.from({ length: 1000 }, (_, i) => i);
    const y = x.map((i) => (i >= 400 && i < 450 ? null : 100 + Math.sin(i / 100) * 10));
    const s = chartSeries(x, y, { buckets: 100 })!;
    expect(s.parts.length).toBe(2);
    for (const p of s.parts)
      for (const [vx, vy] of p) {
        expect(vx).toBeGreaterThanOrEqual(0);
        expect(vx).toBeLessThanOrEqual(1);
        expect(vy).toBeGreaterThanOrEqual(0);
        expect(vy).toBeLessThanOrEqual(1);
      }
    const withBreak = chartSeries(x, x.map(() => 5), { buckets: 50, breaks: [600], minRange: 10 })!;
    expect(withBreak.parts.length).toBe(2);
    // a flat line stays in the middle instead of being stretched over the height
    expect(withBreak.parts[0]![0]![1]).toBeCloseTo(0.5, 5);
    expect(chartSeries([0, 1], [null, null])).toBeNull();
    expect(chartSeries([5, 5, 5], [1, 2, 3])).toBeNull();
  });

  it('makes room for the charts between the route and the stats', () => {
    for (const format of ['square', 'portrait', 'story'] as const) {
      const l = shareLayout(format, 'map', 4, 2);
      expect(l.charts).not.toBeNull();
      expect(l.route!.y + l.route!.h).toBeLessThanOrEqual(l.charts!.y);
      expect(l.charts!.y + l.charts!.h).toBeLessThanOrEqual(l.stats.y);
      expect(l.stats.y + l.stats.h).toBeLessThanOrEqual(l.footer.y);
      expect(shareLayout(format, 'map', 4).charts).toBeNull();
    }
    // no values at all: the charts sit right above the footer
    const bare = shareLayout('square', 'plain', 0, 1);
    expect(bare.stats.h).toBe(0);
    expect(bare.charts!.y + bare.charts!.h).toBeLessThanOrEqual(bare.footer.y);
    const sticker = shareLayout('story', 'sticker', 3, 3);
    expect(sticker.header.y + sticker.header.h).toBeLessThan(sticker.charts!.y);
    expect(sticker.charts!.y + sticker.charts!.h).toBeLessThan(sticker.stats.y);
  });
});
