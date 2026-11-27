import { canonicalUnit, normalizeUnit, type ImportStats } from '@cadence/shared';
import { get, prepare, run, tx, type Db, type SqlValue } from '../db/db';
import { fnv1a } from '../lib/hash';
import { tzOffsetMinutes } from '../lib/tz';
import { lastTz, parseAppleDate, parseAppleDateFast } from './dates';
import { deviceKey, deviceLabel, parseDevice } from './device';
import { aggregationOf, categoryText, num, recordKind, type RecordKind } from './hk';
import {
  metadataOf,
  nodeToJson,
  recordMetaOf,
  type HealthSink,
  type RecordMeta,
  type XmlNode,
} from './parser';
import { ChangeScope, notePending } from './scope';
import type { Track } from './track';
import { WarningCollector } from './warnings';
import { parseWorkout, type ParsedWorkout } from './workout';
import type { XmlAttrs } from './xml';

interface TypeInfo {
  id: number;
  identifier: string;
  kind: RecordKind;
  /** Raw unit of the first record (fast path when the next record has the same unit). */
  rawUnit: string | null;
  canonical: string | null;
  /** Affine conversion raw → canonical (all of Apple's unit conversions are affine). */
  a: number;
  b: number;
  conv: boolean;
}

export interface RouteRef {
  workoutId: number;
  path: string;
}

const COLS = 12;
const MULTI = 64;
const RECORD_COLS =
  'athlete_id, type_id, start_ts, hash, end_ts, tz_min, value, text, source_id, device_id, created_ts, meta';
const MULTI_SQL = `INSERT OR IGNORE INTO records (${RECORD_COLS}) VALUES ${Array(MULTI)
  .fill(`(${Array(COLS).fill('?').join(',')})`)
  .join(',')}`;
const SINGLE_SQL = `INSERT OR IGNORE INTO records (${RECORD_COLS}) VALUES (${Array(COLS).fill('?').join(',')})`;

/** Flush thresholds: keep each write transaction short so the HTTP server's own writes never wait long. */
const MAX_PENDING_RECORDS = 40_000;
const MAX_PENDING_OTHER = 400;

const flat = (s: string) => (' ' + s).slice(1);

const BLOOD_TYPES: Record<string, string> = {
  APositive: 'A+',
  ANegative: 'A-',
  BPositive: 'B+',
  BNegative: 'B-',
  ABPositive: 'AB+',
  ABNegative: 'AB-',
  OPositive: 'O+',
  ONegative: 'O-',
};

export function emptyStats(): ImportStats {
  return {
    bytesTotal: 0,
    bytesProcessed: 0,
    recordsSeen: 0,
    recordsInserted: 0,
    workoutsSeen: 0,
    workoutsInserted: 0,
    routesParsed: 0,
    activitySummaries: 0,
    correlations: 0,
    ecgReadings: 0,
    otherItems: 0,
    recordTypes: 0,
    exportDate: null,
    locale: null,
    warnings: [],
  };
}

/**
 * Receives parsed export.xml elements and writes them in large batches (one transaction per flush,
 * multi-row INSERT OR IGNORE, cached prepared statements). Re-importing a newer export only adds new rows:
 * records dedupe on (type, start, FNV-1a(end|source|value|text)), workouts on ext_key, correlations on
 * (type, start, end, source), ECGs on recorded time, everything else on a content hash.
 * What each flush changed is persisted as the athlete's pending derive scope in the same transaction.
 */
export class ImportWriter implements HealthSink {
  private types = new Map<string, TypeInfo>();
  private sources = new Map<string, number>();
  private devices = new Map<string, number>();
  private lastDeviceRaw = '';
  private lastDeviceId = 0;

