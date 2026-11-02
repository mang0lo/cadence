/**
 * Builds sleep "nights" from raw HKCategoryTypeIdentifierSleepAnalysis records.
 *
 * Input quirks handled here (see docs/APPLE_HEALTH.md):
 *  - several sources write the same night (Apple Watch with stages, iPhone with InBed only, third-party apps with a
 *    generic Asleep) → one source provides the sleep stages ("best staged source"), InBed intervals of all sources are
 *    merged and only widen the time in bed;
 *  - records of one source can overlap (Awake inside a generic Asleep, repeated samples) → resolved by priority;
 *  - before iOS 16 only InBed / Asleep exist, afterwards AsleepCore / AsleepDeep / AsleepREM / Awake;
 *  - a night crosses midnight: it belongs to the local day it ENDS on (like daily_metrics), naps are separate sessions;
 *  - every record has its own UTC offset: bedtime is shown in the offset at bedtime, wake time in the offset at
 *    waking (DST changes, travel); durations are absolute seconds.
 *
 * Pure functions, no database access (see sleep.ts for the derive step).
 */
import { SLEEP_STAGE_CODES, type SleepStage } from '@cadence/shared';
import { localDay } from '../../lib/time';

export interface RawSleepRecord {
  startTs: number;
  endTs: number;
  tzMin: number;
  /** Category value without prefix: InBed, Asleep, AsleepCore, AsleepDeep, AsleepREM, Awake. */
  text: string;
  sourceId: number;
  sourceName?: string | null;
}

export interface BuiltSleep {
  /** Local day of waking up. */
  day: string;
  kind: 'night' | 'nap';
  bedTs: number;
  wakeTs: number;
  tzBedMin: number;
  tzWakeMin: number;
  onsetTs: number | null;
  finalTs: number | null;
  inBedS: number;
  asleepS: number;
  coreS: number;
  deepS: number;
  remS: number;
  unspecS: number;
  awakeS: number;
  awakenings: number;
  latencyS: number | null;
  efficiency: number | null;
  staged: boolean;
  source: string | null;
  /** Contiguous stage segments covering [bedTs, wakeTs]: [offsetS from bedTs, durationS, stage code]. */
  segments: [number, number, number][];
}

type RecordStage = 'inbed' | SleepStage;

/** Gap between two sleep samples that starts a new session. */
export const SESSION_GAP_S = 2 * 3600;
/** Records longer than this are data errors. */
const MAX_RECORD_S = 24 * 3600;
/** Awake runs shorter than this inside the night are not counted as awakenings. */
const MIN_AWAKENING_S = 60;

export function classifySleepText(text: string): RecordStage | null {
  const t = text.replace(/^HKCategoryValueSleepAnalysis/, '');
  switch (t) {
    case 'InBed':
      return 'inbed';
    case 'Asleep':
    case 'AsleepUnspecified':
      return 'asleep';
    case 'AsleepCore':
      return 'core';
    case 'AsleepDeep':
      return 'deep';
    case 'AsleepREM':
      return 'rem';
    case 'Awake':
      return 'awake';
    default:
      return null;
  }
}

interface Rec {
  s: number;
  e: number;
  tz: number;
  stage: RecordStage;
  sourceId: number;
  sourceName: string;
}

interface Iv {
  s: number;
  e: number;
}

interface Seg extends Iv {
  stage: SleepStage;
}

/** Merge overlapping / touching intervals (input need not be sorted). */
export function mergeIntervals(ivs: Iv[]): Iv[] {
  const sorted = [...ivs].sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Iv[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.s <= last.e) last.e = Math.max(last.e, iv.e);
    else out.push({ s: iv.s, e: iv.e });
  }
  return out;
}

export const unionLength = (ivs: Iv[]): number => mergeIntervals(ivs).reduce((n, iv) => n + (iv.e - iv.s), 0);

/** Higher wins when two records of the same source overlap. */
const PRIORITY: Record<SleepStage, number> = { awake: 3, deep: 2, rem: 2, core: 2, asleep: 1 };

/**
 * Overlapping intervals of ONE source → non-overlapping labelled segments. Awake carves out of any sleep, a stage
 * beats a generic Asleep; among equals the later-starting (more specific) record wins.
 */
