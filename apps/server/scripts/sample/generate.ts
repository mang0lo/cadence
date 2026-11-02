/**
 * Deterministic synthetic Apple Health export (export.zip) for development and tests.
 *
 * Simulates one athlete (Vienna, locale de_AT) over N days ending at `endDate`: an Apple Watch and an iPhone
 * writing the usual record types (overlapping step counts!), sleep stages, body measurements, blood pressure,
 * an audiogram, ECGs, activity rings, and workouts with 1 Hz GPS routes along real Vienna streets – improving
 * fitness over time, a training break, races, intervals, rides, hikes, pool swims, strength/yoga/HIIT, plus edge
 * cases: a run abroad (HKTimeZone), a legacy-format workout, an iOS 16 multisport workout with WorkoutActivity
 * children, a treadmill run (no GPS, distance records) and a duplicate copy of a run written by "Strava".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yazl from 'yazl';
import { formatIsoUtc } from '../../src/import/dates';
import { civilFromDays, dayString, daysFromCivil } from '../../src/lib/time';
import { Course } from './course';
import { Rng } from './rng';
import { ROUTES, type Waypoint } from './routes-data';

export type SampleSize = 'small' | 'medium' | 'large';

export interface SampleOptions {
  /** Output .zip path. */
  out: string;
  size?: SampleSize;
  seed?: number;
  /** Last day of data, 'YYYY-MM-DD' (default: today). Fix it for reproducible output. */
  endDate?: string;
  log?: (message: string) => void;
}

export interface SampleResult {
  file: string;
  size: SampleSize;
  days: number;
  firstDay: string;
  lastDay: string;
  records: number;
  workouts: number;
  routes: number;
  ecgs: number;
  xmlBytes: number;
  zipBytes: number;
  ms: number;
}

const SIZES: Record<SampleSize, { days: number; bgHrMin: number; breakDays: number }> = {
  small: { days: 70, bgHrMin: 8, breakDays: 10 },
  medium: { days: 730, bgHrMin: 6, breakDays: 18 },
  large: { days: 1826, bgHrMin: 1.25, breakDays: 18 },
};

const Q = 'HKQuantityTypeIdentifier';
const C = 'HKCategoryTypeIdentifier';
const W = 'HKWorkoutActivityType';
const OWNER = 'Hannes';
const MASS0 = 79.5;
const HEIGHT_CM = 182;
const MAX_HR = 189;

// ---------------------------------------------------------------------------
// time: Europe/Vienna (EU DST rule) and Apple's date format
// ---------------------------------------------------------------------------

const P2 = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const dstCache = new Map<number, [number, number]>();

function lastSundayUtc(y: number, m: number): number {
  const lastDay = (m === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, m + 1, 1)) - 1;
  const dow = (((lastDay + 4) % 7) + 7) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
  return (lastDay - dow) * 86400;
}

function viennaTz(ts: number): number {
  const y = civilFromDays(Math.floor(ts / 86400))[0];
  let r = dstCache.get(y);
  if (!r) {
    r = [lastSundayUtc(y, 3) + 3600, lastSundayUtc(y, 10) + 3600];
    dstCache.set(y, r);
  }
  return ts >= r[0] && ts < r[1] ? 120 : 60;
}

const dayStrCache = new Map<number, string>();
/** Apple's export format in the exporting phone's zone (Vienna): `2024-05-01 07:30:12 +0200`. */
function fmt(ts: number): string {
  ts = Math.floor(ts);
  const tz = viennaTz(ts);
  const local = ts + tz * 60;
  const d = Math.floor(local / 86400);
  let ds = dayStrCache.get(d);
  if (!ds) {
    ds = dayString(d);
    dayStrCache.set(d, ds);
  }
  const sod = local - d * 86400;
  return `${ds} ${P2[(sod / 3600) | 0]}:${P2[((sod % 3600) / 60) | 0]}:${P2[sod % 60]} ${tz === 120 ? '+0200' : '+0100'}`;
}

/** Unix time of a local Vienna wall-clock time on epoch day `d`. */
function viennaTs(d: number, hours: number): number {
  const guess = d * 86400 + Math.round(hours * 3600) - 3600;
  return d * 86400 + Math.round(hours * 3600) - viennaTz(guess) * 60;
}

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// ---------------------------------------------------------------------------
// sources & devices
// ---------------------------------------------------------------------------

interface Source {
  name: string;
  version: string;
  device: string | null;
}

function osVersion(day: number, kind: 'watch' | 'phone'): string {
  const rel = [
    [daysFromCivil(2022, 9, 12), '9', '16'],
    [daysFromCivil(2023, 9, 18), '10', '17'],
    [daysFromCivil(2024, 9, 16), '11', '18'],
    [daysFromCivil(2025, 9, 15), '26', '26'],
  ] as const;
  let cur: (typeof rel)[number] = rel[0];
  for (const r of rel) if (day >= r[0]) cur = r;
  const minor = Math.min(6, Math.floor((day - cur[0]) / 50));
  return `${kind === 'watch' ? cur[1] : cur[2]}.${minor}`;
}

const xmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------
// output: records grouped by type (temp file per type), like Apple's export
// ---------------------------------------------------------------------------

class RecordSink {
  private day = new Map<string, [number, string][]>();
  private files = new Map<string, { fd: number; parts: string[]; len: number; file: string }>();
  readonly order: string[] = [];
  count = 0;

  constructor(private readonly dir: string) {}

  add(type: string, start: number, xml: string): void {
    let list = this.day.get(type);
    if (!list) this.day.set(type, (list = []));
    list.push([start, xml]);
    this.count++;
  }

  flushDay(): void {
    for (const [type, list] of this.day) {
      list.sort((a, b) => a[0] - b[0]);
      let f = this.files.get(type);
      if (!f) {
        const file = path.join(this.dir, `${this.files.size}.xml`);
        f = { fd: fs.openSync(file, 'w'), parts: [], len: 0, file };
        this.files.set(type, f);
        this.order.push(type);
      }
      for (const [, x] of list) {
        f.parts.push(x);
        f.len += x.length;
      }
      if (f.len > 1 << 20) this.write(f);
    }
    this.day.clear();
  }

  private write(f: { fd: number; parts: string[]; len: number }): void {
    fs.writeSync(f.fd, f.parts.join(''));
    f.parts = [];
    f.len = 0;
  }

  /** Close all type files; returns them in first-seen order. */
  finish(): string[] {
    this.flushDay();
    for (const f of this.files.values()) {
      this.write(f);
      fs.closeSync(f.fd);
    }
    return this.order.map((t) => this.files.get(t)!.file);
  }
}

// ---------------------------------------------------------------------------
// workout description → Apple XML
// ---------------------------------------------------------------------------

interface Stat {
  type: string;
  start: number;
  end: number;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
  unit: string;
  digits?: number;
}

interface WorkoutEventOut {
  type: string;
  ts: number;
  durMin?: number;
  meta?: [string, string][];
}

interface ActivityOut {
  type: string;
  start: number;
  end: number;
  activeS: number;
  stats: Stat[];
  meta: [string, string][];
  events: WorkoutEventOut[];
}

interface WorkoutOut {
  type: string;
  start: number;
  end: number;
  activeS: number;
  src: Source;
  meta: [string, string][];
  events: WorkoutEventOut[];
  stats: Stat[];
  activities: ActivityOut[];
  route: { file: string; start: number; end: number } | null;
  legacy?: { distKm: number; kcal: number; strokes?: number };
}

function statXml(s: Stat, indent: string): string {
  const d = s.digits ?? 3;
  let x = `${indent}<WorkoutStatistics type="${s.type}" startDate="${fmt(s.start)}" endDate="${fmt(s.end)}"`;
  if (s.avg !== undefined) x += ` average="${s.avg.toFixed(d)}"`;
  if (s.min !== undefined) x += ` minimum="${s.min.toFixed(d)}"`;
  if (s.max !== undefined) x += ` maximum="${s.max.toFixed(d)}"`;
  if (s.sum !== undefined) x += ` sum="${s.sum.toFixed(d)}"`;
  return `${x} unit="${s.unit}"/>\n`;
}

function eventXml(e: WorkoutEventOut, indent: string): string {
  const head = `${indent}<WorkoutEvent type="HKWorkoutEventType${e.type}" date="${fmt(e.ts)}"${
    e.durMin !== undefined ? ` duration="${e.durMin.toFixed(4)}" durationUnit="min"` : ''
  }`;
  if (!e.meta?.length) return `${head}/>\n`;
  return `${head}>\n${e.meta.map(([k, v]) => `${indent} <MetadataEntry key="${k}" value="${xmlAttr(v)}"/>\n`).join('')}${indent}</WorkoutEvent>\n`;
}