  private recParams: SqlValue[] = new Array(MAX_PENDING_RECORDS * COLS + COLS * 1024);
  private recCount = 0;
  private chunk: SqlValue[] = new Array(MULTI * COLS);
  private workouts: ParsedWorkout[] = [];
  private correlations: XmlNode[] = [];
  private summaries: XmlAttrs[] = [];
  private items: XmlNode[] = [];
  private meNode: XmlAttrs | null = null;
  private warnedUnit = new Set<string>();
  /** Changes of the flush in progress. */
  private delta = new ChangeScope();
  /** Per record type id: latest start of the athlete's records before this import (null = none). */
  private lastBefore = new Map<number, number | null>();

  /** Workouts inserted by this import. */
  readonly newWorkoutIds = new Set<number>();
  /** FileReferences of every workout in the export (new and existing) for the routes phase. */
  readonly routeRefs: RouteRef[] = [];
  readonly inlineTracks: { workoutId: number; track: Track }[] = [];
  readonly clinicalRefs: { hash: number; path: string }[] = [];
  /** What this import changed so far (already persisted as pending derive scope). */
  readonly scope = new ChangeScope();
  readonly warnings: WarningCollector;

  constructor(
    private readonly db: Db,
    private readonly athleteId: number,
    readonly stats: ImportStats,
  ) {
    this.warnings = new WarningCollector(stats.warnings);
    for (const r of db.prepare('SELECT id, identifier, kind, unit FROM record_types').all() as {
      id: number;
      identifier: string;
      kind: RecordKind;
      unit: string | null;
    }[]) {
      this.types.set(r.identifier, {
        id: r.id,
        identifier: r.identifier,
        kind: r.kind,
        // fast path only for a canonical unit: a stored raw unit (e.g. one a newer version converts) goes through
        // typeFor with the first record, which sets up the conversion
        rawUnit: canonicalUnit(r.unit) === r.unit ? r.unit : '\0',
        canonical: r.unit,
        a: 1,
        b: 0,
        conv: false,
      });
    }
  }

  warn(msg: string, key = msg): void {
    this.warnings.add(msg, key);
  }

  /** Summarise repeated warnings ("… (×1234)"). */
  finishWarnings(): void {
    this.stats.warnings = this.warnings.finish();
  }

  // ---------------------------------------------------------------------------
  // dictionaries
  // ---------------------------------------------------------------------------

  private typeFor(identifier: string, rawUnit: string | null): TypeInfo {
    let t = this.types.get(identifier);
    if (t && t.rawUnit === rawUnit) return t;
    if (!t) {
      const kind = recordKind(identifier);
      const canon = kind === 'category' ? null : canonicalUnit(rawUnit);
      const row = get<{ id: number; unit: string | null }>(
        this.db,
        `INSERT INTO record_types (identifier, kind, unit, aggregation) VALUES (?, ?, ?, ?)
         ON CONFLICT (identifier) DO UPDATE SET unit = COALESCE(record_types.unit, excluded.unit)
         RETURNING id, unit`,
        [identifier, kind, canon, aggregationOf(identifier, kind)],
      )!;
      t = {
        id: row.id,
        identifier: flat(identifier),
        kind,
        rawUnit,
        canonical: row.unit,
        a: 1,
        b: 0,
        conv: false,
      };
      this.types.set(t.identifier, t);
    } else if (t.canonical === null && t.kind !== 'category' && rawUnit) {
      t.canonical = canonicalUnit(rawUnit);
      run(this.db, 'UPDATE record_types SET unit = ? WHERE id = ? AND unit IS NULL', [t.canonical, t.id]);
    }
    // (re)compute the fast conversion for this raw unit
    const target = canonicalUnit(rawUnit);
    if (
      t.canonical !== null &&
      target !== null &&
      target !== t.canonical &&
      !this.warnedUnit.has(identifier)
    ) {
      this.warnedUnit.add(identifier);
      this.warn(`${identifier}: mixed units (${t.canonical} and ${rawUnit}); values kept as exported`);
    }
    const b = normalizeUnit(0, rawUnit).value;
    t.rawUnit = rawUnit;
    t.b = b;
    t.a = normalizeUnit(1, rawUnit).value - b;
    t.conv = !(t.a === 1 && t.b === 0);
    return t;
  }