export function resolveSegments(ivs: Seg[]): Seg[] {
  if (!ivs.length) return [];
  const cuts = [...new Set(ivs.flatMap((iv) => [iv.s, iv.e]))].sort((a, b) => a - b);
  const out: Seg[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k]!;
    const b = cuts[k + 1]!;
    let win: Seg | null = null;
    for (const iv of ivs) {
      if (iv.s > a || iv.e < b) continue;
      if (
        !win ||
        PRIORITY[iv.stage] > PRIORITY[win.stage] ||
        (PRIORITY[iv.stage] === PRIORITY[win.stage] && iv.s > win.s)
      )
        win = iv;
    }
    if (!win) continue;
    const last = out[out.length - 1];
    if (last && last.stage === win.stage && last.e === a) last.e = b;
    else out.push({ s: a, e: b, stage: win.stage });
  }
  return out;
}

const isApple = (name: string) => /watch|apple/i.test(name);

interface SourceStat {
  sourceId: number;
  name: string;
  staged: boolean;
  asleepS: number;
  recs: Rec[];
}

/** Best source for the sleep stages of one session: staged beats generic, then coverage, then Apple Watch. */
function pickSource(recs: Rec[]): SourceStat | null {
  const by = new Map<number, Rec[]>();
  for (const r of recs) {
    if (r.stage === 'inbed') continue;
    const arr = by.get(r.sourceId);
    if (arr) arr.push(r);
    else by.set(r.sourceId, [r]);
  }
  const stats: SourceStat[] = [];
  for (const [sourceId, rs] of by) {
    const sleepIvs = rs.filter((r) => r.stage !== 'awake');
    const asleepS = unionLength(sleepIvs);
    if (asleepS <= 0) continue;
    stats.push({
      sourceId,
      name: rs[0]!.sourceName,
      staged: rs.some((r) => r.stage === 'core' || r.stage === 'deep' || r.stage === 'rem'),
      asleepS,
      recs: rs,
    });
  }
  let best: SourceStat | null = null;
  for (const c of stats) {
    if (!best) {
      best = c;
      continue;
    }
    if (c.staged !== best.staged) {
      if (c.staged) best = c;
      continue;
    }
    const hi = Math.max(c.asleepS, best.asleepS);
    if (Math.abs(c.asleepS - best.asleepS) > 0.1 * hi) {
      if (c.asleepS > best.asleepS) best = c;
      continue;
    }
    // about the same coverage: Apple Watch first, then the source that was seen first
    const ca = isApple(c.name);
    const ba = isApple(best.name);
    if (ca !== ba) {
      if (ca) best = c;
      continue;
    }
    if (c.sourceId < best.sourceId) best = c;
  }
  return best;
}

/** One session (records within SESSION_GAP_S of each other) → night, or null for noise. */
function assemble(recs: Rec[]): Omit<BuiltSleep, 'kind'> | null {
  const primary = pickSource(recs);
  const sleepSegs = primary
    ? resolveSegments(primary.recs.map((r) => ({ s: r.s, e: r.e, stage: r.stage as SleepStage })))
    : [];
  const inBed = mergeIntervals(recs.filter((r) => r.stage === 'inbed'));
  const hasInBed = inBed.length > 0;

  let bed = Infinity;
  let wake = -Infinity;
  for (const s of sleepSegs) {
    bed = Math.min(bed, s.s);
    wake = Math.max(wake, s.e);
  }
  for (const iv of inBed) {
    bed = Math.min(bed, iv.s);
    wake = Math.max(wake, iv.e);
  }
  if (!Number.isFinite(bed) || !Number.isFinite(wake) || wake <= bed) return null;

  // contiguous timeline over [bed, wake]; uncovered time is awake (in bed, no sleep detected)
  const timeline: Seg[] = [];
  const push = (s: number, e: number, stage: SleepStage) => {
    if (e <= s) return;
    const last = timeline[timeline.length - 1];
    if (last && last.stage === stage && last.e === s) last.e = e;
    else timeline.push({ s, e, stage });
  };
  let t = bed;
  for (const seg of sleepSegs) {
    push(t, seg.s, 'awake');
    push(Math.max(seg.s, t), seg.e, seg.stage);
    t = Math.max(t, seg.e);
  }
  push(t, wake, 'awake');

  const sum = (stage: SleepStage) =>
    timeline.reduce((n, seg) => (seg.stage === stage ? n + (seg.e - seg.s) : n), 0);
  const coreS = sum('core');
  const deepS = sum('deep');
  const remS = sum('rem');
  const unspecS = sum('asleep');
  const asleepS = coreS + deepS + remS + unspecS;
  const inBedS = wake - bed;

  // noise filter: a few minutes of sleep and no real time in bed
  if (asleepS < 600 && inBedS < 1800) return null;

  const asleepSegs = timeline.filter((s) => s.stage !== 'awake');
  const onset = asleepSegs.length ? asleepSegs[0]!.s : null;
  const final = asleepSegs.length ? asleepSegs[asleepSegs.length - 1]!.e : null;
  let awakenings = 0;
  if (onset !== null && final !== null) {
    for (const seg of timeline) {
      if (seg.stage === 'awake' && seg.s >= onset && seg.e <= final && seg.e - seg.s >= MIN_AWAKENING_S) awakenings++;
    }
  }

  // UTC offset at the first sample and at the last sample end
  let first = recs[0]!;
  let last = recs[0]!;
  for (const r of recs) {
    if (r.s < first.s) first = r;
    if (r.e > last.e) last = r;
  }
  const tzWake = last.tz;
  return {
    day: localDay(wake, tzWake),
    bedTs: bed,
    wakeTs: wake,
    tzBedMin: first.tz,
    tzWakeMin: tzWake,
    onsetTs: onset,
    finalTs: final,
    inBedS,
    asleepS,
    coreS,
    deepS,
    remS,
    unspecS,
    awakeS: inBedS - asleepS,
    awakenings,
    latencyS: hasInBed && onset !== null ? Math.max(0, onset - bed) : null,
    efficiency: inBedS > 0 ? asleepS / inBedS : null,
    staged: coreS + deepS + remS > 0,
    source: primary?.name ?? null,
    segments: timeline.map((seg) => [seg.s - bed, seg.e - seg.s, SLEEP_STAGE_CODES.indexOf(seg.stage)]),
  };
}