function workoutXml(w: WorkoutOut, rng: Rng): string {
  const src = w.src;
  let x = ` <Workout workoutActivityType="${w.type}" duration="${(w.activeS / 60).toFixed(4)}" durationUnit="min"`;
  if (w.legacy) {
    x += ` totalDistance="${w.legacy.distKm.toFixed(5)}" totalDistanceUnit="km" totalEnergyBurned="${w.legacy.kcal.toFixed(3)}" totalEnergyBurnedUnit="kcal"`;
    if (w.legacy.strokes)
      x += ` totalSwimmingStrokeCount="${w.legacy.strokes}" totalSwimmingStrokeCountUnit="count"`;
  }
  x += ` sourceName="${xmlAttr(src.name)}" sourceVersion="${src.version}"`;
  if (src.device) x += ` device="${src.device}"`;
  x += ` creationDate="${fmt(w.end + 9)}" startDate="${fmt(w.start)}" endDate="${fmt(w.end)}">\n`;
  for (const [k, v] of w.meta) x += `  <MetadataEntry key="${k}" value="${xmlAttr(v)}"/>\n`;
  for (const e of w.events) x += eventXml(e, '  ');
  for (const a of w.activities) {
    x += `  <WorkoutActivity uuid="${rng.uuid()}" startDate="${fmt(a.start)}" endDate="${fmt(a.end)}" duration="${(a.activeS / 60).toFixed(4)}" durationUnit="min"`;
    if (w.activities.length > 1) x += ` workoutActivityType="${a.type}"`;
    x += '>\n';
    for (const e of a.events) x += eventXml(e, '   ');
    for (const s of a.stats) x += statXml(s, '   ');
    for (const [k, v] of a.meta) x += `   <MetadataEntry key="${k}" value="${xmlAttr(v)}"/>\n`;
    x += '  </WorkoutActivity>\n';
  }
  for (const s of w.stats) x += statXml(s, '  ');
  if (w.route) {
    x += `  <WorkoutRoute sourceName="${xmlAttr(src.name)}" sourceVersion="${src.version}"${src.device ? ` device="${src.device}"` : ''} creationDate="${fmt(
      w.end + 12,
    )}" startDate="${fmt(w.route.start)}" endDate="${fmt(w.route.end)}">\n`;
    x += `   <MetadataEntry key="HKMetadataKeySyncVersion" value="2"/>\n`;
    x += `   <MetadataEntry key="HKMetadataKeySyncIdentifier" value="${rng.uuid()}"/>\n`;
    x += `   <FileReference path="/workout-routes/${w.route.file}"/>\n`;
    x += '  </WorkoutRoute>\n';
  }
  return `${x} </Workout>\n`;
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

type MoveSport = 'run' | 'ride' | 'walk' | 'hike' | 'swim';

interface MoveOpts {
  sport: MoveSport;
  course: Course | null;
  /** Distance for course-less (treadmill) movement. */
  length: number;
  start: number;
  speed: (s: number, t: number, grade: number) => number;
  stops?: number[];
  pause?: { atS: number; dur: number } | null;
  autoPause?: boolean;
  glitch?: boolean;
  urban?: boolean;
  power?: boolean;
  cadenceSensor?: boolean;
  hrStart?: number;
  /** Seconds offset of the first GPS fix (multisport legs share one clock). */
  t0?: number;
  /** Extra effort (fraction of HR reserve) – races hurt more than training at the same pace. */
  boost?: number;
}

interface GpsPoint {
  t: number;
  lat: number;
  lon: number;
  ele: number;
  speed: number;
  course: number;
  hAcc: number;
  vAcc: number;
}

interface MoveResult {
  start: number;
  end: number;
  activeS: number;
  pts: GpsPoint[];
  hr: [number, number][];
  kcal: [number, number, number][];
  steps: [number, number, number][];
  dist: [number, number, number][];
  power: [number, number][];
  cadence: [number, number][];
  events: WorkoutEventOut[];
  distance: number;
  ascent: number;
  hrLast: number;
  speeds: number[];
}

class Athlete {
  constructor(
    private readonly rng: Rng,
    private readonly fitness: (day: number) => number,
    private readonly firstDay: number,
    private readonly days: number,
  ) {}
  rest(day: number): number {
    return 61 - 9 * this.fitness(day);
  }
  vEasy(day: number): number {
    return 2.62 + 0.55 * this.fitness(day);
  }
  vRef(day: number): number {
    return 4.3 + 0.6 * this.fitness(day);
  }
  ftp(day: number): number {
    return 195 + 55 * this.fitness(day);
  }
  vo2(day: number): number {
    return 43.5 + 7 * this.fitness(day);
  }
  /** Body mass on epoch day `day`: slowly decreasing, seasonal swing, day-to-day noise. */
  mass(day: number): number {
    const p = (day - this.firstDay) / Math.max(1, this.days);
    return MASS0 - 4 * p + 0.6 * Math.sin((2 * Math.PI * day) / 365) + this.rng.normal(0, 0.25);
  }
}

function simulateMove(rng: Rng, ath: Athlete, day: number, mass: number, o: MoveOpts): MoveResult {
  const rest = ath.rest(day);
  const vRef = ath.vRef(day);
  const ftp = ath.ftp(day);
  const res: MoveResult = {
    start: o.start,
    end: o.start,
    activeS: 0,
    pts: [],
    hr: [],
    kcal: [],
    steps: [],
    dist: [],
    power: [],
    cadence: [],
    events: [],
    distance: 0,
    ascent: 0,
    hrLast: 0,
    speeds: [],
  };
  const target = o.course ? o.course.length : o.length;
  const stops = [...(o.stops ?? [])].sort((a, b) => a - b);
  let t = o.t0 ?? 0;
  let s = 0;
  let v = 0;
  let hr = o.hrStart ?? rest + 25;
  let hrNoise = 0;
  let nx = 0;
  let ny = 0;
  let baro = 0;
  let stopLeft = 0;
  let paused = false;
  let movingAuto = true;
  let lastCourseEle: number | null = null;
  let minuteKcal = 0;
  let minuteSteps = 0;
  let minuteDist = 0;
  let minuteStart = o.start + t;
  const glitchAt = o.glitch ? rng.range(0.2, 0.8) * target : -1;
  let glitchLeft = 0;
  let glitchDx = 0;
  let glitchDy = 0;
  const intensity = (vv: number, grade: number, minutes: number): number => {
    const drift = 0.0007 * Math.max(0, minutes - 20);
    switch (o.sport) {
      case 'run': {
        const eff = vv * (1 + 6 * clamp(grade, -0.05, 0.15));
        return clamp(
          0.36 + 0.6 * Math.pow(clamp(eff / vRef, 0, 1.3), 1.5) + drift + (o.boost ?? 0),
          0.2,
          1.02,
        );
      }
      case 'ride': {
        const p = cyclingPower(vv, grade);
        return clamp(0.25 + 0.55 * (p / ftp) + drift, 0.15, 1);
      }
      case 'walk':
        return clamp(0.2 + 0.22 * (vv / 1.4) + 2.5 * Math.max(0, grade) + drift, 0.1, 0.8);
      case 'hike':
        return clamp(0.27 + 3.2 * Math.max(0, grade) + 0.08 * vv + drift, 0.15, 0.9);
      case 'swim':
        return vv > 0.2 ? 0.66 + drift : 0.45;
    }
  };
  const cyclingPower = (vv: number, grade: number) =>
    Math.max(0, (0.5 * 1.2 * 0.36 * vv * vv * vv + (mass + 10) * 9.81 * vv * (0.005 + grade)) * 1.05);
  const stepRate = (vv: number) =>
    o.sport === 'run'
      ? clamp(150 + 8 * vv, 150, 196)
      : o.sport === 'walk'
        ? 98 + 13 * vv
        : o.sport === 'hike'
          ? 92 + 10 * vv
          : 0;

  const tick = (moving: boolean, grade: number) => {
    // heart rate: first-order response with noise
    const minutes = t / 60;
    const tgt = rest + intensity(moving ? v : 0, grade, minutes) * (MAX_HR - rest);
    hr += (tgt - hr) / (tgt > hr ? 18 : 35);
    hrNoise = 0.9 * hrNoise + rng.normal(0, 0.45);
    if (t % 5 === 0) res.hr.push([o.start + t, Math.round(clamp(hr + hrNoise, 45, MAX_HR + 2))]);
    // energy
    let kcal = 0;
    if (o.sport === 'run') kcal = (mass * (moving ? v : 0) * 1.0) / 1000 + 0.015;
    else if (o.sport === 'walk' || o.sport === 'hike')
      kcal =
        (mass * (moving ? v : 0) * 0.55) / 1000 +
        (mass * 9.81 * Math.max(0, grade) * (moving ? v : 0)) / 1046 +
        0.01;
    else if (o.sport === 'ride') kcal = cyclingPower(moving ? v : 0, grade) / (0.24 * 4184) + 0.01;
    else kcal = moving ? 0.15 : 0.04;
    minuteKcal += kcal;
    if (moving) {
      minuteSteps += stepRate(v) / 60;
      minuteDist += v;
    }
    if (o.power && o.sport === 'run' && t % 10 === 0 && moving)
      res.power.push([
        o.start + t,
        Math.round(mass * v * 1.04 + mass * 9.81 * v * clamp(grade, -0.04, 0.2) * 0.9 + rng.normal(0, 6)),
      ]);
    if (o.sport === 'ride' && t % 10 === 0 && moving) {
      if (o.power) res.power.push([o.start + t, Math.round(cyclingPower(v, grade) * rng.range(0.9, 1.1))]);
      if (o.cadenceSensor)
        res.cadence.push([
          o.start + t,
          Math.round(grade < -0.03 && rng.chance(0.4) ? 0 : 82 + rng.normal(0, 5)),
        ]);
    }
    if (t - (minuteStart - o.start) >= 60) {
      const ts = o.start + t;
      res.kcal.push([minuteStart, ts, minuteKcal]);
      if (minuteSteps > 0.5) res.steps.push([minuteStart, ts, Math.round(minuteSteps)]);
      if (minuteDist > 0.5) res.dist.push([minuteStart, ts, minuteDist]);
      minuteKcal = 0;
      minuteSteps = 0;
      minuteDist = 0;
      minuteStart = ts;
    }
  };

  let guard = 0;
  while (s < target && guard++ < 6 * 3600 * 2) {
    const pos = o.course?.at(s);
    const grade = pos?.grade ?? 0;
    if (stopLeft <= 0 && stops.length && s >= stops[0]!) {
      stops.shift();
      if (rng.chance(0.55)) stopLeft = rng.int(8, 42);
    }
    const tv = stopLeft > 0 ? 0 : Math.max(0.3, o.speed(s, t, grade));
    v += (tv - v) * (tv < v ? 0.45 : 0.22);
    if (tv === 0 && v < 0.08) v = 0;
    if (stopLeft > 0) stopLeft--;
    s += v;
    t += 1;
    // manual pause: no GPS while paused, the clock (and HR) keeps running
    if (o.pause && !paused && s >= o.pause.atS) {
      paused = true;
      res.events.push({ type: 'Pause', ts: o.start + t });
      v = 0;
      for (let k = 0; k < o.pause.dur; k++) {
        t++;
        tick(false, 0);
      }
      res.events.push({ type: 'Resume', ts: o.start + t });
      res.activeS -= o.pause.dur;
    }
    // auto pause (rides): motion paused/resumed around stops
    if (o.autoPause) {
      if (movingAuto && v < 0.3) {
        movingAuto = false;
        res.events.push({ type: 'MotionPaused', ts: o.start + t });
      } else if (!movingAuto && v > 1) {
        movingAuto = true;
        res.events.push({ type: 'MotionResumed', ts: o.start + t });
      }
    }
    tick(v > 0.2, grade);
    res.speeds.push(v);
    if (pos) {
      const p2 = o.course!.at(Math.min(s, target));
      nx = 0.95 * nx + rng.normal(0, o.urban ? 0.55 : 0.35);
      ny = 0.95 * ny + rng.normal(0, o.urban ? 0.55 : 0.35);
      baro = 0.985 * baro + rng.normal(0, 0.08);
      let dx = nx;
      let dy = ny;
      if (glitchAt > 0 && glitchLeft === 0 && s >= glitchAt && s - v < glitchAt) {
        glitchLeft = 2;
        const ang = rng.range(0, 2 * Math.PI);
        const r = rng.range(60, 140);
        glitchDx = Math.cos(ang) * r;
        glitchDy = Math.sin(ang) * r;
      }
      if (glitchLeft > 0) {
        dx += glitchDx;
        dy += glitchDy;
        glitchLeft--;
      }
      const lat = p2.lat + dy / 111320;
      const lon = p2.lon + dx / (111320 * Math.cos((p2.lat * Math.PI) / 180));
      const ele = p2.ele + baro;
      if (lastCourseEle !== null) res.ascent += Math.max(0, p2.ele - lastCourseEle);
      lastCourseEle = p2.ele;
      res.pts.push({
        t: o.start + t,
        lat,
        lon,
        ele,
        speed: Math.max(0, v + rng.normal(0, 0.07)),
        course: v > 0.3 ? (p2.bearing + rng.normal(0, 3) + 360) % 360 : -1,
        hAcc: (o.urban ? 4.5 : 2.6) + Math.abs(rng.normal(0, 1.2)) + (glitchLeft > 0 ? 9 : 0),
        vAcc: 1.4 + Math.abs(rng.normal(0, 0.8)),
      });
    }
  }
  const ts = o.start + t;
  if (minuteKcal > 0) res.kcal.push([minuteStart, ts, minuteKcal]);
  if (minuteSteps > 0.5) res.steps.push([minuteStart, ts, Math.round(minuteSteps)]);
  if (minuteDist > 0.5) res.dist.push([minuteStart, ts, minuteDist]);
  res.end = ts;
  res.activeS += ts - o.start - (o.t0 ?? 0);
  res.distance = s;
  res.hrLast = hr;
  return res;
}

/** HR-only workouts (strength, HIIT, yoga): intensity as a function of elapsed seconds. */
function simulateStatic(
  rng: Rng,
  rest: number,
  start: number,
  durS: number,
  intensity: (t: number) => number,
  kcalPerMin: (i: number) => number,
): MoveResult {
  const res: MoveResult = {
    start,
    end: start + durS,
    activeS: durS,
    pts: [],
    hr: [],
    kcal: [],
    steps: [],
    dist: [],
    power: [],
    cadence: [],
    events: [],
    distance: 0,
    ascent: 0,
    hrLast: 0,
    speeds: [],
  };
  let hr = rest + 15;
  let noise = 0;
  let kcal = 0;
  let mStart = start;
  for (let t = 1; t <= durS; t++) {
    const i = intensity(t);
    const tgt = rest + i * (MAX_HR - rest);
    hr += (tgt - hr) / (tgt > hr ? 15 : 30);
    noise = 0.9 * noise + rng.normal(0, 0.5);
    if (t % 5 === 0) res.hr.push([start + t, Math.round(clamp(hr + noise, 45, MAX_HR))]);
    kcal += kcalPerMin(i) / 60;
    if (t % 60 === 0 || t === durS) {
      res.kcal.push([mStart, start + t, kcal]);
      kcal = 0;
      mStart = start + t;
    }
  }
  res.hrLast = hr;
  return res;
}

function hrStats(r: MoveResult): { avg: number; min: number; max: number } {
  const v = r.hr.map((x) => x[1]);
  return {
    avg: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length),
    min: Math.min(...v),
    max: Math.max(...v),
  };
}

// ---------------------------------------------------------------------------
// the generator
// ---------------------------------------------------------------------------

type Kind =
  | 'easy'
  | 'intervals'
  | 'tempo'
  | 'long'
  | 'race5k'
  | 'race10k'
  | 'half'
  | 'treadmill'
  | 'ride'
  | 'longride'
  | 'walk'
  | 'hike'
  | 'swim'
  | 'strength'
  | 'yoga'
  | 'hiit'
  | 'abroad'
  | 'legacy'
  | 'multisport';

interface Plan {
  kind: Kind;
  hour: number;
  strava?: boolean;
}

class Generator {
  private readonly rng: Rng;
  private readonly cfg: (typeof SIZES)[SampleSize];
  private readonly sink: RecordSink;
  private readonly ath: Athlete;
  private readonly workoutsFd: number;
  private summaries: string[] = [];
  private correlations: string[] = [];
  private extra: string[] = [];
  private routeFiles: string[] = [];
  private ecgFiles: string[] = [];
  private workouts = 0;
  private readonly firstDay: number;
  private readonly days: number;
  private readonly bedTs: number[] = [];
  private readonly wakeTs: number[] = [];
  private readonly special = new Map<number, Plan[]>();
  private breakStart = 0;
  private breakEnd = 0;
  private tripStart = 0;
  private tripEnd = 0;
  private devicePtr = new Map<string, string>();
  // per-day totals for ActivitySummary
  private dayKcal = 0;
  private dayExercise = 0;
  private windows: [number, number, number][] = [];