  private sourceId(name: string): number {
    const hit = this.sources.get(name);
    if (hit !== undefined) return hit;
    const id = get<{ id: number }>(
      this.db,
      'INSERT INTO sources (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET name = excluded.name RETURNING id',
      [name],
    )!.id;
    this.sources.set(flat(name), id);
    return id;
  }

  private deviceId(raw: string): number {
    if (raw === this.lastDeviceRaw) return this.lastDeviceId;
    const key = deviceKey(raw);
    let id = this.devices.get(key);
    if (id === undefined) {
      const d = parseDevice(raw);
      id = get<{ id: number }>(
        this.db,
        `INSERT INTO devices (raw, name, manufacturer, model, hardware, software) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (raw) DO UPDATE SET raw = excluded.raw RETURNING id`,
        [d.key, d.name, d.manufacturer, d.model, d.hardware, d.software],
      )!.id;
      this.devices.set(flat(key), id);
    }
    this.lastDeviceRaw = flat(raw);
    this.lastDeviceId = id;
    return id;
  }

  private noteChange(ts: number): void {
    this.delta.noteDay(ts);
  }

  // ---------------------------------------------------------------------------
  // HealthSink
  // ---------------------------------------------------------------------------

  exportInfo(info: { locale?: string; exportDate?: string }): void {
    if (info.locale) this.stats.locale = info.locale;
    if (info.exportDate) this.stats.exportDate = info.exportDate;
  }

  me(attrs: XmlAttrs, node: XmlNode): void {
    this.meNode = attrs;
    this.items.push(node);
  }

  record(a: XmlAttrs, meta: RecordMeta | null): void {
    this.stats.recordsSeen++;
    const type = a.type;
    if (!type) {
      this.warn('Record without type attribute skipped');
      return;
    }
    const unit = a.unit ?? null;
    let t = this.types.get(type);
    if (t === undefined || t.rawUnit !== unit) t = this.typeFor(type, unit);

    const sd = a.startDate ?? '';
    let start = parseAppleDateFast(sd);
    let tz: number;
    if (start !== start) {
      const p = parseAppleDate(sd);
      if (!p) {
        this.warn(`Record with unparseable date skipped (${type})`, `bad-date:${type}`);
        return;
      }
      start = p.ts;
      tz = p.tzMin;
    } else tz = lastTz.tzMin;
    const ed = a.endDate;
    let end = start;
    if (ed !== undefined && ed !== sd) {
      end = parseAppleDateFast(ed);
      if (end !== end) end = parseAppleDate(ed)?.ts ?? start;
    }
    let created: number | null = null;
    const cd = a.creationDate;
    if (cd !== undefined) {
      created = parseAppleDateFast(cd);
      if (created !== created) created = parseAppleDate(cd)?.ts ?? null;
    }

    let value: number | null = null;
    let text: string | null = null;
    const raw = a.value;
    if (t.kind === 'category') {
      if (raw !== undefined) text = categoryText(type, raw);
    } else if (raw !== undefined && raw !== '') {
      const v = +raw;
      if (v - v === 0) value = t.conv ? t.a * v + t.b : v;
      else text = raw;
    }

    let metaJson: string | null = null;
    if (meta !== null) {
      const zone = meta.HKTimeZone;
      if (typeof zone === 'string') {
        const off = tzOffsetMinutes(zone, start);
        if (off !== null) tz = off;
      }
      // "0" = HKHeartRateMotionContextNotSet on every heart rate sample: dropping it saves ~50 bytes per row.
      if (meta.HKMetadataKeyHeartRateMotionContext === '0') delete meta.HKMetadataKeyHeartRateMotionContext;
      for (const _ in meta) {
        metaJson = JSON.stringify(meta);
        break;
      }
    }

