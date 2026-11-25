import fs from 'node:fs';
import path from 'node:path';
import type { ConnectSyncProgress, CorosRegion, CorosStatus } from '@cadence/shared';
import { getSetting, setSetting, updateSettings } from '../../core/settings';
import { addDays } from '../../lib/time';
import { all, get, prepare, run, tx, type Db } from '../../db/db';
import { fitHeaderComplete } from '../../import/fit/parse';
import type { JobManager } from '../../import/jobs';
import {
  CorosApiError,
  CorosClient,
  CorosHttpError,
  md5Hex,
  type CorosActivity,
  type CorosClientOptions,
} from './coros-client';
import { syncCorosHealth, syncCorosMobile } from './coros-health';
import { CorosMobileClient } from './coros-mobile';
import { CorosLoginError, CorosSession, isAuthFailure } from './coros-session';

const PROVIDER = 'coros';
const SETTINGS_KEY = 'connect.coros';
/** Auto sync: shortly after the server starts, then every few hours. */
const AUTO_FIRST_MS = 90_000;
const AUTO_EVERY_MS = 3 * 3600_000;
/** Incremental sync stops after this many pages in a row without anything new. */
const KNOWN_PAGES_STOP = 1;
/** When normal syncs try a failed download again (after the 1st, 2nd … failure); then only a full sync does. */
const RETRY_AFTER_S = [3 * 3600, 12 * 3600, 86_400, 3 * 86_400, 7 * 86_400];
/** Import jobs a cached file goes into (failed or cancelled ones) before it counts as failed. */
const MAX_IMPORT_ATTEMPTS = 3;

/** Stored in settings (never sent to the browser): the token and the MD5 of the password COROS expects. */
interface CorosAccount {
  email: string;
  region: CorosRegion;
  /** md5(password) – what COROS' login takes; lets Cadence log in again when the token expires. */
  pwdMd5: string;
  accessToken: string | null;
  userId: string | null;
  nickname: string | null;
  connectedAt: number;
  autoSync: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  /** COROS refused the stored login (password changed …): auto sync waits until the account is connected again. */
  needsReconnect?: boolean;
  /** Newest day of health values fetched ('YYYY-MM-DD'); the next sync re-reads a few days before it. */
  healthDay?: string | null;
  /** Sleep, steps, calories and all-day HR from the COROS app API (its login can sign the phone app out). */
  mobileData?: boolean;
  /** Token of the COROS app API, reused until COROS rejects it. */
  mobileToken?: string | null;
  /** Newest day fetched from the COROS app API. */
  mobileDay?: string | null;
}

const now = () => Math.floor(Date.now() / 1000);

function errorText(e: unknown): string {
  if (e instanceof CorosHttpError && e.rateLimited)
    return 'COROS is rate limiting requests – try again in a few minutes';
  if (e instanceof CorosApiError && e.isAuth)
    return `COROS keeps rejecting the login (${e.message}) – the next sync continues`;
  return (e as Error)?.message ?? String(e);
}

