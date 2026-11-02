import { parseIsoTime } from './dates';
import type { Track } from './track';

/**
 * Fast regex based GPX parser for Apple's workout-routes/*.gpx:
 *
 *   <trkpt lon="16.393958" lat="48.212512"><ele>162.51</ele><time>2024-05-01T05:30:12Z</time>
 *     <extensions><speed>2.97</speed><course>123.4</course><hAcc>4.3</hAcc><vAcc>3.1</vAcc></extensions></trkpt>
 *
 * Also accepts self-closing trkpts, namespaced extension tags and other GPX producers. Points without a
 * valid time or position are skipped; the result is sorted by time.
 */
const TRKPT_RE = /<(?:\w+:)?trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?trkpt>)/g;
const LAT_RE = /\blat\s*=\s*["']\s*([-+0-9.eE]+)/;
const LON_RE = /\blon\s*=\s*["']\s*([-+0-9.eE]+)/;

function tagValue(s: string, tag: string): string | null {
  let i = s.indexOf(`<${tag}>`);
  let start: number;
  if (i >= 0) start = i + tag.length + 2;
  else {
    const j = s.indexOf(`:${tag}>`);
    if (j < 0) return null;
    i = s.lastIndexOf('<', j);
    if (i < 0 || s.charCodeAt(i + 1) === 47) return null;
    start = j + tag.length + 2;
  }
  const end = s.indexOf('<', start);
  if (end < 0) return null;
  return s.slice(start, end).trim();
}

function numOrNaN(v: string | null): number {
  if (v === null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function parseGpx(xml: string): Track {
  const t: number[] = [];
  const lat: number[] = [];
  const lon: number[] = [];
  const ele: number[] = [];
  const speed: number[] = [];
  const course: number[] = [];
  const hAcc: number[] = [];
  const vAcc: number[] = [];
  let hasEle = false;
  let hasSpeed = false;
  let hasCourse = false;
  let hasHAcc = false;
  let hasVAcc = false;
  TRKPT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TRKPT_RE.exec(xml))) {
    const attrs = m[1]!;
    const la = Number(LAT_RE.exec(attrs)?.[1]);
    const lo = Number(LON_RE.exec(attrs)?.[1]);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) continue;
    if (la === 0 && lo === 0) continue;
    const inner = m[2] ?? '';
    const time = tagValue(inner, 'time');
    const ts = time ? parseIsoTime(time) : NaN;
    if (!Number.isFinite(ts)) continue;
    t.push(ts);
    lat.push(la);
    lon.push(lo);
    const e = numOrNaN(tagValue(inner, 'ele'));
    ele.push(e);
    if (!Number.isNaN(e)) hasEle = true;
    if (inner.length > 60) {
      // Apple writes -1 for "invalid" speed/course
      const sp = numOrNaN(tagValue(inner, 'speed'));
      const co = numOrNaN(tagValue(inner, 'course'));
      const ha = numOrNaN(tagValue(inner, 'hAcc'));
      const va = numOrNaN(tagValue(inner, 'vAcc'));
      speed.push(sp >= 0 ? sp : NaN);
      course.push(co >= 0 ? co : NaN);
      hAcc.push(ha >= 0 ? ha : NaN);
      vAcc.push(va >= 0 ? va : NaN);
      if (sp >= 0) hasSpeed = true;
      if (co >= 0) hasCourse = true;
      if (ha >= 0) hasHAcc = true;
      if (va >= 0) hasVAcc = true;
    } else {
      speed.push(NaN);
      course.push(NaN);
      hAcc.push(NaN);
      vAcc.push(NaN);
    }
  }
  // sort by time if needed
  let sorted = true;
  for (let i = 1; i < t.length; i++)
    if (t[i]! < t[i - 1]!) {
      sorted = false;
      break;
    }
  let order: number[] | null = null;
  if (!sorted) order = t.map((_, i) => i).sort((a, b) => t[a]! - t[b]!);
  const col64 = (a: number[]) => Float64Array.from(order ? order.map((i) => a[i]!) : a);
  const col32 = (a: number[], has: boolean) =>
    has ? Float32Array.from(order ? order.map((i) => a[i]!) : a) : null;
  return {
    t: col64(t),
    lat: col64(lat),
    lon: col64(lon),
    ele: col32(ele, hasEle),
    speed: col32(speed, hasSpeed),
    course: col32(course, hasCourse),
    hAcc: col32(hAcc, hasHAcc),
    vAcc: col32(vAcc, hasVAcc),
  };
}