    const src = a.sourceName ?? '';
    const sourceId = this.sourceId(src);
    const dev = a.device;
    const deviceId = dev ? this.deviceId(dev) : null;
    const hash = fnv1a(`${end}|${src}|${value === null ? '' : value.toPrecision(5)}|${text ?? ''}`);

    const p = this.recParams;
    let i = this.recCount * COLS;
    p[i++] = this.athleteId;
    p[i++] = t.id;
    p[i++] = start;
    p[i++] = hash;
    p[i++] = end;
    p[i++] = tz;
    p[i++] = value;
    p[i++] = text;
    p[i++] = sourceId;
    p[i++] = deviceId;
    p[i++] = created;
    p[i] = metaJson;
    this.recCount++;
  }

  correlation(node: XmlNode): void {
    this.correlations.push(node);
    // child records are regular records as well (Apple usually also lists them at top level → deduped)
    for (const c of node.children ?? []) if (c.name === 'Record') this.record(c.attrs, recordMetaOf(c));
  }

  workout(node: XmlNode): void {
    this.stats.workoutsSeen++;
    const w = parseWorkout(node);
    if (!w) {
      this.warn('Workout with unparseable dates skipped');
      return;
    }
    this.workouts.push(w);
  }

  activitySummary(attrs: XmlAttrs): void {
    this.summaries.push(attrs);
  }

  other(node: XmlNode): void {
    this.items.push(node);
  }

  // ---------------------------------------------------------------------------
  // flushing
  // ---------------------------------------------------------------------------

  get pending(): number {
    return (
      this.recCount +
      this.workouts.length +
      this.correlations.length +
      this.summaries.length +
      this.items.length
    );
  }

  shouldFlush(): boolean {
    return (
      this.recCount >= MAX_PENDING_RECORDS ||
      this.workouts.length + this.correlations.length + this.summaries.length + this.items.length >=
        MAX_PENDING_OTHER
    );
  }

  flush(): void {
    if (!this.pending && !this.meNode) return;
    const delta = (this.delta = new ChangeScope());
    tx(this.db, () => {
      this.flushRecords();
      this.flushCorrelations();
      this.flushWorkouts();
      this.flushSummaries();
      this.flushItems();
      this.flushMe();
      // what this flush changed commits together with the data (a cancelled import loses nothing to derive)
      notePending(this.db, this.athleteId, delta);
    });
    this.scope.merge(delta);
  }

  /** Latest start of a type's records stored before this import (looked up once per type, O(log n)). */
  private lastStartBefore(typeId: number): number | null {
    let t = this.lastBefore.get(typeId);
    if (t === undefined) {
      t =
        get<{ t: number }>(
          this.db,
          'SELECT start_ts AS t FROM records WHERE athlete_id = ? AND type_id = ? ORDER BY start_ts DESC LIMIT 1',
          [this.athleteId, typeId],
        )?.t ?? null;
      this.lastBefore.set(typeId, t);
    }
    return t;
  }