/** A cached FIT file that arrived complete (fitHeaderComplete). */
function cachedFit(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(14);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return fitHeaderComplete(head.subarray(0, n), size);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

interface ActivityRow {
  remote_id: string;
  start_ts: number | null;
  sport_type: number | null;
  name: string | null;
  device: string | null;
}

/** An activity known from an earlier sync, as the download step takes it. */
const activityOf = (r: ActivityRow): CorosActivity => ({
  labelId: r.remote_id,
  sportType: r.sport_type ?? 100,
  ...(r.start_ts !== null ? { startTime: r.start_ts } : {}),
  name: r.name,
  ...(r.device ? { device: r.device } : {}),
});

export interface CorosSyncDeps {
  db: Db;
  jobs: Pick<JobManager, 'enqueueImport'>;
  dataDir: string;
  /** Test seam: fetch / sleep / spacing of the COROS clients. */
  client?: Partial<CorosClientOptions>;
}

/**
 * COROS connection of each athlete: login, account state and the sync (list → download FIT → import job).
 * Runs on the server's main thread (it is network bound); the import itself runs in the job worker.
 */
export class CorosSync {
  private progress = new Map<number, ConnectSyncProgress>();
  private running = new Map<number, Promise<ConnectSyncProgress>>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: CorosSyncDeps) {}

  get folder(): string {
    return path.join(this.deps.dataDir, 'connect', PROVIDER);
  }

  private account(athleteId: number): CorosAccount | null {
    return getSetting<CorosAccount | null>(this.deps.db, athleteId, SETTINGS_KEY, null);
  }

  private save(athleteId: number, patch: Partial<CorosAccount>): void {
    const cur = this.account(athleteId);
    if (cur) setSetting(this.deps.db, athleteId, SETTINGS_KEY, { ...cur, ...patch });
  }

  private client(region: CorosRegion, accessToken: string | null): CorosClient {
    return new CorosClient({ ...this.deps.client, region, accessToken });
  }

  status(athleteId: number): CorosStatus {
    const a = this.account(athleteId);
    const counts = get<{ fetched: number; failed: number; last: number | null }>(
      this.deps.db,
      `SELECT COUNT(*) FILTER (WHERE status = 'fetched') AS fetched, COUNT(*) FILTER (WHERE status = 'failed') AS failed,
         MAX(start_ts) FILTER (WHERE status = 'fetched') AS last
       FROM connect_activities WHERE athlete_id = ? AND provider = ?`,
      [athleteId, PROVIDER],
    )!;
    const health = get<{ days: number; first: string | null; last: string | null }>(
      this.deps.db,
      `SELECT COUNT(DISTINCT day) AS days, MIN(day) AS first, MAX(day) AS last FROM daily_metrics
       WHERE athlete_id = ? AND metric IN ('COROSRestingHeartRate', 'COROSSleepHRV', 'COROSBaseFitness')`,
      [athleteId],
    )!;
    return {
      connected: !!a,
      email: a?.email ?? null,
      region: a?.region ?? 'eu',
      nickname: a?.nickname ?? null,
      connectedAt: a?.connectedAt ?? null,
      autoSync: a?.autoSync ?? false,
      mobileData: a ? a.mobileData !== false : true,
      lastSyncAt: a?.lastSyncAt ?? null,
      lastError: a?.lastError ?? null,
      needsReconnect: !!a?.needsReconnect,
      activities: { fetched: counts.fetched, failed: counts.failed, lastStartTs: counts.last },
      health: { days: health.days, firstDay: health.first, lastDay: health.last },
      sync: this.progress.get(athleteId) ?? null,
    };
  }

  /** Log in with the user's credentials; throws CorosApiError for a wrong email / password. */
  async connect(
    athleteId: number,
    email: string,
    password: string,
    region: CorosRegion,
  ): Promise<CorosStatus> {
    const pwdMd5 = md5Hex(password);
    const c = this.client(region, null);
    const login = await c.login(email.trim(), pwdMd5);
    const prev = this.account(athleteId);
    const account: CorosAccount = {
      email: email.trim(),
      region,
      pwdMd5,
      accessToken: login.accessToken,
      userId: login.userId,
      nickname: login.nickname,
      connectedAt: now(),
      autoSync: prev?.autoSync ?? true,
      lastSyncAt: prev?.email === email.trim() ? prev.lastSyncAt : null,
      lastError: null,
      needsReconnect: false,
    };
    setSetting(this.deps.db, athleteId, SETTINGS_KEY, account);
    // first COROS connection and the athlete never chose a watch: COROS it is (Settings → My watch)
    const raw = getSetting<Record<string, unknown>>(this.deps.db, athleteId, 'core.settings', {});
    if (!('watch' in raw)) updateSettings(this.deps.db, athleteId, { watch: 'coros' });
    return this.status(athleteId);
  }

  disconnect(athleteId: number): void {
    run(this.deps.db, 'DELETE FROM settings WHERE athlete_id = ? AND key = ?', [athleteId, SETTINGS_KEY]);
  }

  setAutoSync(athleteId: number, autoSync: boolean): void {
    this.save(athleteId, { autoSync });
  }

  isSyncing(athleteId: number): boolean {
    return this.running.has(athleteId);
  }

  /** Start a sync in the background (no-op while one runs). Resolves with the final progress. */
  start(athleteId: number, full = false): Promise<ConnectSyncProgress> {
    const cur = this.running.get(athleteId);
    if (cur) return cur;
    const p: ConnectSyncProgress = {
      state: 'listing',
      startedAt: now(),
      finishedAt: null,
      full,
      listed: 0,
      toDownload: 0,
      downloaded: 0,
      failed: 0,
      jobId: null,
      healthDays: 0,
      sleepNights: 0,
      error: null,
    };
    this.progress.set(athleteId, p);
    const promise = this.sync(athleteId, p)
      .catch((e) => {
        p.state = 'failed';
        p.error = errorText(e);
        this.save(athleteId, { lastError: p.error });
      })
      .then(() => {
        p.finishedAt = now();
        this.running.delete(athleteId);
        return p;
      });
    this.running.set(athleteId, promise);
    return promise;
  }

  /**
   * Activities earlier syncs left unfinished. Fetched files whose import job failed or was cancelled, or that never
   * reached a job (the sync was cut off), go into this sync's job again – unless their workout exists after all;
   * after MAX_IMPORT_ATTEMPTS they count as failed. Failed downloads come back once their retry is due (a full sync
   * lists everything anyway).
   */
  private pending(athleteId: number, full: boolean): { files: Map<string, string>; retry: CorosActivity[] } {
    const db = this.deps.db;
    const files = new Map<string, string>();
    const retry: CorosActivity[] = [];
    const rows = all<ActivityRow & { file: string | null; import_attempts: number; job_error: string | null }>(
      db,
      `SELECT a.remote_id, a.start_ts, a.sport_type, a.name, a.device, a.file, a.import_attempts, j.error AS job_error
       FROM connect_activities a LEFT JOIN import_jobs j ON j.id = a.job_id
       WHERE a.athlete_id = ? AND a.provider = ? AND a.status = 'fetched'
         AND (a.job_id IS NULL OR j.status IN ('failed', 'cancelled'))`,
      [athleteId, PROVIDER],
    );
    if (rows.length) {
      // a cancelled or interrupted job keeps the workouts it wrote before it stopped
      const imported = this.importedFiles(athleteId);
      const done = prepare(
        db,
        "UPDATE connect_activities SET job_id = 'imported' WHERE athlete_id = ? AND provider = ? AND remote_id = ?",
      );
      const giveUp = prepare(
        db,
        `UPDATE connect_activities SET status = 'failed', error = ?, attempts = ?, next_retry_at = NULL
         WHERE athlete_id = ? AND provider = ? AND remote_id = ?`,
      );
      tx(db, () => {
        for (const r of rows) {
          if (r.file && imported.has(path.basename(r.file))) done.run(athleteId, PROVIDER, r.remote_id);
          else if (r.import_attempts >= MAX_IMPORT_ATTEMPTS) {
            const error = `Import did not finish${r.job_error ? `: ${r.job_error}` : ''}`.slice(0, 500);
            giveUp.run(error, RETRY_AFTER_S.length + 1, athleteId, PROVIDER, r.remote_id);
          } else if (r.file && cachedFit(r.file)) files.set(r.remote_id, r.file);
          else retry.push(activityOf(r)); // the cached file is gone: download it again
        }
      });
    }
    if (!full)
      for (const r of all<ActivityRow>(
        db,
        `SELECT remote_id, start_ts, sport_type, name, device FROM connect_activities
         WHERE athlete_id = ? AND provider = ? AND status = 'failed' AND next_retry_at <= ?`,
        [athleteId, PROVIDER, now()],
      ))
        retry.push(activityOf(r));
    return { files, retry };
  }

  /** Names of the cached files whose workout exists (a FIT workout keeps its file name in meta.FitFile). */
  private importedFiles(athleteId: number): Set<string> {
    return new Set(
      all<{ f: string }>(
        this.deps.db,
        `SELECT json_extract(meta, '$.FitFile') AS f FROM workouts
         WHERE athlete_id = ? AND ext_key LIKE 'fit:%' AND json_extract(meta, '$.FitFile') IS NOT NULL`,
        [athleteId],
      ).map((r) => r.f),
    );
  }

  private async sync(athleteId: number, p: ConnectSyncProgress): Promise<void> {
    const a = this.account(athleteId);
    if (!a) throw new Error('Not connected to COROS');
    const db = this.deps.db;
    const c = this.client(a.region, a.accessToken);
    // calls log in again (once per token) when COROS no longer takes the token, e.g. after a Training Hub login
    const session = new CorosSession({
      token: () => c.accessToken,
      login: async () => {
        let l;
        try {
          l = await c.login(a.email, a.pwdMd5);
        } catch (e) {
          if (!(e instanceof CorosApiError)) throw e;
          this.save(athleteId, { needsReconnect: true });
          throw new CorosLoginError(`COROS login failed (${e.message}) – connect the account again`);
        }
        this.save(athleteId, { accessToken: l.accessToken, needsReconnect: false });
      },
    });
    const call = <T>(fn: () => Promise<T>): Promise<T> => session.run(fn);

    const { files, retry } = this.pending(athleteId, p.full);

    // ---- list (newest first) ----
    const state = new Map<string, { status: string; attempts: number }>();
    for (const r of all<{ remote_id: string; status: string; attempts: number }>(
      db,
      'SELECT remote_id, status, attempts FROM connect_activities WHERE athlete_id = ? AND provider = ?',
      [athleteId, PROVIDER],
    ))
      state.set(r.remote_id, { status: r.status, attempts: r.attempts });
    const todo: CorosActivity[] = [];
    let knownPages = 0;
    for (let page = 1; page <= 500; page++) {
      const res = await call(() => c.listActivities(page));
      const items = (res?.dataList ?? []).filter((x) => x && x.labelId);
      p.listed += items.length;
      let fresh = 0;
      for (const it of items) {
        // known (fetched, or failed: retried when due) – a full sync takes everything again
        if (state.has(String(it.labelId)) && !p.full) continue;
        fresh++;
        todo.push(it);
      }
      knownPages = fresh ? 0 : knownPages + 1;
      if (!items.length || page >= (res.totalPage ?? 0)) break;
      if (!p.full && knownPages >= KNOWN_PAGES_STOP) break;
    }
    const listed = new Set(todo.map((it) => String(it.labelId)));
    for (const it of retry) if (!listed.has(String(it.labelId))) todo.push(it);
    p.toDownload = todo.length;

    // ---- download FIT files (oldest first, so an interrupted sync resumes in order) ----
    p.state = 'downloading';
    fs.mkdirSync(this.folder, { recursive: true });
    const fetched = prepare(
      db,
      `INSERT INTO connect_activities (athlete_id, provider, remote_id, start_ts, sport_type, name, device, file, status,
         error, fetched_at, attempts, next_retry_at, job_id, import_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fetched', NULL, unixepoch(), 0, NULL, ?, 0)
       ON CONFLICT (athlete_id, provider, remote_id) DO UPDATE SET start_ts = excluded.start_ts,
         sport_type = excluded.sport_type, name = excluded.name, device = excluded.device, file = excluded.file,
         status = 'fetched', error = NULL, fetched_at = excluded.fetched_at, attempts = 0, next_retry_at = NULL,
         job_id = excluded.job_id, import_attempts = 0`,
    );
    const failed = prepare(
      db,
      `INSERT INTO connect_activities (athlete_id, provider, remote_id, start_ts, sport_type, name, device, file, status,
         error, fetched_at, attempts, next_retry_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'failed', ?, unixepoch(), ?, ?)
       ON CONFLICT (athlete_id, provider, remote_id) DO UPDATE SET start_ts = excluded.start_ts,
         sport_type = excluded.sport_type, name = excluded.name, device = excluded.device, file = NULL,
         status = 'failed', error = excluded.error, fetched_at = excluded.fetched_at, attempts = excluded.attempts,
         next_retry_at = excluded.next_retry_at`,
    );
    // a full sync goes through every activity: a file whose workout exists needs no import (it would change nothing)
    const imported = p.full ? this.importedFiles(athleteId) : null;
    todo.sort((x, y) => (x.startTime ?? 0) - (y.startTime ?? 0));
    for (const it of todo) {
      const remoteId = String(it.labelId);
      const file = path.join(this.folder, `${remoteId.replace(/[^\w-]/g, '_')}.fit`);
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      const device = typeof it.device === 'string' ? it.device.trim() : '';
      const meta = [
        athleteId,
        PROVIDER,
        remoteId,
        it.startTime ?? null,
        it.sportType ?? null,
        name || null,
        device || null,
      ] as const;
      try {
        // a complete cached file is never downloaded again
        if (!cachedFit(file)) {
          const bytes = await call(() => c.downloadFit(remoteId, Number(it.sportType ?? 100)));
          if (bytes.length < 12) throw new Error('COROS returned an empty FIT file');
          if (!fitHeaderComplete(bytes, bytes.length)) throw new Error('COROS returned an incomplete FIT file');
          fs.writeFileSync(`${file}.part`, bytes);
          fs.renameSync(`${file}.part`, file);
        }
        fs.writeFileSync(
          `${file}.json`,
          JSON.stringify({ ...(name ? { name } : {}), ...(device ? { device } : {}) }),
        );
        const done = imported?.has(path.basename(file)) ?? false;
        fetched.run(...meta, file, done ? 'imported' : null);
        if (!done) files.set(remoteId, file);
        p.downloaded++;
      } catch (e) {
        // the login no longer works, rate limited even after the retries, or COROS cannot be reached: stop here,
        // the rest stays new for the next sync
        if (isAuthFailure(e) || (e instanceof CorosHttpError && (e.rateLimited || e.status === 0))) {
          if (files.size) this.enqueue(athleteId, files, p);
          throw e;
        }
        const prev = state.get(remoteId);
        const attempts = (prev?.status === 'failed' ? prev.attempts : 0) + 1;
        const wait = RETRY_AFTER_S[attempts - 1];
        failed.run(...meta, errorText(e).slice(0, 500), attempts, wait === undefined ? null : now() + wait);
        p.failed++;
      }
    }

    // ---- import ----
    if (files.size) this.enqueue(athleteId, files, p);

    // ---- daily health values (resting HR, HRV, training load …) ----
    p.state = 'health';
    let healthError: string | null = null;
    try {
      // full sync, first sync, or the data was deleted since ("Delete all data"): fetch the whole history
      const have = this.status(athleteId).health.days > 0;
      const since = p.full || !have ? null : (this.account(athleteId)?.healthDay ?? null);
      const getJson = <T>(path: string, query?: Record<string, string | number>) =>
        call(() => c.call<T>('GET', path, query));
      const h = await syncCorosHealth(db, athleteId, getJson, {
        sinceDay: since ? addDays(since, -7) : null,
      });
      p.healthDays = h.days;
      this.save(athleteId, { healthDay: h.lastDay });
    } catch (e) {
      if (e instanceof CorosHttpError && e.rateLimited) healthError = errorText(e);
      else healthError = `Health data: ${errorText(e)}`;
    }

    // ---- sleep, steps, calories, all-day heart rate (COROS app API) ----
    const acct = this.account(athleteId)!;
    if (acct.mobileData !== false) {
      try {
        const m = await this.syncMobile(athleteId, acct, p.full);
        p.healthDays = Math.max(p.healthDays, m.days);
        p.sleepNights = m.nights;
      } catch (e) {
        const msg = `Sleep & daily data: ${errorText(e)}`;
        healthError = healthError ? `${healthError} · ${msg}` : msg;
      }
    }

    p.state = 'done';
    this.save(athleteId, {
      lastSyncAt: now(),
      needsReconnect: false,
      lastError:
        [p.failed ? `${p.failed} activities could not be downloaded` : null, healthError]
          .filter(Boolean)
          .join(' · ') || null,
    });
  }

  private async syncMobile(athleteId: number, a: CorosAccount, full: boolean) {
    const db = this.deps.db;
    const m = new CorosMobileClient({ ...this.deps.client, region: a.region, token: a.mobileToken ?? null });
    // token expired or replaced by a login in the phone app: log in again (once per token)
    const session = new CorosSession({
      token: () => m.token,
      login: async () => {
        try {
          this.save(athleteId, { mobileToken: await m.login(a.email, a.pwdMd5) });
        } catch (e) {
          throw e instanceof CorosApiError ? new Error(`COROS app login failed (${e.message})`) : e;
        }
      },
    });
    const daily = (dataType: number, start: number, end: number) =>
      session.run(() => m.daily(dataType, start, end));
    const have = !!get(
      db,
      "SELECT 1 FROM daily_metrics WHERE athlete_id = ? AND metric = 'COROSSteps' LIMIT 1",
      [athleteId],
    );
    const since = full || !have ? null : (this.account(athleteId)?.mobileDay ?? null);
    const r = await syncCorosMobile(db, athleteId, daily, { sinceDay: since ? addDays(since, -3) : null });
    this.save(athleteId, { mobileDay: new Date().toISOString().slice(0, 10) });
    return r;
  }

  setMobileData(athleteId: number, on: boolean): void {
    this.save(athleteId, { mobileData: on });
  }

  /** One import job for the files (remote id → cached file); each row remembers the job, see pending(). */
  private enqueue(athleteId: number, files: Map<string, string>, p: ConnectSyncProgress): void {
    const list = [...files.values()];
    const job = this.deps.jobs.enqueueImport(athleteId, this.folder, {
      sourceName: `COROS (${list.length} ${list.length === 1 ? 'activity' : 'activities'})`,
      sizeBytes: null,
      options: { origin: 'connect', deleteAfter: false, files: list },
    });
    p.jobId = job.id;
    const mark = prepare(
      this.deps.db,
      `UPDATE connect_activities SET job_id = ?, import_attempts = import_attempts + 1
       WHERE athlete_id = ? AND provider = ? AND remote_id = ?`,
    );
    tx(this.deps.db, () => {
      for (const remoteId of files.keys()) mark.run(job.id, athleteId, PROVIDER, remoteId);
    });
  }

  /** One auto sync round: connected athletes with auto sync on, unless COROS refused their stored login. */
  autoTick(): void {
    const rows = this.deps.db
      .prepare('SELECT athlete_id FROM settings WHERE key = ?')
      .all(SETTINGS_KEY) as { athlete_id: number }[];
    for (const r of rows) {
      const a = this.account(r.athlete_id);
      if (a?.autoSync && !a.needsReconnect && !this.isSyncing(r.athlete_id)) void this.start(r.athlete_id);
    }
  }

  /** Auto sync for connected athletes that enabled it (desktop app and server alike). */
  startAuto(): void {
    const first = setTimeout(() => this.autoTick(), AUTO_FIRST_MS);
    const every = setInterval(() => this.autoTick(), AUTO_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  /** Stop the auto sync timers (a running sync is abandoned with the process). */
  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
