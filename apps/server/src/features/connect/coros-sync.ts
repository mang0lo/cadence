import fs from 'node:fs';
import path from 'node:path';
import type { ConnectSyncProgress, CorosRegion, CorosStatus } from '@cadence/shared';
import { getSetting, setSetting, updateSettings } from '../../core/settings';
import { addDays } from '../../lib/time';
import { get, run, type Db } from '../../db/db';
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

const PROVIDER = 'coros';
const SETTINGS_KEY = 'connect.coros';
/** Auto sync: shortly after the server starts, then every few hours. */
const AUTO_FIRST_MS = 90_000;
const AUTO_EVERY_MS = 3 * 3600_000;
/** Incremental sync stops after this many pages in a row without anything new. */
const KNOWN_PAGES_STOP = 1;

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
  return (e as Error)?.message ?? String(e);
}

export interface CorosSyncDeps {
  db: Db;
  jobs: Pick<JobManager, 'enqueueImport'>;
  dataDir: string;
  /** Test seam: fetch / sleep / spacing of the COROS client. */
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
    return new CorosClient({ region, accessToken, ...this.deps.client });
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

  private async sync(athleteId: number, p: ConnectSyncProgress): Promise<void> {
    const a = this.account(athleteId);
    if (!a) throw new Error('Not connected to COROS');
    const db = this.deps.db;
    const c = this.client(a.region, a.accessToken);
    let relogged = false;
    /** Run a call; when the token is no longer accepted, log in again once with the stored hash. */
    const call = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (!c.accessToken) {
        const l = await c.login(a.email, a.pwdMd5);
        this.save(athleteId, { accessToken: l.accessToken });
        relogged = true;
      }
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof CorosApiError) || relogged) throw e;
        relogged = true;
        let l;
        try {
          l = await c.login(a.email, a.pwdMd5);
        } catch (le) {
          throw le instanceof CorosApiError
            ? new Error(`COROS login failed (${le.message}) – connect the account again`)
            : le;
        }
        this.save(athleteId, { accessToken: l.accessToken });
        return fn();
      }
    };

    // ---- list (newest first) ----
    const state = new Map<string, string>();
    for (const r of db
      .prepare('SELECT remote_id, status FROM connect_activities WHERE athlete_id = ? AND provider = ?')
      .all(athleteId, PROVIDER) as { remote_id: string; status: string }[])
      state.set(r.remote_id, r.status);
    const todo: CorosActivity[] = [];
    let knownPages = 0;
    for (let page = 1; page <= 500; page++) {
      const res = await call(() => c.listActivities(page));
      const items = (res?.dataList ?? []).filter((x) => x && x.labelId);
      p.listed += items.length;
      let fresh = 0;
      for (const it of items) {
        const s = state.get(String(it.labelId));
        if (s === 'fetched' && !p.full) continue;
        if (s === 'failed' && !p.full) continue; // retried by a full sync
        fresh++;
        todo.push(it);
      }
      knownPages = fresh ? 0 : knownPages + 1;
      if (!items.length || page >= (res.totalPage ?? 0)) break;
      if (!p.full && knownPages >= KNOWN_PAGES_STOP) break;
    }
    p.toDownload = todo.length;

    // ---- download FIT files (oldest first, so an interrupted sync resumes in order) ----
    p.state = 'downloading';
    fs.mkdirSync(this.folder, { recursive: true });
    const upsert = db.prepare(
      `INSERT INTO connect_activities (athlete_id, provider, remote_id, start_ts, sport_type, name, device, file, status, error, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT (athlete_id, provider, remote_id) DO UPDATE SET start_ts = excluded.start_ts,
         sport_type = excluded.sport_type, name = excluded.name, device = excluded.device, file = excluded.file,
         status = excluded.status, error = excluded.error, fetched_at = excluded.fetched_at`,
    );
    const files: string[] = [];
    todo.sort((x, y) => (x.startTime ?? 0) - (y.startTime ?? 0));
    for (const it of todo) {
      const id = String(it.labelId).replace(/[^\w-]/g, '_');
      const file = path.join(this.folder, `${id}.fit`);
      const name = typeof it.name === 'string' ? it.name.trim() : '';
      const device = typeof it.device === 'string' ? it.device.trim() : '';
      const meta = [
        athleteId,
        PROVIDER,
        String(it.labelId),
        it.startTime ?? null,
        it.sportType ?? null,
        name || null,
        device || null,
      ] as const;
      try {
        const cached = fs.statSync(file, { throwIfNoEntry: false });
        if (!cached?.size || p.full) {
          const bytes = await call(() => c.downloadFit(String(it.labelId), Number(it.sportType ?? 100)));
          if (bytes.length < 12) throw new Error('COROS returned an empty FIT file');
          fs.writeFileSync(`${file}.part`, bytes);
          fs.renameSync(`${file}.part`, file);
        }
        fs.writeFileSync(
          `${file}.json`,
          JSON.stringify({ ...(name ? { name } : {}), ...(device ? { device } : {}) }),
        );
        upsert.run(...meta, file, 'fetched', null);
        files.push(file);
        p.downloaded++;
      } catch (e) {
        // rate limited even after the retries: stop here, the rest stays new for the next sync
        if (e instanceof CorosHttpError && (e.rateLimited || e.status === 0)) {
          if (files.length) this.enqueue(athleteId, files, p);
          throw e;
        }
        upsert.run(...meta, null, 'failed', errorText(e).slice(0, 500));
        p.failed++;
      }
    }

    // ---- import ----
    if (files.length) this.enqueue(athleteId, files, p);

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
      lastError:
        [p.failed ? `${p.failed} activities could not be downloaded` : null, healthError]
          .filter(Boolean)
          .join(' · ') || null,
    });
  }

  private async syncMobile(athleteId: number, a: CorosAccount, full: boolean) {
    const db = this.deps.db;
    const sleep = this.deps.client?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const gap = this.deps.client?.minIntervalMs ?? 800;
    const m = new CorosMobileClient({ region: a.region, token: a.mobileToken ?? null, fetch: this.deps.client?.fetch });
    let relogged = false;
    const login = async () => {
      relogged = true;
      try {
        const token = await m.login(a.email, a.pwdMd5);
        this.save(athleteId, { mobileToken: token });
      } catch (e) {
        throw e instanceof CorosApiError ? new Error(`COROS app login failed (${e.message})`) : e;
      }
    };
    const daily = async (dataType: number, start: number, end: number) => {
      if (!m.token) await login();
      await sleep(gap);
      try {
        return await m.daily(dataType, start, end);
      } catch (e) {
        // token expired or replaced by a login in the phone app: log in once more
        if (!(e instanceof CorosApiError) || relogged) throw e;
        await login();
        return m.daily(dataType, start, end);
      }
    };
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

  private enqueue(athleteId: number, files: string[], p: ConnectSyncProgress): void {
    const job = this.deps.jobs.enqueueImport(athleteId, this.folder, {
      sourceName: `COROS (${files.length} ${files.length === 1 ? 'activity' : 'activities'})`,
      sizeBytes: null,
      options: { origin: 'connect', deleteAfter: false, files },
    });
    p.jobId = job.id;
  }

  /** Auto sync for connected athletes that enabled it (desktop app and server alike). */
  startAuto(): void {
    const tick = () => {
      const rows = this.deps.db
        .prepare('SELECT athlete_id FROM settings WHERE key = ?')
        .all(SETTINGS_KEY) as { athlete_id: number }[];
      for (const r of rows) {
        const a = this.account(r.athlete_id);
        if (a?.autoSync && !this.isSyncing(r.athlete_id)) void this.start(r.athlete_id);
      }
    };
    const first = setTimeout(tick, AUTO_FIRST_MS);
    const every = setInterval(tick, AUTO_EVERY_MS);
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