  constructor(
    private readonly tmp: string,
    size: SampleSize,
    seed: number,
    endDay: number,
  ) {
    this.rng = new Rng(seed);
    this.cfg = SIZES[size];
    this.days = this.cfg.days;
    this.firstDay = endDay - this.days + 1;
    fs.mkdirSync(path.join(tmp, 'types'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'apple_health_export', 'workout-routes'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'apple_health_export', 'electrocardiograms'), { recursive: true });
    this.sink = new RecordSink(path.join(tmp, 'types'));
    this.workoutsFd = fs.openSync(path.join(tmp, 'workouts.xml'), 'w');
    const breakAt = Math.floor(this.days * 0.64);
    this.breakStart = breakAt;
    this.breakEnd = breakAt + this.cfg.breakDays;
    this.ath = new Athlete(this.rng.fork(1), (d) => this.fitness(d), this.firstDay, this.days);
    this.planSpecials();
    const sleepRng = this.rng.fork(2);
    for (let i = 0; i <= this.days; i++) {
      const d = this.firstDay + i;
      const dow = this.dow(d);
      const weekend = dow >= 5;
      this.wakeTs.push(viennaTs(d, (weekend ? 7.9 : 6.65) + sleepRng.normal(0, 0.3)));
      this.bedTs.push(viennaTs(d, (dow === 4 || dow === 5 ? 23.6 : 22.95) + sleepRng.normal(0, 0.35)));
    }
  }

  /** 0 = Monday … 6 = Sunday */
  private dow(d: number): number {
    return (((d + 3) % 7) + 7) % 7;
  }

  private month(d: number): number {
    return civilFromDays(d)[1];
  }

  private fitness(d: number): number {
    const i = d - this.firstDay;
    const p = clamp(i / this.days, 0, 1);
    let f = 0.12 + (0.78 * (1 - Math.exp(-2.6 * p))) / (1 - Math.exp(-2.6));
    if (i >= this.breakStart) {
      const since = i - this.breakStart;
      const lost = 0.1 * Math.min(1, since / Math.max(1, this.cfg.breakDays));
      f -= since <= this.cfg.breakDays ? lost : 0.1 * Math.exp(-(since - this.cfg.breakDays) / 35);
    }
    return clamp(f, 0, 1);
  }

  private placeSpecial(frac: number, plan: Plan, predicate?: (d: number) => boolean): number {
    let i = clamp(Math.floor(this.days * frac), 1, this.days - 2);
    for (let k = 0; k < 120 && predicate && !predicate(this.firstDay + i); k++)
      i = Math.min(this.days - 2, i + 1);
    const list = this.special.get(i) ?? [];
    list.push(plan);
    this.special.set(i, list);
    return i;
  }

  private planSpecials(): void {
    const summer = (d: number) => {
      const m = this.month(d);
      return m >= 5 && m <= 9;
    };
    this.placeSpecial(0.02, { kind: 'legacy', hour: 17.5 });
    this.placeSpecial(0.12, { kind: 'treadmill', hour: 18.75 });
    this.placeSpecial(0.18, { kind: 'race10k', hour: 9.5 }, (d) => this.dow(d) === 6);
    // trip to New York: the run abroad carries HKTimeZone=America/New_York
    const trip = this.placeSpecial(0.3, { kind: 'abroad', hour: 13.25 }, (d) => this.dow(d) === 2);
    this.tripStart = trip - 2;
    this.tripEnd = trip + 3;
    this.placeSpecial(0.4, { kind: 'easy', hour: 7.1, strava: true }, (d) => this.dow(d) === 1);
    this.placeSpecial(0.46, { kind: 'swim', hour: 7.0 }, (d) => this.dow(d) === 4);
    this.placeSpecial(0.5, { kind: 'race5k', hour: 10 }, (d) => this.dow(d) === 5);
    this.placeSpecial(0.35, { kind: 'hike', hour: 9.5 }, (d) => this.dow(d) === 6);
    this.placeSpecial(
      this.days > 100 ? 0.55 : 0.58,
      { kind: 'multisport', hour: 8.5 },
      (d) => this.dow(d) === 6 && (this.days < 100 || summer(d)),
    );
    this.placeSpecial(0.85, { kind: 'half', hour: 9 }, (d) => this.dow(d) === 6);
    this.placeSpecial(0.9, { kind: 'treadmill', hour: 18.5 });
  }

  private watch(d: number): Source {
    let ptr = this.devicePtr.get(`w${d}`);
    if (!ptr) {
      ptr = this.rng.hex(9);
      this.devicePtr.set(`w${d}`, ptr);
    }
    const hw = d - this.firstDay > this.days * 0.55 ? 'Watch7,2' : 'Watch6,2';
    const ver = osVersion(d, 'watch');
    return {
      name: `Apple Watch von ${OWNER}`,
      version: ver,
      device: `&lt;&lt;HKDevice: 0x${ptr}&gt;, name:Apple Watch, manufacturer:Apple Inc., model:Watch, hardware:${hw}, software:${ver}&gt;`,
    };
  }

  private phone(d: number): Source {
    let ptr = this.devicePtr.get(`p${d}`);
    if (!ptr) {
      ptr = this.rng.hex(9);
      this.devicePtr.set(`p${d}`, ptr);
    }
    const hw = d - this.firstDay > this.days * 0.4 ? 'iPhone16,1' : 'iPhone14,5';
    const ver = osVersion(d, 'phone');
    return {
      name: `iPhone von ${OWNER}`,
      version: ver,
      device: `&lt;&lt;HKDevice: 0x${ptr}&gt;, name:iPhone, manufacturer:Apple Inc., model:iPhone, hardware:${hw}, software:${ver}&gt;`,
    };
  }

  private rec(
    type: string,
    src: Source,
    unit: string | null,
    start: number,
    end: number,
    value: string,
    inner = '',
    created = end + 30,
  ): void {
    let s = ` <Record type="${type}" sourceName="${xmlAttr(src.name)}" sourceVersion="${src.version}"`;
    if (src.device) s += ` device="${src.device}"`;
    if (unit) s += ` unit="${unit}"`;
    s += ` creationDate="${fmt(created)}" startDate="${fmt(start)}" endDate="${fmt(end)}" value="${value}"`;
    this.sink.add(type, start, inner ? `${s}>\n${inner} </Record>\n` : `${s}/>\n`);
  }

  // -------------------------------------------------------------------------

  run(log: (m: string) => void): void {
    const rng = this.rng;
    // once: height
    this.rec(
      `${Q}Height`,
      this.phone(this.firstDay),
      'cm',
      viennaTs(this.firstDay, 9),
      viennaTs(this.firstDay, 9),
      String(HEIGHT_CM),
    );
    for (let i = 0; i < this.days; i++) {
      const d = this.firstDay + i;
      this.dayKcal = 0;
      this.dayExercise = 0;
      this.windows = [];
      const plans = this.planDay(i, d);
      for (const p of plans) this.doWorkout(i, d, p);
      this.background(i, d);
      this.sleep(i, d);
      this.daily(i, d);
      this.sink.flushDay();
      if (i % 60 === 0)
        log(`  day ${i + 1}/${this.days} (${dayString(d)}), ${this.sink.count.toLocaleString('en')} records`);
    }
    void rng;
  }

