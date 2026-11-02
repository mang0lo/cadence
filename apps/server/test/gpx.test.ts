import { describe, expect, it } from 'vitest';
import { parseGpx } from '../src/import/gpx';
import { decodeTrack, encodeTrack, mergeTracks } from '../src/import/track';

const APPLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1">
 <metadata><time>2024-05-01T05:30:00Z</time></metadata>
 <trk>
  <name>Route 2024-05-01 7:30am</name>
  <trkseg>
   <trkpt lon="16.396710" lat="48.216600"><ele>162.513626</ele><time>2024-05-01T05:30:01Z</time><extensions><speed>2.854012</speed><course>124.453125</course><hAcc>3.215643</hAcc><vAcc>1.912345</vAcc></extensions></trkpt>
   <trkpt lon="16.396750" lat="48.216580"><ele>162.6</ele><time>2024-05-01T05:30:02Z</time><extensions><speed>-1.000000</speed><course>-1.000000</course><hAcc>3.1</hAcc><vAcc>1.9</vAcc></extensions></trkpt>
   <trkpt lat='48.216560' lon='16.396790'><time>2024-05-01T05:30:03Z</time></trkpt>
   <trkpt lat="48.2" lon="16.3"/>
   <trkpt lat="0" lon="0"><time>2024-05-01T05:30:04Z</time></trkpt>
  </trkseg>
 </trk>
</gpx>`;

describe('GPX parser', () => {
  it('reads Apple route files', () => {
    const t = parseGpx(APPLE);
    expect(t.t.length).toBe(3); // no time / null island dropped
    expect(t.lat[0]).toBeCloseTo(48.2166, 6);
    expect(t.lon[0]).toBeCloseTo(16.39671, 6);
    expect(t.t[0]).toBe(Date.UTC(2024, 4, 1, 5, 30, 1) / 1000);
    expect(t.ele![0]).toBeCloseTo(162.5136, 3);
    expect(Number.isNaN(t.ele![2])).toBe(true);
    expect(t.speed![0]).toBeCloseTo(2.854, 3);
    expect(Number.isNaN(t.speed![1])).toBe(true); // -1 = invalid
    expect(t.hAcc![1]).toBeCloseTo(3.1, 5);
    expect(t.course![0]).toBeCloseTo(124.45, 2);
  });

  it('accepts namespaced tags and sorts by time', () => {
    const t = parseGpx(`<gpx><trk><trkseg>
      <trkpt lat="1" lon="2"><time>2024-01-01T00:00:10Z</time><extensions><ns3:TrackPointExtension><ns3:speed>3.5</ns3:speed></ns3:TrackPointExtension></extensions></trkpt>
      <trkpt lat="1.1" lon="2.1"><time>2024-01-01T00:00:05Z</time></trkpt>
    </trkseg></trk></gpx>`);
    expect(Array.from(t.lat)).toEqual([1.1, 1]);
    expect(t.speed![1]).toBe(3.5);
    expect(t.ele).toBeNull();
  });

  it('round-trips the compact track encoding', () => {
    const t = parseGpx(APPLE);
    const back = decodeTrack(encodeTrack(t));
    expect(back.t.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(back.t[i]).toBeCloseTo(t.t[i]!, 3);
      expect(back.lat[i]).toBeCloseTo(t.lat[i]!, 7);
      expect(back.lon[i]).toBeCloseTo(t.lon[i]!, 7);
    }
    expect(back.speed![0]).toBeCloseTo(2.854012, 5);
    expect(Number.isNaN(back.ele![2])).toBe(true);
    const merged = mergeTracks([back, { ...back, t: back.t.map((x) => x - 100) }]);
    expect(merged.t.length).toBe(6);
    expect(merged.t[0]).toBeLessThan(merged.t[5]!);
  });
});