  /**
   * Multi-row inserts only take runs of one record type, and never mix rows from before and after the type's latest
   * stored record: INSERT OR IGNORE reports how many rows of a statement were new, not which, so a chunk spanning a
   * type boundary (or the end of what a re-imported export already brought) would mark the type as changed from its
   * oldest rows of the chunk on (export.xml lists each type's records in time order). Shorter runs go row by row,
   * which is exact.
   */
  private flushRecords(): void {
    const n = this.recCount;
    if (!n) return;
    const p = this.recParams;
    const multi = prepare(this.db, MULTI_SQL);
    const single = prepare(this.db, SINGLE_SQL);
    const chunk = this.chunk;
    const W = MULTI * COLS;
    let r = 0;
    while (r < n) {
      const type = p[r * COLS + 1] as number;
      const last = this.lastStartBefore(type) ?? -Infinity;
      const after = (p[r * COLS + 2] as number) > last;
      let end = r + 1;
      while (
        end < n &&
        end - r < MULTI &&
        p[end * COLS + 1] === type &&
        (p[end * COLS + 2] as number) > last === after
      )
        end++;
      if (end - r === MULTI) {
        const base = r * COLS;
        for (let j = 0; j < W; j++) chunk[j] = p[base + j]!;
        const changes = Number(multi.run(...chunk).changes);
        if (changes) this.noteRecords(r, end, changes);
      } else {
        for (let k = r; k < end; k++) {
          const b = k * COLS;
          const changes = Number(
            single.run(
              p[b]!,
              p[b + 1]!,
              p[b + 2]!,
              p[b + 3]!,
              p[b + 4]!,
              p[b + 5]!,
              p[b + 6]!,
              p[b + 7]!,
              p[b + 8]!,
              p[b + 9]!,
              p[b + 10]!,
              p[b + 11]!,
            ).changes,
          );
          if (changes) this.noteRecords(k, k + 1, changes);
        }
      }
      r = end;
    }
    // drop references to strings of the processed chunk
    p.fill(null, 0, n * COLS);
    this.recCount = 0;
  }

  /** Rows from..to (one record type) inserted `changes` new records: note the type from their earliest start. */
  private noteRecords(from: number, to: number, changes: number): void {
    this.stats.recordsInserted += changes;
    const p = this.recParams;
    let min = Infinity;
    for (let r = from; r < to; r++) {
      const ts = p[r * COLS + 2] as number;
      if (ts < min) min = ts;
    }
    this.delta.noteRecord(p[from * COLS + 1] as number, min);
  }