  private planDay(i: number, d: number): Plan[] {
    const rng = this.rng;
    const special = this.special.get(i);
    if (special) return special;
    if (i >= this.breakStart && i < this.breakEnd)
      return rng.chance(0.25) ? [{ kind: 'walk', hour: 18.5 }] : [];
    if (i >= this.tripStart && i <= this.tripEnd) return [];
    const dow = this.dow(d);
    const m = this.month(d);
    const season = m >= 4 && m <= 10;
    const winter = m === 12 || m <= 2;
    const week = Math.floor(i / 7);
    const out: Plan[] = [];
    const runOrTreadmill = (k: Kind, hour: number): Plan => ({
      kind: winter && rng.chance(0.35) && hour > 12 ? 'treadmill' : k,
      hour,
    });
    switch (dow) {
      case 0:
        if (rng.chance(0.45)) out.push({ kind: 'strength', hour: 18.5 });
        else if (rng.chance(0.25)) out.push({ kind: 'yoga', hour: 20 });
        break;
      case 1:
        if (rng.chance(0.85))
          out.push(runOrTreadmill(week % 2 === 0 ? 'intervals' : 'easy', rng.chance(0.6) ? 6.75 : 18.25));
        break;
      case 2:
        if (season && rng.chance(0.25)) out.push({ kind: 'ride', hour: 17.5 });
        else if (rng.chance(0.45)) out.push({ kind: 'walk', hour: 12.2 });
        else if (rng.chance(0.3)) out.push({ kind: 'hiit', hour: 18 });
        break;
      case 3:
        if (rng.chance(0.8)) out.push(runOrTreadmill(week % 3 === 1 ? 'tempo' : 'easy', 18.25));
        break;
      case 4:
        if (rng.chance(0.3)) out.push({ kind: 'swim', hour: 7 });
        else if (rng.chance(0.25)) out.push({ kind: 'yoga', hour: 20 });
        break;
      case 5:
        if (rng.chance(0.8)) out.push({ kind: 'long', hour: 8.75 });
        break;
      case 6:
        if (season) {
          const r = rng.next();
          if (r < 0.15) out.push({ kind: 'longride', hour: 9 });
          else if (r < 0.5) out.push({ kind: 'ride', hour: 9.5 });
          else if (r < 0.68) out.push({ kind: 'hike', hour: 9.5 });
          else if (r < 0.9) out.push({ kind: 'walk', hour: 15.5 });
        } else {
          const r = rng.next();
          if (r < 0.15) out.push({ kind: 'hike', hour: 10 });
          else if (r < 0.65) out.push({ kind: 'walk', hour: 14.5 });
          else if (r < 0.8) out.push({ kind: 'easy', hour: 10 });
        }
        break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // workouts
  // -------------------------------------------------------------------------

  private writeGpx(pts: GpsPoint[], startTs: number): string {
    const tz = viennaTz(startTs);
    const local = new Date((startTs + tz * 60) * 1000);
    const h = local.getUTCHours();
    const name = `${dayString(Math.floor((startTs + tz * 60) / 86400))}_${((h + 11) % 12) + 1}.${P2[local.getUTCMinutes()]}${h < 12 ? 'am' : 'pm'}`;
    let file = `route_${name}.gpx`;
    for (let k = 2; this.routeFiles.includes(file); k++) file = `route_${name}_${k}.gpx`;
    const lines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Apple Health Export" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
      ' <metadata>',
      `  <time>${formatIsoUtc(pts[0]!.t)}</time>`,
      ' </metadata>',
      ' <trk>',
      `  <name>Route ${name.replace('_', ' ').replace('.', ':')}</name>`,
      '  <trkseg>',
    ];
    for (const p of pts) {
      lines.push(
        `   <trkpt lon="${p.lon.toFixed(6)}" lat="${p.lat.toFixed(6)}"><ele>${p.ele.toFixed(6)}</ele><time>${formatIsoUtc(p.t)}</time><extensions><speed>${p.speed.toFixed(6)}</speed><course>${p.course.toFixed(6)}</course><hAcc>${p.hAcc.toFixed(6)}</hAcc><vAcc>${p.vAcc.toFixed(6)}</vAcc></extensions></trkpt>`,
      );
    }
    lines.push('  </trkseg>', ' </trk>', '</gpx>', '');
    fs.writeFileSync(path.join(this.tmp, 'apple_health_export', 'workout-routes', file), lines.join('\n'));
    this.routeFiles.push(file);
    return file;
  }

  /** Emit the per-sample records a workout produces (Watch). */
  private workoutRecords(
    d: number,
    r: MoveResult,
    opts: { foot?: boolean; ride?: boolean; exercise?: boolean; phoneSteps?: boolean; runDynamics?: boolean },
  ): void {
    const w = this.watch(d);
    const motion = '  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="2"/>\n';
    for (const [t, bpm] of r.hr) this.rec(`${Q}HeartRate`, w, 'count/min', t, t, String(bpm), motion, t + 40);
    for (const [s, e, k] of r.kcal) {
      this.rec(`${Q}ActiveEnergyBurned`, w, 'kcal', s, e, f3(k));
      this.dayKcal += k;
    }
    if (opts.exercise !== false)
      for (const [s, e] of r.kcal)
        if (e - s >= 30) {
          this.rec(`${Q}AppleExerciseTime`, w, 'min', s, e, '1');
          this.dayExercise += 1;
        }
    if (opts.foot) {
      for (const [s, e, n] of r.steps) this.rec(`${Q}StepCount`, w, 'count', s, e, String(n));
      for (const [s, e, m] of r.dist)
        this.rec(`${Q}DistanceWalkingRunning`, w, 'km', s, e, (m / 1000).toFixed(5));
    }
    if (opts.ride)
      for (const [s, e, m] of r.dist) this.rec(`${Q}DistanceCycling`, w, 'km', s, e, (m / 1000).toFixed(5));
    if (opts.phoneSteps) {
      // the phone in the pocket counts too (overlapping intervals → deduplicated per hour)
      const p = this.phone(d);
      for (let k = 0; k < r.steps.length; k += 3) {
        const chunk = r.steps.slice(k, k + 3);
        const n = chunk.reduce((a, x) => a + x[2], 0);
        this.rec(
          `${Q}StepCount`,
          p,
          'count',
          chunk[0]![0],
          chunk[chunk.length - 1]![1],
          String(Math.round(n * this.rng.range(0.9, 1.0))),
        );
      }
    }
    if (opts.runDynamics) {
      for (const [t, wv] of r.power) this.rec(`${Q}RunningPower`, w, 'W', t, t + 10, String(wv));
      for (let k = 0; k < r.dist.length; k += 2) {
        const [s, e, m] = r.dist[k]!;
        const v = m / Math.max(1, e - s);
        if (v < 1.5) continue;
        const cad = clamp(150 + 8 * v, 150, 196);
        this.rec(`${Q}RunningSpeed`, w, 'km/hr', s, e, f2(v * 3.6));
        this.rec(`${Q}RunningStrideLength`, w, 'm', s, e, f2(v / (cad / 60) + this.rng.normal(0, 0.02)));
        this.rec(
          `${Q}RunningVerticalOscillation`,
          w,
          'cm',
          s,
          e,
          f1(9.4 - 0.4 * v + this.rng.normal(0, 0.3)),
        );
        this.rec(
          `${Q}RunningGroundContactTime`,
          w,
          'ms',
          s,
          e,
          String(Math.round(330 - 25 * v + this.rng.normal(0, 6))),
        );
      }
    } else if (opts.ride) {
      for (const [t, wv] of r.power) this.rec(`${Q}CyclingPower`, w, 'W', t, t + 10, String(wv));
    }
    for (const [t, c] of r.cadence) this.rec(`${Q}CyclingCadence`, w, 'count/min', t, t + 10, String(c));
    this.windows.push([r.start, r.end, hrStats(r).avg]);
  }

  private commonMeta(
    d: number,
    start: number,
    indoor: boolean,
    ascentM: number | null,
    mets: number,
    zone = 'Europe/Vienna',
  ): [string, string][] {
    const rng = this.rng;
    const m = this.month(d);
    const tempC = 11 + 11 * Math.sin(((m - 4) / 12) * 2 * Math.PI) + rng.normal(0, 3);
    const meta: [string, string][] = [['HKIndoorWorkout', indoor ? '1' : '0']];
    if (ascentM !== null && ascentM > 0)
      meta.push(['HKElevationAscended', `${Math.round(ascentM * 100)} cm`]);
    meta.push(['HKAverageMETs', `${mets.toFixed(5)} kcal/hr·kg`]);
    meta.push(['HKTimeZone', zone]);
    if (!indoor) {
      meta.push(['HKWeatherHumidity', `${Math.round(clamp(rng.normal(68, 12), 25, 98)) * 100} %`]);
      meta.push(['HKWeatherTemperature', `${((tempC * 9) / 5 + 32).toFixed(1)} degF`]);
    }
    void start;
    return meta;
  }

  private kmSegments(r: MoveResult): WorkoutEventOut[] {
    const out: WorkoutEventOut[] = [];
    let acc = 0;
    let segStart = r.start;
    let t = r.start;
    for (const v of r.speeds) {
      acc += v;
      t += 1;
      if (acc >= 1000) {
        out.push({ type: 'Segment', ts: segStart, durMin: (t - segStart) / 60 });
        acc -= 1000;
        segStart = t;
      }
    }
    return out;
  }

  private emitWorkout(w: WorkoutOut): void {
    fs.writeSync(this.workoutsFd, workoutXml(w, this.rng));
    this.workouts++;
  }

  private vo2(d: number, ts: number): void {
    this.rec(
      `${Q}VO2Max`,
      this.watch(d),
      'mL/min·kg',
      ts,
      ts,
      f2(this.ath.vo2(d) + this.rng.normal(0, 0.35)),
      '  <MetadataEntry key="HKVO2MaxTestType" value="2"/>\n',
      ts + 3600,
    );
  }

  private doWorkout(i: number, d: number, p: Plan): void {
    const rng = this.rng;
    const mass = this.ath.mass(d);
    const start = viennaTs(d, p.hour + rng.range(-0.15, 0.15));
    const vE = this.ath.vEasy(d);
    const runOpts = (course: Course, speed: MoveOpts['speed'], extra: Partial<MoveOpts> = {}): MoveOpts => ({
      sport: 'run',
      course,
      length: course.length,
      start,
      speed,
      power: true,
      glitch: rng.chance(0.25),
      pause: rng.chance(0.15) ? { atS: course.length * rng.range(0.3, 0.7), dur: rng.int(40, 180) } : null,
      ...extra,
    });
    const jitter = (amp: number) => (s: number, t: number, grade: number) =>
      (1 + amp * Math.sin(t / 97) + 0.02 * Math.sin(t / 13)) *
      (grade > 0 ? 1 - 3.2 * grade : 1 - 1.4 * grade);

    switch (p.kind) {
      case 'easy':
      case 'tempo':
      case 'long':
      case 'intervals':
      case 'race5k':
      case 'race10k':
      case 'half':
      case 'abroad': {
        let course: Course;
        let speed: MoveOpts['speed'];
        let stops: number[] = [];
        let urban = false;
        const j = jitter(0.03);
        let label = 'run';
        switch (p.kind) {
          case 'easy': {
            const r = rng.next();
            const dist = rng.range(6000, 9500);
            if (r < 0.4) course = Course.build(ROUTES.prater!, 'pingpong', dist);
            else if (r < 0.65) course = Course.build(ROUTES.donauinsel!, 'pingpong', dist);
            else if (r < 0.88) {
              course = Course.build(ROUTES.ring!, 'loop', dist);
              urban = true;
              stops = Array.from({ length: 6 }, () => rng.range(300, course.length - 300));
            } else course = Course.build(ROUTES.augarten!, 'loop', dist);
            speed = (s, t, g) => vE * j(s, t, g);
            break;
          }
          case 'tempo': {
            course = Course.build(ROUTES.prater!, 'pingpong', rng.range(8000, 10500));
            const L = course.length;
            speed = (s, t, g) => vE * (s > 2000 && s < L - 1500 ? 1.13 : 0.97) * j(s, t, g);
            label = 'tempo';
            break;
          }
          case 'long': {
            const dist = rng.range(13000, 21000) * (0.75 + 0.25 * this.fitness(d));
            course = Course.build(rng.chance(0.5) ? ROUTES.donauinsel! : ROUTES.prater!, 'pingpong', dist);
            speed = (s, t, g) => vE * 0.93 * (1 - 0.04 * (s / dist)) * j(s, t, g);
            break;
          }
          case 'intervals': {
            const reps = rng.int(5, 7);
            const work = rng.pick([800, 1000]);
            const recov = 400;
            const warm = 2000;
            course = Course.build(ROUTES.prater!, 'pingpong', warm + reps * (work + recov) + 1500);
            speed = (s, t, g) => {
              if (s < warm || s > warm + reps * (work + recov)) return vE * 0.95 * j(s, t, g);
              const k = (s - warm) % (work + recov);
              return vE * (k < work ? 1.3 : 0.72);
            };
            label = 'intervals';
            break;
          }
          case 'race5k':
          case 'race10k':
          case 'half': {
            const dist = p.kind === 'race5k' ? 5000 : p.kind === 'race10k' ? 10000 : 21097.5;
            const f = p.kind === 'race5k' ? 1.26 : p.kind === 'race10k' ? 1.2 : 1.12;
            // race courses measure a little long on GPS
            course = Course.build(
              p.kind === 'half' ? ROUTES.half! : ROUTES.prater!,
              'pingpong',
              dist * 1.012,
            );
            speed = (s, t, g) =>
              vE *
              f *
              (s > dist - 600 ? 1.05 : 1) *
              (1 + 0.01 * Math.sin(t / 50)) *
              (g > 0 ? 1 - 2.5 * g : 1 - g);
            label = 'race';
            break;
          }
          default: {
            course = Course.build(ROUTES.centralpark!, 'loop', rng.range(9000, 10100));
            speed = (s, t, g) => vE * 0.98 * j(s, t, g);
          }
        }
        const race = label === 'race';
        const r = simulateMove(
          rng,
          this.ath,
          d,
          mass,
          runOpts(course, speed, { stops, urban, boost: race ? 0.08 : 0, ...(race ? { pause: null } : {}) }),
        );
        const w = this.watch(d);
        this.workoutRecords(d, r, { foot: true, phoneSteps: rng.chance(0.5), runDynamics: true });
        if (r.activeS > 20 * 60) this.vo2(d, r.end + 600);
        const file = this.writeGpx(r.pts, r.start);
        const hs = hrStats(r);
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        const steps = r.steps.reduce((a, x) => a + x[2], 0);
        const appleDist = r.distance * (race ? rng.range(1.0, 1.008) : rng.range(0.99, 1.015));
        const powers = r.power.map((x) => x[1]);
        const moving = r.speeds.filter((v) => v > 1);
        const zone = p.kind === 'abroad' ? 'America/New_York' : 'Europe/Vienna';
        const stats: Stat[] = [
          { type: `${Q}ActiveEnergyBurned`, start: r.start, end: r.end, sum: kcal, unit: 'kcal' },
          {
            type: `${Q}BasalEnergyBurned`,
            start: r.start,
            end: r.end,
            sum: ((r.end - r.start) / 86400) * 1750,
            unit: 'kcal',
          },
          {
            type: `${Q}DistanceWalkingRunning`,
            start: r.start,
            end: r.end,
            sum: appleDist / 1000,
            unit: 'km',
            digits: 5,
          },
          { type: `${Q}StepCount`, start: r.start, end: r.end, sum: steps, unit: 'count', digits: 0 },
          {
            type: `${Q}HeartRate`,
            start: r.start,
            end: r.end,
            avg: hs.avg,
            min: hs.min,
            max: hs.max,
            unit: 'count/min',
            digits: 2,
          },
          {
            type: `${Q}RunningPower`,
            start: r.start,
            end: r.end,
            avg: powers.reduce((a, b) => a + b, 0) / Math.max(1, powers.length),
            min: Math.min(...powers),
            max: Math.max(...powers),
            unit: 'W',
            digits: 1,
          },
          {
            type: `${Q}RunningSpeed`,
            start: r.start,
            end: r.end,
            avg: (moving.reduce((a, b) => a + b, 0) / Math.max(1, moving.length)) * 3.6,
            min: Math.min(...moving) * 3.6,
            max: Math.max(...moving) * 3.6,
            unit: 'km/hr',
          },
        ];
        const meta = this.commonMeta(
          d,
          r.start,
          false,
          r.ascent,
          (kcal / mass / ((r.end - r.start) / 3600)) * 1.0,
          zone,
        );
        if (label === 'race') meta.push(['HKWorkoutBrandName', 'Vienna Running Events']);
        const out: WorkoutOut = {
          type: `${W}Running`,
          start: r.start,
          end: r.end,
          activeS: r.activeS,
          src: w,
          meta,
          events: [...r.events, ...this.kmSegments(r)].sort((a, b) => a.ts - b.ts),
          stats,
          activities: [
            {
              type: `${W}Running`,
              start: r.start,
              end: r.end,
              activeS: r.activeS,
              stats: stats.slice(0, 3),
              meta: meta.slice(0, 1),
              events: [],
            },
          ],
          route: { file, start: r.pts[0]!.t, end: r.pts[r.pts.length - 1]!.t },
        };
        this.emitWorkout(out);
        if (p.strava) {
          // Strava wrote a copy of this run back to Apple Health
          this.emitWorkout({
            type: `${W}Running`,
            start: r.start + 2,
            end: r.end - 3,
            activeS: r.activeS - 5,
            src: { name: 'Strava', version: '412.0.1', device: null },
            meta: [['HKIndoorWorkout', '0']],
            events: [],
            stats: [
              {
                type: `${Q}ActiveEnergyBurned`,
                start: r.start + 2,
                end: r.end - 3,
                sum: kcal * 0.96,
                unit: 'kcal',
              },
              {
                type: `${Q}DistanceWalkingRunning`,
                start: r.start + 2,
                end: r.end - 3,
                sum: (r.distance * 1.004) / 1000,
                unit: 'km',
                digits: 5,
              },
            ],
            activities: [],
            route: null,
          });
        }
        break;
      }

      case 'treadmill': {
        const dist = rng.range(6000, 9000);
        const r = simulateMove(rng, this.ath, d, mass, {
          sport: 'run',
          course: null,
          length: dist,
          start,
          speed: (s, t) =>
            vE * (1.02 + (s > dist * 0.5 && s < dist * 0.75 ? 0.08 : 0) + 0.005 * Math.sin(t / 60)),
          power: true,
        });
        this.workoutRecords(d, r, { foot: true, runDynamics: true });
        const hs = hrStats(r);
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        const steps = r.steps.reduce((a, x) => a + x[2], 0);
        const stats: Stat[] = [
          { type: `${Q}ActiveEnergyBurned`, start: r.start, end: r.end, sum: kcal, unit: 'kcal' },
          {
            type: `${Q}DistanceWalkingRunning`,
            start: r.start,
            end: r.end,
            sum: r.dist.reduce((a, x) => a + x[2], 0) / 1000,
            unit: 'km',
            digits: 5,
          },
          { type: `${Q}StepCount`, start: r.start, end: r.end, sum: steps, unit: 'count', digits: 0 },
          {
            type: `${Q}HeartRate`,
            start: r.start,
            end: r.end,
            avg: hs.avg,
            min: hs.min,
            max: hs.max,
            unit: 'count/min',
            digits: 2,
          },
        ];
        this.emitWorkout({
          type: `${W}Running`,
          start: r.start,
          end: r.end,
          activeS: r.activeS,
          src: this.watch(d),
          meta: this.commonMeta(d, r.start, true, null, 9.5),
          events: this.kmSegments(r),
          stats,
          activities: [],
          route: null,
        });
        break;
      }

      case 'legacy': {
        // pre-iOS 16 style: totals as attributes, no statistics, written by a third-party app
        const course = Course.build(ROUTES.prater!, 'pingpong', rng.range(5500, 7000));
        const r = simulateMove(rng, this.ath, d, mass, {
          sport: 'run',
          course,
          length: course.length,
          start,
          speed: (s, t, g) => vE * jitter(0.03)(s, t, g),
        });
        // the watch only sampled heart rate in the background (every ~minute)
        const wsrc = this.watch(d);
        for (let k = 0; k < r.hr.length; k += 12)
          this.rec(`${Q}HeartRate`, wsrc, 'count/min', r.hr[k]![0], r.hr[k]![0], String(r.hr[k]![1]));
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        this.dayKcal += kcal;
        this.windows.push([r.start, r.end, hrStats(r).avg]);
        this.emitWorkout({
          type: `${W}Running`,
          start: r.start,
          end: r.end,
          activeS: r.activeS,
          src: { name: 'Runkeeper', version: '14.9.1', device: null },
          meta: [['HKIndoorWorkout', '0']],
          events: [],
          stats: [],
          activities: [],
          route: null,
          legacy: { distKm: r.distance / 1000, kcal },
        });
        break;
      }

      case 'walk':
      case 'hike': {
        const hike = p.kind === 'hike';
        let course: Course;
        let urban = false;
        if (hike)
          course = Course.build(
            ROUTES.kahlenberg!,
            'loop',
            rng.chance(0.5) ? ROUTES.kahlenberg!.length * 0 + 19900 : rng.range(9000, 13000),
          );
        else {
          const r = rng.next();
          const dist = rng.range(2500, 5500);
          if (r < 0.35) course = Course.build(ROUTES.augarten!, 'loop', dist);
          else if (r < 0.65) course = Course.build(ROUTES.schoenbrunn!, 'loop', dist);
          else {
            course = Course.build(ROUTES.ring!, 'loop', dist);
            urban = true;
          }
        }
        const vw = hike ? 1.25 : 1.38;
        const r = simulateMove(rng, this.ath, d, mass, {
          sport: hike ? 'hike' : 'walk',
          course,
          length: course.length,
          start,
          urban,
          stops: urban ? [500, 1200, 1900, 2600] : [],
          speed: (s, t, g) =>
            hike
              ? vw * 1.5 * Math.exp(-3.5 * Math.abs(g + 0.05)) * (1 + 0.04 * Math.sin(t / 80))
              : vw * (1 + 0.05 * Math.sin(t / 70)),
          pause: hike ? { atS: course.length * 0.5, dur: rng.int(600, 1500) } : null,
        });
        this.workoutRecords(d, r, { foot: true, phoneSteps: true, exercise: hike });
        if (hike)
          this.rec(
            `${Q}FlightsClimbed`,
            this.watch(d),
            'count',
            r.start,
            r.end,
            String(Math.round(r.ascent / 3)),
          );
        const file = this.writeGpx(r.pts, r.start);
        const hs = hrStats(r);
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        const stats: Stat[] = [
          { type: `${Q}ActiveEnergyBurned`, start: r.start, end: r.end, sum: kcal, unit: 'kcal' },
          {
            type: `${Q}DistanceWalkingRunning`,
            start: r.start,
            end: r.end,
            sum: (r.distance * rng.range(0.98, 1.02)) / 1000,
            unit: 'km',
            digits: 5,
          },
          {
            type: `${Q}StepCount`,
            start: r.start,
            end: r.end,
            sum: r.steps.reduce((a, x) => a + x[2], 0),
            unit: 'count',
            digits: 0,
          },
          {
            type: `${Q}HeartRate`,
            start: r.start,
            end: r.end,
            avg: hs.avg,
            min: hs.min,
            max: hs.max,
            unit: 'count/min',
            digits: 2,
          },
        ];
        if (hike)
          stats.push({
            type: `${Q}FlightsClimbed`,
            start: r.start,
            end: r.end,
            sum: Math.round(r.ascent / 3),
            unit: 'count',
            digits: 0,
          });
        this.emitWorkout({
          type: `${W}${hike ? 'Hiking' : 'Walking'}`,
          start: r.start,
          end: r.end,
          activeS: r.activeS,
          src: this.watch(d),
          meta: this.commonMeta(d, r.start, false, r.ascent, hike ? 6.2 : 3.6),
          events: r.events,
          stats,
          activities: [],
          route: { file, start: r.pts[0]!.t, end: r.pts[r.pts.length - 1]!.t },
        });
        break;
      }

      case 'ride':
      case 'longride': {
        const long = p.kind === 'longride';
        const course = long
          ? Course.build(ROUTES.tulln!, 'pingpong', rng.range(55000, 72000))
          : Course.build(ROUTES.klosterneuburg!, 'pingpong', rng.range(18000, 24000));
        const sensors = rng.chance(0.35);
        const vr = 6.6 + 1.1 * this.fitness(d);
        const r = simulateMove(rng, this.ath, d, mass, {
          sport: 'ride',
          course,
          length: course.length,
          start,
          speed: (s, t, g) => clamp(vr * (1 - 9 * g) * (1 + 0.06 * Math.sin(t / 150)), 2.2, 15),
          stops: Array.from({ length: long ? 4 : 3 }, () => rng.range(800, course.length - 800)),
          autoPause: true,
          power: sensors,
          cadenceSensor: sensors,
          glitch: rng.chance(0.2),
        });
        this.workoutRecords(d, r, { ride: true });
        const file = this.writeGpx(r.pts, r.start);
        const hs = hrStats(r);
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        const moving = r.speeds.filter((v) => v > 1);
        const stats: Stat[] = [
          { type: `${Q}ActiveEnergyBurned`, start: r.start, end: r.end, sum: kcal, unit: 'kcal' },
          {
            type: `${Q}DistanceCycling`,
            start: r.start,
            end: r.end,
            sum: (r.distance * rng.range(0.995, 1.01)) / 1000,
            unit: 'km',
            digits: 5,
          },
          {
            type: `${Q}HeartRate`,
            start: r.start,
            end: r.end,
            avg: hs.avg,
            min: hs.min,
            max: hs.max,
            unit: 'count/min',
            digits: 2,
          },
          {
            type: `${Q}CyclingSpeed`,
            start: r.start,
            end: r.end,
            avg: (moving.reduce((a, b) => a + b, 0) / Math.max(1, moving.length)) * 3.6,
            unit: 'km/hr',
          },
        ];
        if (sensors) {
          const pw = r.power.map((x) => x[1]);
          const cad = r.cadence.map((x) => x[1]).filter((c) => c > 0);
          stats.push({
            type: `${Q}CyclingPower`,
            start: r.start,
            end: r.end,
            avg: pw.reduce((a, b) => a + b, 0) / pw.length,
            min: Math.min(...pw),
            max: Math.max(...pw),
            unit: 'W',
            digits: 1,
          });
          stats.push({
            type: `${Q}CyclingCadence`,
            start: r.start,
            end: r.end,
            avg: cad.reduce((a, b) => a + b, 0) / cad.length,
            unit: 'count/min',
            digits: 1,
          });
        }
        this.emitWorkout({
          type: `${W}Cycling`,
          start: r.start,
          end: r.end,
          activeS: r.activeS,
          src: this.watch(d),
          meta: this.commonMeta(d, r.start, false, r.ascent, 7.5),
          events: r.events,
          stats,
          activities: [],
          route: { file, start: r.pts[0]!.t, end: r.pts[r.pts.length - 1]!.t },
        });
        break;
      }

      case 'swim': {
        // pool, 25 m lengths: sets with rests, lap + segment events, per-length distance & stroke records
        const w = this.watch(d);
        const rest = this.ath.rest(d);
        const sets = rng.pick([
          [400, 400, 400, 300],
          [200, 200, 200, 200, 200, 200, 100],
          [500, 500, 500],
          [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 300],
        ]);
        const vSwim = 0.88 + 0.12 * this.fitness(d);
        let t = start;
        const lengths: [number, number, number][] = [];
        const events: WorkoutEventOut[] = [];
        const hrIntervals: [number, number, boolean][] = [];
        for (const set of sets) {
          const setStart = t;
          for (let k = 0; k < set / 25; k++) {
            const dur = 25 / (vSwim * rng.range(0.94, 1.06)) + rng.range(1, 3);
            const strokes = Math.round(rng.range(15, 20));
            lengths.push([t, t + dur, strokes]);
            events.push({ type: 'Lap', ts: t, durMin: dur / 60, meta: [['HKSwimmingStrokeStyle', '2']] });
            hrIntervals.push([t, t + dur, true]);
            t += dur;
          }
          events.push({ type: 'Segment', ts: setStart, durMin: (t - setStart) / 60 });
          const pause = rng.range(20, 45);
          hrIntervals.push([t, t + pause, false]);
          t += pause;
        }
        const end = Math.round(t);
        const r = simulateStatic(
          rng,
          rest,
          start,
          end - start,
          (sec) => {
            const ts = start + sec;
            const iv = hrIntervals.find(([a, b]) => ts >= a && ts < b);
            return iv?.[2] ? 0.68 : 0.42;
          },
          (i) => (i > 0.5 ? 9.5 : 3),
        );
        this.workoutRecords(d, r, {});
        for (const [s, e, strokes] of lengths) {
          this.rec(`${Q}DistanceSwimming`, w, 'm', s, e, '25');
          this.rec(
            `${Q}SwimmingStrokeCount`,
            w,
            'count',
            s,
            e,
            String(strokes),
            '  <MetadataEntry key="HKSwimmingStrokeStyle" value="2"/>\n',
          );
        }
        const hs = hrStats(r);
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        const total = lengths.length * 25;
        this.emitWorkout({
          type: `${W}Swimming`,
          start,
          end,
          activeS: end - start,
          src: w,
          meta: [
            ['HKIndoorWorkout', '0'],
            ['HKSwimmingLocationType', '1'],
            ['HKLapLength', '25 m'],
            ['HKAverageMETs', '8.20000 kcal/hr·kg'],
            ['HKTimeZone', 'Europe/Vienna'],
          ],
          events: events.sort((a, b) => a.ts - b.ts),
          stats: [
            { type: `${Q}ActiveEnergyBurned`, start, end, sum: kcal, unit: 'kcal' },
            { type: `${Q}DistanceSwimming`, start, end, sum: total, unit: 'm', digits: 0 },
            {
              type: `${Q}SwimmingStrokeCount`,
              start,
              end,
              sum: lengths.reduce((a, x) => a + x[2], 0),
              unit: 'count',
              digits: 0,
            },
            {
              type: `${Q}HeartRate`,
              start,
              end,
              avg: hs.avg,
              min: hs.min,
              max: hs.max,
              unit: 'count/min',
              digits: 2,
            },
          ],
          activities: [],
          route: null,
        });
        break;
      }

      case 'strength':
      case 'hiit':
      case 'yoga': {
        const rest = this.ath.rest(d);
        const dur =
          p.kind === 'yoga'
            ? rng.int(30, 55) * 60
            : p.kind === 'hiit'
              ? rng.int(22, 32) * 60
              : rng.int(40, 60) * 60;
        const r = simulateStatic(
          rng,
          rest,
          start,
          dur,
          (t) =>
            p.kind === 'yoga'
              ? 0.17 + 0.06 * Math.sin(t / 120)
              : p.kind === 'hiit'
                ? t < 300 || t > dur - 240
                  ? 0.45
                  : t % 60 < 40
                    ? 0.86
                    : 0.6
                : t % 135 < 45
                  ? 0.56
                  : 0.36,
          (i) => 1.5 + 11 * i,
        );
        this.workoutRecords(d, r, { exercise: p.kind !== 'yoga' });
        const hs = hrStats(r);
        const kcal = r.kcal.reduce((a, x) => a + x[2], 0);
        const type =
          p.kind === 'yoga'
            ? 'Yoga'
            : p.kind === 'hiit'
              ? 'HighIntensityIntervalTraining'
              : 'TraditionalStrengthTraining';
        this.emitWorkout({
          type: `${W}${type}`,
          start,
          end: start + dur,
          activeS: dur,
          src: this.watch(d),
          meta: [
            ['HKIndoorWorkout', '1'],
            ['HKAverageMETs', `${(1.5 + (kcal / dur) * 60).toFixed(5)} kcal/hr·kg`],
            ['HKTimeZone', 'Europe/Vienna'],
          ],
          events: [],
          stats: [
            { type: `${Q}ActiveEnergyBurned`, start, end: start + dur, sum: kcal, unit: 'kcal' },
            {
              type: `${Q}HeartRate`,
              start,
              end: start + dur,
              avg: hs.avg,
              min: hs.min,
              max: hs.max,
              unit: 'count/min',
              digits: 2,
            },
          ],
          activities: [],
          route: null,
        });
        break;
      }

      case 'multisport': {
        // iOS 16+ swim-bike-run with WorkoutActivity children and transitions, one route for the whole session
        const w = this.watch(d);
        const water: Waypoint[] = ROUTES.donauinsel!.slice(0, 12).map(([la, lo, e]) => [
          la + 0.00045,
          lo + 0.00075,
          e - 1,
        ]);
        const swimCourse = Course.build(water, 'pingpong', 1500);
        const swim = simulateMove(rng, this.ath, d, mass, {
          sport: 'swim',
          course: swimCourse,
          length: swimCourse.length,
          start,
          speed: (_s, t) => 0.95 * (1 + 0.04 * Math.sin(t / 40)),
        });
        const t1 = swim.end + rng.int(150, 240);
        const bikeCourse = Course.build(ROUTES.klosterneuburg!, 'pingpong', 20000);
        const bike = simulateMove(rng, this.ath, d, mass, {
          sport: 'ride',
          course: bikeCourse,
          length: bikeCourse.length,
          start: t1,
          speed: (_s, t, g) => clamp(7.8 * (1 - 9 * g) * (1 + 0.04 * Math.sin(t / 120)), 3, 14),
          hrStart: swim.hrLast,
        });
        const t2 = bike.end + rng.int(90, 150);
        const runCourse = Course.build(ROUTES.donauinsel!, 'pingpong', 5000);
        const run = simulateMove(rng, this.ath, d, mass, {
          sport: 'run',
          course: runCourse,
          length: runCourse.length,
          start: t2,
          speed: (_s, t, g) => vE * 1.08 * jitter(0.02)(_s, t, g),
          hrStart: bike.hrLast,
          power: true,
        });
        const all = [swim, bike, run];
        for (const r of all)
          this.workoutRecords(d, r, { foot: r === run, ride: r === bike, runDynamics: r === run });
        const file = this.writeGpx([...swim.pts, ...bike.pts, ...run.pts], swim.start);
        const leg = (r: MoveResult, type: string, distType: string, unit: 'm' | 'km'): ActivityOut => {
          const hs = hrStats(r);
          return {
            type: `${W}${type}`,
            start: r.start,
            end: r.end,
            activeS: r.activeS,
            meta: [],
            events: [],
            stats: [
              {
                type: `${Q}ActiveEnergyBurned`,
                start: r.start,
                end: r.end,
                sum: r.kcal.reduce((a, x) => a + x[2], 0),
                unit: 'kcal',
              },
              {
                type: distType,
                start: r.start,
                end: r.end,
                sum: unit === 'km' ? r.distance / 1000 : r.distance,
                unit,
                digits: unit === 'km' ? 5 : 1,
              },
              {
                type: `${Q}HeartRate`,
                start: r.start,
                end: r.end,
                avg: hs.avg,
                min: hs.min,
                max: hs.max,
                unit: 'count/min',
                digits: 2,
              },
            ],
          };
        };
        const transition = (s: number, e: number): ActivityOut => ({
          type: `${W}Transition`,
          start: s,
          end: e,
          activeS: e - s,
          meta: [],
          events: [],
          stats: [],
        });
        const activities = [
          {
            ...leg(swim, 'Swimming', `${Q}DistanceSwimming`, 'm'),
            meta: [['HKSwimmingLocationType', '2']] as [string, string][],
          },
          transition(swim.end, t1),
          leg(bike, 'Cycling', `${Q}DistanceCycling`, 'km'),
          transition(bike.end, t2),
          leg(run, 'Running', `${Q}DistanceWalkingRunning`, 'km'),
        ];
        const hrAll = all.flatMap((r) => r.hr.map((x) => x[1]));
        const kcal = all.reduce((a, r) => a + r.kcal.reduce((b, x) => b + x[2], 0), 0);
        this.emitWorkout({
          type: `${W}SwimBikeRun`,
          start: swim.start,
          end: run.end,
          activeS: run.end - swim.start,
          src: w,
          meta: this.commonMeta(d, swim.start, false, bike.ascent + run.ascent, 9),
          events: [],
          stats: [
            { type: `${Q}ActiveEnergyBurned`, start: swim.start, end: run.end, sum: kcal, unit: 'kcal' },
            {
              type: `${Q}DistanceSwimming`,
              start: swim.start,
              end: swim.end,
              sum: swim.distance,
              unit: 'm',
              digits: 1,
            },
            {
              type: `${Q}DistanceCycling`,
              start: bike.start,
              end: bike.end,
              sum: bike.distance / 1000,
              unit: 'km',
              digits: 5,
            },
            {
              type: `${Q}DistanceWalkingRunning`,
              start: run.start,
              end: run.end,
              sum: run.distance / 1000,
              unit: 'km',
              digits: 5,
            },
            {
              type: `${Q}HeartRate`,
              start: swim.start,
              end: run.end,
              avg: hrAll.reduce((a, b) => a + b, 0) / hrAll.length,
              min: Math.min(...hrAll),
              max: Math.max(...hrAll),
              unit: 'count/min',
              digits: 2,
            },
          ],
          activities,
          route: { file, start: swim.pts[0]!.t, end: run.pts[run.pts.length - 1]!.t },
        });
        break;
      }
    }
    void i;
  }

  // -------------------------------------------------------------------------
  // background records of a day
  // -------------------------------------------------------------------------

  private inWorkout(ts: number, margin = 60): [number, number, number] | null {
    for (const w of this.windows) if (ts >= w[0] - margin && ts <= w[1] + margin) return w;
    return null;
  }

  private background(i: number, d: number): void {
    const rng = this.rng;
    const w = this.watch(d);
    const ph = this.phone(d);
    const rest = this.ath.rest(d);
    const wake = this.wakeTs[i]!;
    const bed = this.bedTs[i]!;
    const prevBed = i > 0 ? this.bedTs[i - 1]! : wake - 8 * 3600;
    const dayStart = viennaTs(d, 0);
    const dayEnd = viennaTs(d + 1, 0);
    const dow = this.dow(d);
    const weekday = dow < 5;
    const asleep = (ts: number) => (ts >= prevBed + 600 && ts < wake) || ts >= bed + 600;

    // activity per minute (steps/min), workouts excluded
    const minutes = Math.round((dayEnd - dayStart) / 60);
    const act = new Float64Array(minutes);
    for (let m = 0; m < minutes; m++) {
      const ts = dayStart + m * 60;
      if (asleep(ts) || ts < wake || this.inWorkout(ts, 0)) continue;
      const h = (ts - dayStart) / 3600;
      let r = rng.chance(0.35) ? rng.range(0, 30) : 0;
      if (weekday && ((h > 7.75 && h < 8.2) || (h > 17.3 && h < 17.75))) r = rng.range(85, 112);
      if (weekday && h > 12.1 && h < 12.4 && rng.chance(0.6)) r = rng.range(70, 100);
      if (!weekday && h > 10 && h < 18 && rng.chance(0.25)) r = rng.range(60, 100);
      act[m] = r;
    }
    const sumAct = (a: number, b: number) => {
      let s = 0;
      for (let m = Math.max(0, a); m < Math.min(minutes, b); m++) s += act[m]!;
      return s;
    };
    // watch steps & distance: intervals of 8–25 min
    let walkingSteps = 0;
    for (let m = 0; m < minutes;) {
      const len = rng.int(8, 25);
      const steps = Math.round(sumAct(m, m + len) * rng.range(0.96, 1.04));
      if (steps > 0) {
        const s = dayStart + m * 60 + rng.int(0, 40);
        const e = dayStart + (m + len) * 60 - rng.int(0, 40);
        this.rec(`${Q}StepCount`, w, 'count', s, e, String(steps));
        this.rec(`${Q}DistanceWalkingRunning`, w, 'km', s, e, ((steps * 0.735) / 1000).toFixed(5));
        walkingSteps += steps;
      }
      m += len;
    }
    // phone: different interval boundaries, carried most of the time
    const carry = weekday ? 0.8 : 0.55;
    for (let m = 0; m < minutes;) {
      const len = rng.int(10, 30);
      const steps = Math.round(sumAct(m, m + len) * carry * rng.range(0.7, 1.1));
      if (steps > 0) {
        const s = dayStart + m * 60 + rng.int(0, 50);
        const e = dayStart + (m + len) * 60 - rng.int(0, 50);
        this.rec(`${Q}StepCount`, ph, 'count', s, e, String(steps));
        this.rec(`${Q}DistanceWalkingRunning`, ph, 'km', s, e, ((steps * 0.72) / 1000).toFixed(5));
      }
      m += len;
    }
    // heart rate in the background
    const step = this.cfg.bgHrMin * 60;
    for (let ts = dayStart + rng.range(0, step); ts < dayEnd; ts += step * rng.range(0.7, 1.3)) {
      const t = Math.round(ts);
      if (this.inWorkout(t, 30)) continue;
      const m = Math.floor((t - dayStart) / 60);
      let bpm: number;
      if (asleep(t)) bpm = rest - 4 + rng.normal(0, 2.5);
      else bpm = rest + 14 + 0.25 * (act[m] ?? 0) + rng.normal(0, 7);
      for (const [, e, avg] of this.windows)
        if (t > e && t - e < 1800) bpm += (avg - bpm) * Math.exp(-(t - e) / 420) * 0.8;
      const ctx = asleep(t) || rng.chance(0.2) ? '1' : '0';
      this.rec(
        `${Q}HeartRate`,
        w,
        'count/min',
        t,
        t,
        String(Math.round(clamp(bpm, 38, 175))),
        `  <MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="${ctx}"/>\n`,
        t + 120,
      );
    }
    // active & basal energy
    for (let ts = wake; ts < bed; ts += 600) {
      if (this.inWorkout(ts, 0)) continue;
      const m = Math.floor((ts - dayStart) / 60);
      const kcal = 2.4 + sumAct(m, m + 10) * 0.045 + rng.range(0, 1.2);
      this.rec(`${Q}ActiveEnergyBurned`, w, 'kcal', ts, ts + 600, f3(kcal));
      this.dayKcal += kcal;
    }
    const bmr = 10 * this.ath.mass(d) + 6.25 * HEIGHT_CM - 5 * 38 + 5;
    for (let ts = dayStart; ts < dayEnd; ts += 1800)
      this.rec(`${Q}BasalEnergyBurned`, w, 'kcal', ts, ts + 1800, f3((bmr / 48) * rng.range(0.98, 1.02)));
    // brisk walking counts as exercise
    for (let m = 0; m < minutes; m++) {
      if (act[m]! >= 95) {
        const ts = dayStart + m * 60;
        this.rec(`${Q}AppleExerciseTime`, w, 'min', ts, ts + 60, '1');
        this.dayExercise++;
      }
    }
    // stand hours & stand time
    let stood = 0;
    for (let h = Math.ceil((wake - dayStart) / 3600); h < Math.floor((bed - dayStart) / 3600); h++) {
      const s = dayStart + h * 3600;
      const ok = rng.chance(this.inWorkout(s + 1800, 0) ? 0.97 : 0.8);
      this.rec(
        `${C}AppleStandHour`,
        w,
        null,
        s,
        s + 3600,
        ok ? 'HKCategoryValueAppleStandHourStood' : 'HKCategoryValueAppleStandHourIdle',
      );
      if (ok) {
        stood++;
        const st = s + rng.int(60, 2400);
        this.rec(`${Q}AppleStandTime`, w, 'min', st, st + 300, String(rng.int(1, 6)));
      }
    }
    this.standHours = stood;
    // flights climbed (both devices)
    for (const src of [w, ph])
      for (let k = rng.int(0, 3); k > 0; k--) {
        const ts = rng.range(wake + 1800, bed - 1800);
        this.rec(`${Q}FlightsClimbed`, src, 'count', ts, ts + rng.int(30, 120), String(rng.int(1, 4)));
      }
    // time in daylight
    const m = this.month(d);
    const daylightHours = 12 + 4 * Math.sin(((m - 3.7) / 12) * 2 * Math.PI);
    for (let k = rng.int(2, 4 + Math.round(daylightHours / 3)); k > 0; k--) {
      const ts = viennaTs(d, rng.range(12 - daylightHours / 2 + 0.5, 12 + daylightHours / 2 - 0.5));
      this.rec(`${Q}TimeInDaylight`, w, 'min', ts, ts + 600, String(rng.int(1, 10)));
    }
    // noise
    for (let ts = wake + 900; ts < bed; ts += 1800) {
      if (rng.chance(0.15)) continue;
      this.rec(`${Q}EnvironmentalAudioExposure`, w, 'dBASPL', ts, ts + 1800, f1(rng.normal(57, 7)));
    }
    if (weekday)
      for (const h of [7.9, 17.4])
        if (rng.chance(0.6))
          this.rec(
            `${Q}HeadphoneAudioExposure`,
            ph,
            'dBASPL',
            viennaTs(d, h),
            viennaTs(d, h + 0.4),
            f1(rng.normal(68, 4)),
          );
    // walking metrics (phone)
    for (let k = rng.int(1, 4); k > 0; k--) {
      const ts = viennaTs(d, rng.range(8, 19));
      this.rec(`${Q}WalkingSpeed`, ph, 'km/hr', ts, ts + 60, f2(rng.normal(5.0, 0.25)));
      this.rec(`${Q}WalkingStepLength`, ph, 'cm', ts, ts + 60, f1(rng.normal(74, 1.5)));
      this.rec(
        `${Q}WalkingDoubleSupportPercentage`,
        ph,
        '%',
        ts,
        ts + 60,
        f3(clamp(rng.normal(0.29, 0.01), 0.2, 0.4)),
      );
    }
    void walkingSteps;
  }

  private standHours = 0;

  private sleep(i: number, d: number): void {
    const rng = this.rng;
    const w = this.watch(d);
    const ph = this.phone(d);
    const bed = i > 0 ? this.bedTs[i - 1]! : this.wakeTs[i]! - 8 * 3600;
    const wake = this.wakeTs[i]!;
    const tzMeta = '  <MetadataEntry key="HKTimeZone" value="Europe/Vienna"/>\n';
    this.rec(
      `${C}SleepAnalysis`,
      ph,
      null,
      bed - 300,
      wake + 180,
      'HKCategoryValueSleepAnalysisInBed',
      tzMeta,
      wake + 600,
    );
    let t = bed + rng.int(300, 1500);
    let cycle = 0;
    while (t < wake - 300) {
      const plan: [string, number][] = [
        ['AsleepCore', rng.range(20, 45)],
        ['AsleepDeep', cycle < 2 ? rng.range(15, 35) : rng.range(0, 12)],
        ['AsleepCore', rng.range(8, 20)],
        ['AsleepREM', cycle < 2 ? rng.range(8, 18) : rng.range(18, 35)],
      ];
      if (rng.chance(0.4)) plan.push(['Awake', rng.range(1, 6)]);
      for (const [stage, min] of plan) {
        if (min < 1) continue;
        const e = Math.min(wake, t + min * 60);
        if (e - t < 60) break;
        this.rec(
          `${C}SleepAnalysis`,
          w,
          null,
          t,
          e,
          `HKCategoryValueSleepAnalysis${stage}`,
          tzMeta,
          wake + 900,
        );
        t = e;
        if (t >= wake - 60) break;
      }
      cycle++;
    }
    const onset = bed + 900;
    for (let ts = onset + rng.int(600, 2400); ts < wake - 600; ts += rng.int(3000, 4800))
      this.rec(`${Q}OxygenSaturation`, w, '%', ts, ts, f2(clamp(rng.normal(0.965, 0.012), 0.9, 1)));
    for (let ts = onset + rng.int(300, 1200); ts < wake - 600; ts += rng.int(1500, 2100))
      this.rec(`${Q}RespiratoryRate`, w, 'count/min', ts, ts + 60, f1(rng.normal(14.2, 0.8)));
    this.rec(
      `${Q}AppleSleepingWristTemperature`,
      w,
      'degC',
      onset,
      wake,
      f2(rng.normal(36.05, 0.18)),
      tzMeta,
      wake + 1800,
    );
    // HRV with the beat-to-beat list
    const times = [onset + rng.int(3600, 10800), viennaTs(d, rng.range(9, 20))];
    for (const ts of times) {
      const sdnn = clamp(rng.normal(36 + 24 * this.fitness(d), 7), 12, 120);
      const n = rng.int(40, 70);
      let beats = '  <HeartRateVariabilityMetadataList>\n';
      let bt = 0;
      const hr0 = this.ath.rest(d) + 4;
      for (let k = 0; k < n; k++) {
        const bpm = Math.round(hr0 + rng.normal(0, 4));
        const local = new Date((ts + bt + viennaTz(ts) * 60) * 1000);
        const hh = local.getUTCHours();
        beats += `   <InstantaneousBeatsPerMinute bpm="${bpm}" time="${hh}:${P2[local.getUTCMinutes()]}:${P2[local.getUTCSeconds()]},${P2[Math.floor((bt % 1) * 100)]}"/>\n`;
        bt += 60 / bpm;
      }
      beats += '  </HeartRateVariabilityMetadataList>\n';
      this.rec(
        `${Q}HeartRateVariabilitySDNN`,
        w,
        'ms',
        ts,
        Math.round(ts + bt),
        f3(sdnn),
        beats,
        Math.round(ts + bt) + 300,
      );
    }
  }

  private daily(i: number, d: number): void {
    const rng = this.rng;
    const w = this.watch(d);
    const p = i / this.days;
    const rest = this.ath.rest(d);
    const s = viennaTs(d, 0.02);
    const e = viennaTs(d, 23.9);
    this.rec(
      `${Q}RestingHeartRate`,
      w,
      'count/min',
      s,
      e,
      String(Math.round(rest + rng.normal(0, 1.4))),
      '',
      e + 1800,
    );
    this.rec(
      `${Q}WalkingHeartRateAverage`,
      w,
      'count/min',
      viennaTs(d, 8),
      viennaTs(d, 20),
      String(Math.round(rest + 37 + rng.normal(0, 3))),
      '',
      e + 1800,
    );
    const dow = this.dow(d);
    // body: smart scale 2–3 times a week
    if (
      (dow === 0 || dow === 3 || (dow === 5 && rng.chance(0.5))) &&
      !(i >= this.tripStart && i <= this.tripEnd)
    ) {
      const ts = viennaTs(d, 7.1 + rng.range(0, 0.3));
      const scale: Source = { name: 'Withings', version: '7.4.1', device: null };
      const mass = this.ath.mass(d);
      this.rec(`${Q}BodyMass`, scale, 'kg', ts, ts, f1(mass));
      this.rec(
        `${Q}BodyFatPercentage`,
        scale,
        '%',
        ts,
        ts,
        f3(clamp(0.215 - 0.035 * this.fitness(d) + rng.normal(0, 0.004), 0.1, 0.3)),
      );
      this.rec(`${Q}BodyMassIndex`, scale, 'count', ts, ts, f1(mass / (HEIGHT_CM / 100) ** 2));
    }
    // mindfulness twice a week
    if ((dow === 1 || dow === 6) && rng.chance(0.7)) {
      const ts = viennaTs(d, 21.3 + rng.range(0, 0.4));
      this.rec(`${C}MindfulSession`, w, null, ts, ts + rng.int(5, 12) * 60, 'HKCategoryValueNotApplicable');
    }
    // blood pressure once a month (correlation + top-level records)
    if (i % 30 === 7) {
      const ts = viennaTs(d, 19.2);
      const omron: Source = { name: 'Omron Connect', version: '7.13.0', device: null };
      const sys = Math.round(rng.normal(126 - 6 * this.fitness(d), 5));
      const dia = Math.round(rng.normal(81 - 3 * this.fitness(d), 4));
      const recX = (type: string, v: number) =>
        `  <Record type="${Q}${type}" sourceName="${omron.name}" sourceVersion="${omron.version}" unit="mmHg" creationDate="${fmt(ts + 20)}" startDate="${fmt(ts)}" endDate="${fmt(ts)}" value="${v}"/>\n`;
      this.correlations.push(
        ` <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="${omron.name}" sourceVersion="${omron.version}" creationDate="${fmt(ts + 20)}" startDate="${fmt(ts)}" endDate="${fmt(ts)}">\n` +
          `  <MetadataEntry key="HKWasUserEntered" value="0"/>\n${recX('BloodPressureDiastolic', dia)}${recX('BloodPressureSystolic', sys)} </Correlation>\n`,
      );
      this.rec(`${Q}BloodPressureDiastolic`, omron, 'mmHg', ts, ts, String(dia), '', ts + 20);
      this.rec(`${Q}BloodPressureSystolic`, omron, 'mmHg', ts, ts, String(sys), '', ts + 20);
    }
    // audiogram once
    if (i === Math.floor(this.days * 0.5)) {
      const ts = viennaTs(d, 18);
      const pts = [250, 500, 1000, 2000, 4000, 8000]
        .map((f) => {
          const loss = (f >= 4000 ? 15 : 5) + rng.int(0, 10);
          return `  <SensitivityPoint frequencyValue="${f}" frequencyUnit="Hz" leftEarValue="${loss}" leftEarUnit="dBHL" leftEarMasked="false" rightEarValue="${loss + rng.int(-5, 5)}" rightEarUnit="dBHL" rightEarMasked="false"/>\n`;
        })
        .join('');
      this.extra.push(
        ` <Audiogram type="HKDataTypeIdentifierAudiogram" sourceName="Mimi Hörtest" sourceVersion="6.2.0" creationDate="${fmt(ts + 60)}" startDate="${fmt(ts)}" endDate="${fmt(ts + 420)}">\n  <MetadataEntry key="HKMetadataKeyAudiogramTestType" value="1"/>\n${pts} </Audiogram>\n`,
      );
    }
    // ECG recordings
    for (const [frac, lang] of [
      [0.22, 'en'],
      [0.52, 'de'],
      [0.81, 'de'],
    ] as const) {
      if (i === Math.floor(this.days * frac)) this.ecg(d, lang);
    }
    // activity rings
    const goal = p < 0.4 ? 500 : p < 0.75 ? 550 : 600;
    this.summaries.push(
      ` <ActivitySummary dateComponents="${dayString(d)}" activeEnergyBurned="${this.dayKcal.toFixed(3)}" activeEnergyBurnedGoal="${goal}" activeEnergyBurnedUnit="kcal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="${this.dayExercise}" appleExerciseTimeGoal="30" appleStandHours="${this.standHours}" appleStandHoursGoal="12"/>\n`,
    );
  }

  private ecg(d: number, lang: 'de' | 'en'): void {
    const rng = this.rng;
    const ts = viennaTs(d, 20.5);
    const hr = this.ath.rest(d) + 8 + rng.normal(0, 3);
    const rate = 512;
    const n = rate * 30;
    const period = 60 / hr;
    const g = (x: number, mu: number, sd: number, a: number) =>
      a * Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
    const lines: string[] = [];
    const tz = viennaTz(ts) === 120 ? '+0200' : '+0100';
    const date = fmt(ts);
    if (lang === 'de')
      lines.push(
        `Name,${OWNER} Beispiel`,
        'Geburtsdatum,12.04.1988',
        `Aufnahmedatum,${date}`,
        'Klassifizierung,Sinusrhythmus',
        'Symptome,',
        'Softwareversion,2',
        'Gerät,"Watch7,2"',
        'Abtastrate,512 Hertz',
        'Ableitung,Ableitung I',
        'Einheit,µV',
        '',
        '',
      );
    else
      lines.push(
        `Name,${OWNER} Example`,
        'Date of Birth,"Apr 12, 1988"',
        `Recorded Date,${date}`,
        'Classification,Sinus Rhythm',
        'Symptoms,',
        'Software Version,2',
        'Device,"Watch6,2"',
        'Sample Rate,512 hertz',
        'Lead,Lead I',
        'Unit,µV',
        '',
        '',
      );
    let wander = 0;
    for (let k = 0; k < n; k++) {
      const t = k / rate;
      const ph = (t % period) - 0.25;
      wander = 0.999 * wander + rng.normal(0, 0.6);
      const v =
        g(ph, -0.2, 0.025, 120) +
        g(ph, -0.03, 0.009, -110) +
        g(ph, 0, 0.011, 1150) +
        g(ph, 0.032, 0.01, -260) +
        g(ph, 0.27, 0.045, 310) +
        35 * Math.sin(2 * Math.PI * 0.3 * t) +
        wander +
        rng.normal(0, 6);
      lines.push(v.toFixed(3));
    }
    let file = `ecg_${dayString(d)}.csv`;
    for (let k = 1; this.ecgFiles.includes(file); k++) file = `ecg_${dayString(d)}_${k}.csv`;
    fs.writeFileSync(
      path.join(this.tmp, 'apple_health_export', 'electrocardiograms', file),
      lines.join('\n') + '\n',
    );
    this.ecgFiles.push(file);
    void tz;
  }

  // -------------------------------------------------------------------------

  /** Assemble export.xml (Apple's element order) and return its size. */
  assemble(endDay: number): {
    xml: string;
    bytes: number;
    routes: string[];
    ecgs: string[];
    records: number;
    workouts: number;
  } {
    const typeFiles = this.sink.finish();
    fs.closeSync(this.workoutsFd);
    const xmlPath = path.join(this.tmp, 'apple_health_export', 'export.xml');
    const fd = fs.openSync(xmlPath, 'w');
    const exportTs = viennaTs(endDay, 21.5);
    fs.writeSync(fd, `<?xml version="1.0" encoding="UTF-8"?>\n${DOCTYPE}<HealthData locale="de_AT">\n`);
    fs.writeSync(fd, ` <ExportDate value="${fmt(exportTs)}"/>\n`);
    fs.writeSync(
      fd,
      ' <Me HKCharacteristicTypeIdentifierDateOfBirth="1988-04-12" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeAPositive" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeIII" HKCharacteristicTypeIdentifierCardioFitnessMedicationsUse="None"/>\n',
    );
    const copy = (file: string) => {
      const buf = Buffer.alloc(1 << 22);
      const src = fs.openSync(file, 'r');
      let n: number;
      while ((n = fs.readSync(src, buf, 0, buf.length, null)) > 0) fs.writeSync(fd, buf, 0, n);
      fs.closeSync(src);
    };
    for (const f of typeFiles) copy(f);
    fs.writeSync(fd, this.correlations.join(''));
    copy(path.join(this.tmp, 'workouts.xml'));
    fs.writeSync(fd, this.summaries.join(''));
    fs.writeSync(fd, this.extra.join(''));
    fs.writeSync(fd, '</HealthData>\n');
    fs.closeSync(fd);
    fs.rmSync(path.join(this.tmp, 'types'), { recursive: true, force: true });
    fs.rmSync(path.join(this.tmp, 'workouts.xml'), { force: true });
    fs.writeFileSync(path.join(this.tmp, 'apple_health_export', 'export_cda.xml'), CDA(fmt(exportTs)));
    return {
      xml: xmlPath,
      bytes: fs.statSync(xmlPath).size,
      routes: this.routeFiles,
      ecgs: this.ecgFiles,
      records: this.sink.count,
      workouts: this.workouts,
    };
  }
}

// An Apple-style DTD internal subset, including a duplicated declaration like the malformed DTDs some iOS
// versions shipped (strict validating parsers reject it; the importer skips the subset entirely).
const DOCTYPE = `<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData
  locale CDATA #REQUIRED
>
<!ELEMENT ExportDate EMPTY>
<!ATTLIST ExportDate
  value CDATA #REQUIRED
>
<!ELEMENT Me EMPTY>
<!ATTLIST Me
  HKCharacteristicTypeIdentifierDateOfBirth                 CDATA #REQUIRED
  HKCharacteristicTypeIdentifierBiologicalSex               CDATA #REQUIRED
  HKCharacteristicTypeIdentifierBloodType                   CDATA #REQUIRED
  HKCharacteristicTypeIdentifierFitzpatrickSkinType         CDATA #REQUIRED
  HKCharacteristicTypeIdentifierCardioFitnessMedicationsUse CDATA #REQUIRED
>
<!ELEMENT Record ((MetadataEntry|HeartRateVariabilityMetadataList)*)>
<!ATTLIST Record
  type          CDATA #REQUIRED
  unit          CDATA #IMPLIED
  value         CDATA #IMPLIED
  sourceName    CDATA #REQUIRED
  sourceVersion CDATA #IMPLIED
  device        CDATA #IMPLIED
  creationDate  CDATA #IMPLIED
  startDate     CDATA #REQUIRED
  endDate       CDATA #REQUIRED
>
<!-- Note: Any Records that appear as children of a correlation also appear as top-level records in this document. -->
<!ELEMENT Correlation ((MetadataEntry|Record)*)>
<!ATTLIST Correlation
  type          CDATA #REQUIRED
  sourceName    CDATA #REQUIRED
  sourceVersion CDATA #IMPLIED
  device        CDATA #IMPLIED
  creationDate  CDATA #IMPLIED
  startDate     CDATA #REQUIRED
  endDate       CDATA #REQUIRED
>
<!ELEMENT Correlation ((MetadataEntry|Record)*)>
<!ELEMENT Workout ((MetadataEntry|WorkoutEvent|WorkoutRoute|WorkoutStatistics|WorkoutActivity)*)>
<!ATTLIST Workout
  workoutActivityType   CDATA #REQUIRED
  duration              CDATA #IMPLIED
  durationUnit          CDATA #IMPLIED
  totalDistance         CDATA #IMPLIED
  totalDistanceUnit     CDATA #IMPLIED
  totalEnergyBurned     CDATA #IMPLIED
  totalEnergyBurnedUnit CDATA #IMPLIED
  sourceName            CDATA #REQUIRED
  sourceVersion         CDATA #IMPLIED
  device                CDATA #IMPLIED
  creationDate          CDATA #IMPLIED
  startDate             CDATA #REQUIRED
  endDate               CDATA #REQUIRED
>
<!ELEMENT WorkoutActivity ((MetadataEntry|WorkoutEvent|WorkoutStatistics)*)>
<!ATTLIST WorkoutActivity
  uuid          CDATA #REQUIRED
  startDate     CDATA #REQUIRED
  endDate       CDATA #IMPLIED
  duration      CDATA #IMPLIED
  durationUnit  CDATA #IMPLIED
>
<!ELEMENT WorkoutEvent (MetadataEntry?)>
<!ATTLIST WorkoutEvent
  type          CDATA #REQUIRED
  date          CDATA #REQUIRED
  duration      CDATA #IMPLIED
  durationUnit  CDATA #IMPLIED
>
<!ELEMENT WorkoutStatistics EMPTY>
<!ATTLIST WorkoutStatistics
  type          CDATA #REQUIRED
  startDate     CDATA #REQUIRED
  endDate       CDATA #REQUIRED
  average       CDATA #IMPLIED
  minimum       CDATA #IMPLIED
  maximum       CDATA #IMPLIED
  sum           CDATA #IMPLIED
  unit          CDATA #IMPLIED
>
<!ELEMENT WorkoutRoute ((MetadataEntry|FileReference)*)>
<!ATTLIST WorkoutRoute
  sourceName    CDATA #REQUIRED
  sourceVersion CDATA #IMPLIED
  device        CDATA #IMPLIED
  creationDate  CDATA #IMPLIED
  startDate     CDATA #REQUIRED
  endDate       CDATA #REQUIRED
>
<!ELEMENT FileReference EMPTY>
<!ATTLIST FileReference
  path CDATA #REQUIRED
>
<!ELEMENT ActivitySummary EMPTY>
<!ATTLIST ActivitySummary
  dateComponents           CDATA #IMPLIED
  activeEnergyBurned       CDATA #IMPLIED
  activeEnergyBurnedGoal   CDATA #IMPLIED
  activeEnergyBurnedUnit   CDATA #IMPLIED
  appleMoveTime            CDATA #IMPLIED
  appleMoveTimeGoal        CDATA #IMPLIED
  appleExerciseTime        CDATA #IMPLIED
  appleExerciseTimeGoal    CDATA #IMPLIED
  appleStandHours          CDATA #IMPLIED
  appleStandHoursGoal      CDATA #IMPLIED
>
<!ELEMENT MetadataEntry EMPTY>
<!ATTLIST MetadataEntry
  key   CDATA #REQUIRED
  value CDATA #REQUIRED
>
<!ELEMENT HeartRateVariabilityMetadataList (InstantaneousBeatsPerMinute*)>
<!ELEMENT InstantaneousBeatsPerMinute EMPTY>
<!ATTLIST InstantaneousBeatsPerMinute
  bpm  CDATA #REQUIRED
  time CDATA #REQUIRED
>
<!ELEMENT Audiogram ((MetadataEntry|SensitivityPoint)*)>
<!ATTLIST Audiogram
  type          CDATA #REQUIRED
  sourceName    CDATA #REQUIRED
  sourceVersion CDATA #IMPLIED
  device        CDATA #IMPLIED
  creationDate  CDATA #IMPLIED
  startDate     CDATA #REQUIRED
  endDate       CDATA #REQUIRED
>
<!ELEMENT SensitivityPoint EMPTY>
<!ATTLIST SensitivityPoint
  frequencyValue   CDATA #REQUIRED
  frequencyUnit    CDATA #REQUIRED
  leftEarValue     CDATA #IMPLIED
  leftEarUnit      CDATA #IMPLIED
  leftEarMasked    CDATA #IMPLIED
  rightEarValue    CDATA #IMPLIED
  rightEarUnit     CDATA #IMPLIED
  rightEarMasked   CDATA #IMPLIED
>
]>
`;

const CDA = (exportDate: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <realmCode code="US"/>
 <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
 <templateId root="2.16.840.1.113883.10.20.22.1.2"/>
 <title>Health Data Export (sample)</title>
 <effectiveTime value="${exportDate.replace(/[-: ]/g, '').slice(0, 14)}"/>
</ClinicalDocument>
`;

function parseEnd(end: string | undefined): number {
  if (end) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
    if (!m) throw new Error(`--end must be YYYY-MM-DD, got ${end}`);
    return daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const now = new Date();
  return daysFromCivil(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export async function generateSample(o: SampleOptions): Promise<SampleResult> {
  const t0 = Date.now();
  const size = o.size ?? 'medium';
  const log = o.log ?? (() => {});
  const endDay = parseEnd(o.endDate);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-sample-'));
  try {
    const gen = new Generator(tmp, size, o.seed ?? 42, endDay);
    log(
      `Generating ${size} sample (${SIZES[size].days} days until ${dayString(endDay)}, seed ${o.seed ?? 42})`,
    );
    gen.run(log);
    const a = gen.assemble(endDay);
    log(
      `  export.xml ${(a.bytes / 1e6).toFixed(1)} MB, ${a.records.toLocaleString('en')} records, ${a.workouts} workouts, ${a.routes.length} routes; zipping…`,
    );
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    const zip = new yazl.ZipFile();
    const root = path.join(tmp, 'apple_health_export');
    zip.addFile(a.xml, 'apple_health_export/export.xml');
    zip.addFile(path.join(root, 'export_cda.xml'), 'apple_health_export/export_cda.xml');
    for (const f of a.routes)
      zip.addFile(path.join(root, 'workout-routes', f), `apple_health_export/workout-routes/${f}`);
    for (const f of a.ecgs)
      zip.addFile(path.join(root, 'electrocardiograms', f), `apple_health_export/electrocardiograms/${f}`);
    const tmpOut = `${o.out}.partial`;
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(tmpOut);
      zip.outputStream.pipe(ws).on('close', () => resolve());
      ws.on('error', reject);
      zip.end();
    });
    fs.renameSync(tmpOut, o.out);
    return {
      file: o.out,
      size,
      days: SIZES[size].days,
      firstDay: dayString(endDay - SIZES[size].days + 1),
      lastDay: dayString(endDay),
      records: a.records,
      workouts: a.workouts,
      routes: a.routes.length,
      ecgs: a.ecgs.length,
      xmlBytes: a.bytes,
      zipBytes: fs.statSync(o.out).size,
      ms: Date.now() - t0,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
