import { getSetting, setSetting } from '../core/settings';
import { all, run, tx, type Db } from '../db/db';
import { dayString } from '../lib/time';

/** Settings keys: changes no derive has taken over yet, and the changes of a derive that is running (or failed). */
const PENDING_KEY = 'core.pendingDerive';
const CLAIM_KEY = 'core.deriveClaim';

/** `typesFrom` value for "every record type, the whole history". */
const FROM_START = '0000-00-00';

/** Stored form of a ChangeScope (settings JSON). */
export interface ChangeScopeJson {
  all?: boolean;
  workouts?: number[];
  /** record type id → earliest start_ts */
  types?: Record<string, number>;
  typesFrom?: string;
  minTs?: number;
  minDay?: string;
}

/**
 * What changed and still has to be derived: the single source of truth for derive scopes.
 *
 * Importers note what they write (record types with their earliest start, workouts, days) and persist it as the
 * athlete's pending scope in the same transaction as the data (notePending), so a cancelled, failed or interrupted
 * job loses nothing. A derive takes the pending scope over (claimScope), and drops it only after it succeeded
 * (releaseClaim); a derive that did not finish leaves its claim to the next one (any job, or the one
 * JobManager.start queues).
 *
 * That includes a full rebuild caused by a change (another workout source in the settings, an update, a reset): when
 * it is cancelled or fails, the next job of the athlete (an import or a workout edit too) runs as a full rebuild, and
 * every server start queues one until a derive finishes. "Rebuild analysis" is a request, not a change: it is not
 * claimed (run-job.ts), so cancelling it really stops it. A core derive step that fails every time fails every later
 * job of the athlete as well, as each of them claims the same scope; feature steps only warn.
 */
export class ChangeScope {
  /** Everything (full rebuild of all derived data). */
  all = false;
  /** Workouts whose inputs changed: new, new route or sensor samples, edited sport, hidden … */
  readonly workouts = new Set<number>();
  /** Record type id → earliest start_ts of new or changed records. */
  readonly types = new Map<number, number>();
  /** Every record type from this local day on (rederive requests without a type list), FROM_START = all days. */
  typesFrom: string | null = null;
  /** Earliest timestamp (unix s) of any change: records, workouts, activity summaries, correlations. */
  minTs = Infinity;
  /** Earliest local day named explicitly (rederive requests, edited workouts). */
  minDay: string | null = null;

  noteRecord(typeId: number, ts: number): void {
    const cur = this.types.get(typeId);
    if (cur === undefined || ts < cur) this.types.set(typeId, ts);
    if (ts < this.minTs) this.minTs = ts;
  }

  /** A change at `ts` that only matters through the days it touches (activity summaries, correlations). */
  noteDay(ts: number): void {
    if (ts < this.minTs) this.minTs = ts;
  }

  /** A changed workout; `startTs` when known (otherwise the derive looks it up). */
  noteWorkout(id: number, startTs?: number): void {
    this.workouts.add(id);
    if (startTs !== undefined && startTs < this.minTs) this.minTs = startTs;
  }

  /** Every record type from `day` on (null = the whole history). */
  noteAllTypes(day: string | null): void {
    const d = day ?? FROM_START;
    if (this.typesFrom === null || d < this.typesFrom) this.typesFrom = d;
  }

  noteSinceDay(day: string): void {
    if (this.minDay === null || day < this.minDay) this.minDay = day;
  }

  merge(o: ChangeScope): this {
    if (o.all) this.all = true;
    for (const id of o.workouts) this.workouts.add(id);
    for (const [id, ts] of o.types) this.noteRecord(id, ts);
    if (o.typesFrom !== null) this.noteAllTypes(o.typesFrom === FROM_START ? null : o.typesFrom);
    if (o.minTs < this.minTs) this.minTs = o.minTs;
    if (o.minDay !== null) this.noteSinceDay(o.minDay);
    return this;
  }

  /** The part of this scope that `o` does not cover yet (to skip writes that would add nothing). */
  without(o: ChangeScope): ChangeScope {
    const s = new ChangeScope();
    if (o.all) return s;
    s.all = this.all;
    for (const id of this.workouts) if (!o.workouts.has(id)) s.workouts.add(id);
    for (const [id, ts] of this.types) if (ts < (o.types.get(id) ?? Infinity)) s.types.set(id, ts);
    if (this.typesFrom !== null && (o.typesFrom === null || this.typesFrom < o.typesFrom))
      s.typesFrom = this.typesFrom;
    if (this.minTs < o.minTs) s.minTs = this.minTs;
    if (this.minDay !== null && (o.minDay === null || this.minDay < o.minDay)) s.minDay = this.minDay;
    return s;
  }

  get empty(): boolean {
    return (
      !this.all &&
      !this.workouts.size &&
      !this.types.size &&
      this.typesFrom === null &&
      this.minTs === Infinity &&
      this.minDay === null
    );
  }

  /** ctx.workoutIds of the derive. */
  workoutIds(): number[] | 'all' {
    return this.all ? 'all' : [...this.workouts].sort((a, b) => a - b);
  }

  /**
   * ctx.sinceDay of the derive: the earliest day touched (one day of margin before the UTC day of a timestamp, as
   * local days can start earlier), null = everything, `fallback` when nothing day-related changed.
   * `workoutStartTs`: earliest start of the changed workouts whose start was not noted (e.g. a new route).
   */
  sinceDay(fallback: string, workoutStartTs: number | null = null): string | null {
    if (this.all) return null;
    let day: string | null = null;
    const take = (d: string) => {
      if (day === null || d < day) day = d;
    };
    if (this.typesFrom !== null) take(this.typesFrom);
    if (this.minDay !== null) take(this.minDay);
    const ts = Math.min(this.minTs, workoutStartTs ?? Infinity);
    if (Number.isFinite(ts)) take(dayString(Math.floor(ts / 86400) - 1));
    if (day === FROM_START) return null;
    return day ?? fallback;
  }