/** Local hour (0..23.99) of a timestamp at offset tzMin. */
function localHour(ts: number, tzMin: number): number {
  const sec = (((ts + tzMin * 60) % 86400) + 86400) % 86400;
  return sec / 3600;
}

/**
 * Per wake-up day the longest sleep is the night, everything else a nap; a lone short daytime sleep
 * (< 90 min asleep, falling asleep between 09:00 and 20:00) is a nap as well.
 */
function assignKinds(sessions: Omit<BuiltSleep, 'kind'>[]): BuiltSleep[] {
  const byDay = new Map<string, Omit<BuiltSleep, 'kind'>[]>();
  for (const s of sessions) {
    const arr = byDay.get(s.day);
    if (arr) arr.push(s);
    else byDay.set(s.day, [s]);
  }
  const out: BuiltSleep[] = [];
  for (const arr of byDay.values()) {
    let main = arr[0]!;
    for (const s of arr) {
      if (s.asleepS > main.asleepS || (s.asleepS === main.asleepS && s.inBedS > main.inBedS)) main = s;
    }
    for (const s of arr) {
      let kind: BuiltSleep['kind'] = s === main ? 'night' : 'nap';
      if (kind === 'night' && arr.length === 1) {
        const h = localHour(s.bedTs, s.tzBedMin);
        if (s.asleepS < 90 * 60 && h >= 9 && h < 20) kind = 'nap';
      }
      out.push({ ...s, kind });
    }
  }
  return out.sort((a, b) => a.bedTs - b.bedTs);
}

/** All sleep sessions in `records` as nights / naps, ordered by bedtime. */
export function buildSleepNights(records: RawSleepRecord[], opts: { gapS?: number } = {}): BuiltSleep[] {
  const gapS = opts.gapS ?? SESSION_GAP_S;
  const recs: Rec[] = [];
  for (const r of records) {
    const stage = classifySleepText(r.text);
    if (!stage) continue;
    if (!(r.endTs > r.startTs) || r.endTs - r.startTs > MAX_RECORD_S) continue;
    recs.push({
      s: r.startTs,
      e: r.endTs,
      tz: r.tzMin,
      stage,
      sourceId: r.sourceId,
      sourceName: r.sourceName ?? `source ${r.sourceId}`,
    });
  }
  recs.sort((a, b) => a.s - b.s || a.e - b.e);

  const sessions: Rec[][] = [];
  let cur: Rec[] = [];
  let curEnd = -Infinity;
  for (const r of recs) {
    if (cur.length && r.s - curEnd > gapS) {
      sessions.push(cur);
      cur = [];
      curEnd = -Infinity;
    }
    cur.push(r);
    curEnd = Math.max(curEnd, r.e);
  }
  if (cur.length) sessions.push(cur);

  const built: Omit<BuiltSleep, 'kind'>[] = [];
  for (const s of sessions) {
    const night = assemble(s);
    if (night) built.push(night);
  }
  return assignKinds(built);
}