  private flushCorrelations(): void {
    if (!this.correlations.length) return;
    for (const node of this.correlations) {
      const a = node.attrs;
      const s = parseAppleDate(a.startDate);
      const e = parseAppleDate(a.endDate) ?? s;
      if (!s || !e) continue;
      const items = (node.children ?? [])
        .filter((c) => c.name === 'Record')
        .map((c) => {
          const v = num(c.attrs.value);
          const u = c.attrs.unit ?? null;
          const isNum = v !== null && !c.attrs.type?.startsWith('HKCategoryTypeIdentifier');
          const norm = isNum ? normalizeUnit(v, u) : null;
          return {
            type: c.attrs.type ?? '',
            value: norm ? norm.value : null,
            unit: norm ? norm.unit : u,
            text: isNum ? null : (c.attrs.value ?? null),
          };
        });
      const meta = metadataOf(node);
      const r = run(
        this.db,
        `INSERT OR IGNORE INTO correlations (athlete_id, type, start_ts, end_ts, tz_min, source_id, meta, items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.athleteId,
          a.type ?? 'unknown',
          s.ts,
          e.ts,
          s.tzMin,
          this.sourceId(a.sourceName ?? ''),
          Object.keys(meta).length ? JSON.stringify(meta) : null,
          JSON.stringify(items),
        ],
      );
      if (r.changes) {
        this.stats.correlations++;
        this.noteChange(s.ts);
      }
    }
    this.correlations = [];
  }

  private flushWorkouts(): void {
    if (!this.workouts.length) return;
    const ins = prepare(
      this.db,
      `INSERT OR IGNORE INTO workouts (
         athlete_id, ext_key, activity_type, sport, start_ts, end_ts, tz_min, timezone, duration_s,
         distance_m, energy_kcal, elevation_gain_m, elevation_loss_m, avg_hr, min_hr, max_hr, avg_speed,
         avg_cadence, avg_power, max_power, step_count, swim_strokes, lap_length_m, indoor,
         temperature_c, humidity_pct, source_name, source_version, device, meta, stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const find = prepare(this.db, 'SELECT id FROM workouts WHERE athlete_id = ? AND ext_key = ?');
    const insEvent = prepare(
      this.db,
      'INSERT OR IGNORE INTO workout_events (workout_id, idx, type, ts, duration_s, meta) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insAct = prepare(
      this.db,
      `INSERT OR IGNORE INTO workout_activities (workout_id, idx, activity_type, sport, start_ts, end_ts, duration_s, stats, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const w of this.workouts) {
      const s = w.summary;
      let device: string | null = null;
      if (w.deviceRaw) {
        const d = parseDevice(w.deviceRaw);
        device = deviceLabel(d);
      }
      const r = ins.run(
        this.athleteId,
        w.extKey,
        w.activityType,
        w.sport,
        w.startTs,
        w.endTs,
        w.tzMin,
        w.timezone,
        w.durationS,
        s.distanceM,
        s.energyKcal,
        w.elevationGainM,
        w.elevationLossM,
        s.avgHr,
        s.minHr,
        s.maxHr,
        s.avgSpeed,
        s.avgCadence,
        s.avgPower,
        s.maxPower,
        s.stepCount,
        s.swimStrokes,
        w.lapLengthM,
        w.indoor ? 1 : 0,
        w.temperatureC,
        w.humidityPct,
        w.sourceName,
        w.sourceVersion,
        device,
        Object.keys(w.meta).length ? JSON.stringify(w.meta) : null,
        JSON.stringify(w.stats),
      );
      let id: number;
      if (Number(r.changes)) {
        id = Number(r.lastInsertRowid);
        this.stats.workoutsInserted++;
        this.newWorkoutIds.add(id);
        this.delta.noteWorkout(id, w.startTs);
        w.events.forEach((e, idx) =>
          insEvent.run(id, idx, e.type, e.ts, e.durationS, e.meta ? JSON.stringify(e.meta) : null),
        );
        // iOS 16+ wraps every workout in one WorkoutActivity that just mirrors it: only multi-activity
        // workouts (or a differing type) are stored.
        const activities =
          w.activities.length === 1 && w.activities[0]!.activityType === w.activityType ? [] : w.activities;
        activities.forEach((act, idx) =>
          insAct.run(
            id,
            idx,
            act.activityType,
            act.sport,
            act.startTs,
            act.endTs,
            act.durationS,
            JSON.stringify(act.stats),
            Object.keys(act.meta).length ? JSON.stringify(act.meta) : null,
          ),
        );
      } else {
        const row = find.get(this.athleteId, w.extKey) as { id: number } | undefined;
        if (!row) continue;
        id = row.id;
      }
      for (const path of w.routeFiles) this.routeRefs.push({ workoutId: id, path });
      if (w.inlineTrack) this.inlineTracks.push({ workoutId: id, track: w.inlineTrack });
    }
    this.workouts = [];
  }

  private flushSummaries(): void {
    if (!this.summaries.length) return;
    const st = prepare(
      this.db,
      `INSERT INTO activity_summaries (athlete_id, day, active_energy_kcal, active_energy_goal_kcal, move_time_min,
         move_time_goal_min, exercise_min, exercise_goal_min, stand_hours, stand_goal_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (athlete_id, day) DO UPDATE SET
         active_energy_kcal = excluded.active_energy_kcal, active_energy_goal_kcal = excluded.active_energy_goal_kcal,
         move_time_min = excluded.move_time_min, move_time_goal_min = excluded.move_time_goal_min,
         exercise_min = excluded.exercise_min, exercise_goal_min = excluded.exercise_goal_min,
         stand_hours = excluded.stand_hours, stand_goal_hours = excluded.stand_goal_hours
       WHERE active_energy_kcal IS NOT excluded.active_energy_kcal OR active_energy_goal_kcal IS NOT excluded.active_energy_goal_kcal
          OR move_time_min IS NOT excluded.move_time_min OR move_time_goal_min IS NOT excluded.move_time_goal_min
          OR exercise_min IS NOT excluded.exercise_min OR exercise_goal_min IS NOT excluded.exercise_goal_min
          OR stand_hours IS NOT excluded.stand_hours OR stand_goal_hours IS NOT excluded.stand_goal_hours`,
    );
    for (const a of this.summaries) {
      const day = a.dateComponents;
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < '1990') continue;
      const eu = a.activeEnergyBurnedUnit ?? 'kcal';
      const energy = (v: string | undefined) => {
        const x = num(v);
        return x === null ? null : normalizeUnit(x, eu).value;
      };
      const r = st.run(
        this.athleteId,
        day,
        energy(a.activeEnergyBurned),
        energy(a.activeEnergyBurnedGoal),
        num(a.appleMoveTime),
        num(a.appleMoveTimeGoal),
        num(a.appleExerciseTime),
        num(a.appleExerciseTimeGoal),
        num(a.appleStandHours),
        num(a.appleStandHoursGoal),
      );
      if (Number(r.changes)) {
        this.stats.activitySummaries++;
        const [y, m, d] = day.split('-').map(Number) as [number, number, number];
        this.noteChange(Date.UTC(y, m - 1, d) / 1000);
      }
    }
    this.summaries = [];
  }

  private flushItems(): void {
    if (!this.items.length) return;
    const st = prepare(
      this.db,
      'INSERT OR IGNORE INTO health_items (athlete_id, kind, start_ts, hash, data) VALUES (?, ?, ?, ?, ?)',
    );
    for (const node of this.items) {
      const json = nodeToJson(node);
      const data = JSON.stringify({ attrs: json.attrs, children: json.children ?? [] });
      const hash = fnv1a(node.name + '|' + data);
      const a = node.attrs;
      const dateStr = a.startDate ?? a.date ?? a.dateIssued ?? a.receivedDate ?? a.value;
      const ts = dateStr ? (parseAppleDate(dateStr)?.ts ?? null) : null;
      const r = st.run(this.athleteId, node.name, ts, hash, data);
      if (Number(r.changes)) this.stats.otherItems++;
      if (node.name === 'ClinicalRecord' && a.resourceFilePath)
        this.clinicalRefs.push({ hash, path: a.resourceFilePath });
    }
    this.items = [];
  }

  private flushMe(): void {
    const a = this.meNode;
    if (!a) return;
    this.meNode = null;
    const strip = (v: string | undefined, prefix: string) => {
      if (!v) return null;
      const s = v.startsWith(prefix) ? v.slice(prefix.length) : v;
      return !s || s === 'NotSet' ? null : s;
    };
    const birth = a.HKCharacteristicTypeIdentifierDateOfBirth?.slice(0, 10) || null;
    const sexRaw = strip(a.HKCharacteristicTypeIdentifierBiologicalSex, 'HKBiologicalSex');
    const sex = sexRaw === 'Male' ? 'male' : sexRaw === 'Female' ? 'female' : sexRaw ? 'other' : null;
    const bloodRaw = strip(a.HKCharacteristicTypeIdentifierBloodType, 'HKBloodType');
    // own keys only: 'HKBloodTypeconstructor' must not reach Object's constructor
    const blood = bloodRaw ? (Object.hasOwn(BLOOD_TYPES, bloodRaw) ? BLOOD_TYPES[bloodRaw]! : bloodRaw) : null;
    const skin = strip(a.HKCharacteristicTypeIdentifierFitzpatrickSkinType, 'HKFitzpatrickSkinType');
    run(
      this.db,
      `UPDATE athletes SET birth_date = COALESCE(?, birth_date), sex = COALESCE(?, sex),
         blood_type = COALESCE(?, blood_type), skin_type = COALESCE(?, skin_type), updated_at = unixepoch()
       WHERE id = ?`,
      [birth && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : null, sex, blood, skin, this.athleteId],
    );
  }
}