  /** Per record type the earliest changed start_ts; null = every type from sinceDay (or all of them). */
  typeSince(): Map<number, number> | null {
    return this.all || this.typesFrom !== null ? null : new Map(this.types);
  }

  toJSON(): ChangeScopeJson {
    const j: ChangeScopeJson = {};
    if (this.all) j.all = true;
    if (this.workouts.size) j.workouts = [...this.workouts].sort((a, b) => a - b);
    if (this.types.size) j.types = Object.fromEntries(this.types);
    if (this.typesFrom !== null) j.typesFrom = this.typesFrom;
    if (Number.isFinite(this.minTs)) j.minTs = this.minTs;
    if (this.minDay !== null) j.minDay = this.minDay;
    return j;
  }

  static fromJSON(j: ChangeScopeJson | null | undefined): ChangeScope {
    const s = new ChangeScope();
    if (!j || typeof j !== 'object') return s;
    s.all = j.all === true;
    for (const id of Array.isArray(j.workouts) ? j.workouts : []) if (Number.isInteger(id)) s.workouts.add(id);
    for (const [id, ts] of Object.entries(j.types ?? {}))
      if (Number.isFinite(Number(id)) && typeof ts === 'number') s.noteRecord(Number(id), ts);
    if (typeof j.typesFrom === 'string') s.typesFrom = j.typesFrom;
    if (typeof j.minTs === 'number') s.minTs = j.minTs;
    if (typeof j.minDay === 'string') s.minDay = j.minDay;
    return s;
  }
}

/** Rederive job options (import_jobs.options) as a scope. Missing workoutIds = everything (the default). */
export function scopeFromOptions(o: {
  workoutIds?: number[] | 'all';
  sinceDay?: string | null;
  records?: boolean;
}): ChangeScope {
  const s = new ChangeScope();
  const ids = o.workoutIds ?? 'all';
  if (ids === 'all') {
    s.all = true;
    return s;
  }
  for (const id of ids) s.workouts.add(id);
  if (o.sinceDay) s.noteSinceDay(o.sinceDay);
  // A subset rederive recomputes the daily metrics of every record type from sinceDay unless told otherwise.
  if (o.records !== false) s.noteAllTypes(o.sinceDay ?? null);
  return s;
}

function load(db: Db, athleteId: number, key: string): ChangeScope | null {
  const j = getSetting<ChangeScopeJson | null>(db, athleteId, key, null);
  return j ? ChangeScope.fromJSON(j) : null;
}

function save(db: Db, athleteId: number, key: string, scope: ChangeScope): void {
  if (scope.empty) run(db, 'DELETE FROM settings WHERE athlete_id = ? AND key = ?', [athleteId, key]);
  else setSetting(db, athleteId, key, scope.toJSON());
}

/**
 * Add `scope` to the athlete's pending changes. Call it inside the transaction that writes the data it describes,
 * so the data and the note commit (or roll back) together.
 */
export function notePending(db: Db, athleteId: number, scope: ChangeScope): void {
  if (scope.empty) return;
  tx(db, () => {
    const p = load(db, athleteId, PENDING_KEY) ?? new ChangeScope();
    save(db, athleteId, PENDING_KEY, p.merge(scope));
  });
}

/**
 * Start of a derive: take over every pending change, the changes of a derive that did not finish, and `extra`
 * (e.g. a rederive request). They stay claimed until releaseClaim, so a failed derive hands them on.
 */
export function claimScope(db: Db, athleteId: number, extra?: ChangeScope): ChangeScope {
  return tx(db, () => {
    const c = load(db, athleteId, CLAIM_KEY) ?? new ChangeScope();
    const p = load(db, athleteId, PENDING_KEY);
    if (p) c.merge(p);
    if (extra) c.merge(extra);
    save(db, athleteId, CLAIM_KEY, c);
    run(db, 'DELETE FROM settings WHERE athlete_id = ? AND key = ?', [athleteId, PENDING_KEY]);
    return c;
  });
}

/** After a successful derive: the claimed changes are derived. */
export function releaseClaim(db: Db, athleteId: number): void {
  run(db, 'DELETE FROM settings WHERE athlete_id = ? AND key = ?', [athleteId, CLAIM_KEY]);
}

/** Pending and claimed changes together (what the next derive would take over). */
export function pendingScope(db: Db, athleteId: number): ChangeScope {
  const s = load(db, athleteId, CLAIM_KEY) ?? new ChangeScope();
  const p = load(db, athleteId, PENDING_KEY);
  return p ? s.merge(p) : s;
}

/** Athletes with changes that no derive has finished yet (JobManager.start queues a derive for them). */
export function athletesWithPendingChanges(db: Db): number[] {
  return all<{ athlete_id: number }>(
    db,
    'SELECT DISTINCT athlete_id FROM settings WHERE key IN (?, ?) ORDER BY athlete_id',
    [PENDING_KEY, CLAIM_KEY],
  ).map((r) => r.athlete_id);
}

/** Forget every pending change (reset: the data they describe is gone). */
export function clearScopes(db: Db, athleteId: number): void {
  run(db, 'DELETE FROM settings WHERE athlete_id = ? AND key IN (?, ?)', [athleteId, PENDING_KEY, CLAIM_KEY]);
}
