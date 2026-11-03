import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { getSettings, updateSettings } from '../src/core/settings';
import { heartMetric } from '../src/core/sources';
import { all, get, openDb, run, type Db } from '../src/db/db';
import { CorosClient, CorosHttpError, md5Hex } from '../src/features/connect/coros-client';
import { CorosSync } from '../src/features/connect/coros-sync';
import { executeJob } from '../src/import/run-job';
import { buildFit } from './fit-fixture';

const START = 1_780_000_000;
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-coros-'));
  db = openDb(path.join(dir, 'cadence.db'));
  migrateAll(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeActivity {
  labelId: string;
  sportType: number;
  startTime: number;
  name: string;
  device: string;
}

/** Health day as COROS reports it (happenDay YYYYMMDD). */
interface FakeDay {
  happenDay: number;
  rhr: number;
  avgSleepHrv?: number;
  sleepHrvBase?: number;
  ati: number;
  cti: number;
  tiredRate: number;
  trainingLoad: number;
  vo2max?: number;
}

const ymd = (day: string) => Number(day.replace(/-/g, ''));

/** Undo mobileEncrypt (AES-128-CBC with the appKey, then XOR with it). */
function decryptMobile(b64: string, appKey: string): string {
  const key = Buffer.from(appKey, 'ascii');
  const d = createDecipheriv('aes-128-cbc', key, Buffer.from('weloop3_2015_03#', 'ascii'));
  const x = Buffer.concat([d.update(Buffer.from(b64.trim(), 'base64')), d.final()]);
  return Buffer.from(x.map((b, i) => b ^ key[i % key.length]!)).toString('utf8');
}

/** In-memory COROS Training Hub API. */
function fakeCoros(activities: FakeActivity[], health: FakeDay[] = []) {
  const state = {
    analyseCalls: [] as [string, string][],
    mobileLogins: 0,
    mobileToken: '',
    mobileCalls: [] as number[],
    token: 'tok-1',
    logins: 0,
    downloads: [] as string[],
    queries: 0,
    rateLimitNext: 0,
    password: md5Hex('secret'),
  };
  const ok = (data: unknown) => new Response(JSON.stringify({ result: '0000', message: 'OK', data }));
  const fail = (result: string, message: string) => new Response(JSON.stringify({ result, message }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (state.rateLimitNext > 0) {
      state.rateLimitNext--;
      return new Response('<html>Too Many Requests</html>', { status: 429 });
    }
    if (url.hostname === 'apieu.coros.com') {
      if (url.pathname === '/coros/user/login') {
        const body = JSON.parse(String(init!.body));
        // the e-mail and password hash arrive encrypted with the request's appKey
        const plain = (v: string) => decryptMobile(v, body.appKey);
        if (plain(body.account) !== 'me@example.com' || plain(body.pwd) !== state.password)
          return fail('1030', 'Wrong password');
        state.mobileLogins++;
        state.mobileToken = `m-${state.mobileLogins}`;
        return ok({ accessToken: state.mobileToken });
      }
      if (url.pathname === '/coros/data/statistic/daily') {
        if (url.searchParams.get('accessToken') !== state.mobileToken) return fail('1019', 'Access token invalid');
        const body = JSON.parse(String(init!.body));
        state.mobileCalls.push(body.dataType[0]);
        const rows = health.filter((d) => d.happenDay >= body.startTime && d.happenDay <= body.endTime);
        const t = body.dataType[0];
        return ok({
          statisticData: {
            dayDataList: rows.map((d) => ({
              happenDay: d.happenDay,
              ...(t === 3 ? { step: 9000 } : {}),
              ...(t === 1 ? { calorie: 2_400_000 } : {}),
              ...(t === 2 ? { motionTime: 3600 } : {}),
              ...(t === 4 ? { heartRateData: { avgHeartRate: 70, minHeartRate: 45, maxHeartRate: 160 } } : {}),
              ...(t === 5
                ? {
                    sleepData: {
                      totalSleepTime: 420,
                      deepTime: 80,
                      lightTime: 250,
                      eyeTime: 90,
                      wakeTime: 15,
                      avgHeartRate: 52,
                      minHeartRate: 44,
                    },
                  }
                : {}),
            })),
          },
        });
      }
    }
    if (url.hostname === 'files.example') {
      const a = activities.find((x) => x.labelId === url.searchParams.get('id'))!;
      return new Response(buildFit({ start: a.startTime, serial: Number(a.labelId) }));
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    switch (url.pathname) {
      case '/account/login': {
        const body = JSON.parse(String(init!.body));
        if (body.pwd !== state.password || body.accountType !== 2) return fail('1030', 'Wrong password');
        state.logins++;
        state.token = `tok-${state.logins + 1}`;
        return ok({ accessToken: state.token, userId: '42', nickname: 'Runner' });
      }
      case '/activity/query': {
        if (headers.accessToken !== state.token) return fail('1019', 'Access token invalid');
        state.queries++;
        const page = Number(url.searchParams.get('pageNumber'));
        const size = Number(url.searchParams.get('size'));
        const sorted = [...activities].sort((a, b) => b.startTime - a.startTime);
        return ok({
          count: sorted.length,
          totalPage: Math.ceil(sorted.length / size),
          pageNumber: page,
          dataList: sorted.slice((page - 1) * size, page * size),
        });
      }
      case '/analyse/dayDetail/query': {
        if (headers.accessToken !== state.token) return fail('1019', 'Access token invalid');
        const from = Number(url.searchParams.get('startDay'));
        const to = Number(url.searchParams.get('endDay'));
        state.analyseCalls.push([String(from), String(to)]);
        // like COROS: the days of the range with their values (VO₂max only in the dashboard)
        const rows = health.filter((d) => d.happenDay >= from && d.happenDay <= to);
        return ok({ dayList: rows.map(({ vo2max: _v, ...d }) => d) });
      }
      case '/dashboard/detail/query': {
        if (headers.accessToken !== state.token) return fail('1019', 'Access token invalid');
        return ok({
          detailList: health
            .slice(-7)
            .map((d) => ({ happenDay: d.happenDay, vo2max: d.vo2max ?? 0, staminaLevel: 0 })),
        });
      }
      case '/activity/detail/download': {
        if (headers.accessToken !== state.token) return fail('1019', 'Access token invalid');
        expect(url.searchParams.get('fileType')).toBe('4');
        const id = url.searchParams.get('labelId')!;
        if (id === 'broken') return fail('5001', 'File not found');
        state.downloads.push(id);
        return ok({ fileUrl: `https://files.example/fit?id=${id}` });
      }
      default:
        return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
  return { state, fetchImpl };
}

function setup(activities: FakeActivity[], health: FakeDay[] = []) {
  const fake = fakeCoros(activities, health);
  const enqueued: { path: string; files: string[] }[] = [];
  const jobs = {
    enqueueImport(_a: number, p: string, o: { options?: { files?: string[] } } = {}) {
      enqueued.push({ path: p, files: o.options?.files ?? [] });
      return { id: `job-${enqueued.length}` } as never;
    },
  };
  const sync = new CorosSync({
    db,
    jobs,
    dataDir: dir,
    client: { fetch: fake.fetchImpl, sleep: async () => {}, minIntervalMs: 0 },
  });
  return { fake, sync, enqueued };
}

const act = (i: number, extra: Partial<FakeActivity> = {}): FakeActivity => ({
  labelId: String(1000 + i),
  sportType: 100,
  startTime: START + i * 86_400,
  name: `Run ${i}`,
  device: 'COROS PACE 3',
  ...extra,
});

describe('COROS client', () => {
  it('retries rate-limited requests with backoff', async () => {
    const { state, fetchImpl } = fakeCoros([act(1)]);
    const waits: number[] = [];
    const c = new CorosClient({
      region: 'eu',
      fetch: fetchImpl,
      minIntervalMs: 0,
      sleep: async (ms) => void waits.push(ms),
      retryDelaysMs: [10, 20],
    });
    state.rateLimitNext = 2;
    await c.login('me@example.com', md5Hex('secret'));
    expect(waits).toEqual([10, 20]);
    state.rateLimitNext = 3;
    await expect(c.listActivities(1)).rejects.toSatisfy((e) => e instanceof CorosHttpError && e.rateLimited);
  });

  it('talks to the regional host', () => {
    expect(new CorosClient({ region: 'eu' }).baseUrl).toBe('https://teameuapi.coros.com');
    expect(new CorosClient({ region: 'en' }).baseUrl).toBe('https://teamapi.coros.com');
  });
});

describe('COROS sync', () => {
  it('connects, never stores the password and rejects wrong credentials', async () => {
    const { sync } = setup([]);
    await expect(sync.connect(1, 'me@example.com', 'nope', 'eu')).rejects.toThrow(/Wrong password/);
    const s = await sync.connect(1, 'me@example.com', 'secret', 'eu');
    expect(s).toMatchObject({ connected: true, email: 'me@example.com', nickname: 'Runner', autoSync: true });
    const raw = get<{ value: string }>(db, "SELECT value FROM settings WHERE key = 'connect.coros'")!.value;
    expect(raw).not.toContain('secret');
    expect(JSON.stringify(s)).not.toContain(md5Hex('secret'));
  });

  it('downloads new activities, imports them, and only fetches new ones next time', async () => {
    const activities = Array.from({ length: 5 }, (_, i) => act(i));
    const { fake, sync, enqueued } = setup(activities);
    await sync.connect(1, 'me@example.com', 'secret', 'eu');

    const p = await sync.start(1);
    expect(p).toMatchObject({
      state: 'done',
      listed: 5,
      toDownload: 5,
      downloaded: 5,
      failed: 0,
      jobId: 'job-1',
    });
    expect(enqueued[0]!.files).toHaveLength(5);
    expect(enqueued[0]!.path).toBe(path.join(dir, 'connect', 'coros'));

    // the import job turns the files into workouts named like on COROS
    await executeJob(
      db,
      {
        id: 'j',
        kind: 'import',
        athleteId: 1,
        sourcePath: enqueued[0]!.path,
        options: { files: enqueued[0]!.files },
      },
      { progress: () => {}, checkCancelled: () => {}, log: () => {} },
    );
    const names = all<{ name: string; device: string }>(
      db,
      'SELECT name, device FROM workouts ORDER BY start_ts',
    );
    expect(names.map((n) => n.name)).toEqual(['Run 0', 'Run 1', 'Run 2', 'Run 3', 'Run 4']);
    expect(names[0]!.device).toBe('COROS PACE 3');

    // one new activity: only that one is downloaded
    activities.push(act(9));
    fake.state.downloads = [];
    const p2 = await sync.start(1);
    expect(p2).toMatchObject({ toDownload: 1, downloaded: 1 });
    expect(fake.state.downloads).toEqual(['1009']);
    expect(sync.status(1).activities).toMatchObject({ fetched: 6, failed: 0 });

    // nothing new: no import job
    const p3 = await sync.start(1);
    expect(p3).toMatchObject({ state: 'done', toDownload: 0, jobId: null });
  });

  it('logs in again when the token was invalidated (e.g. by a Training Hub login)', async () => {
    const { fake, sync } = setup([act(1)]);
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    fake.state.token = 'someone-else';
    const p = await sync.start(1);
    expect(p).toMatchObject({ downloaded: 1, error: null });
    expect(fake.state.logins).toBe(2);
  });

  it('records activities that cannot be downloaded and retries them on a full sync', async () => {
    const { sync } = setup([act(1), act(2, { labelId: 'broken' })]);
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    const p = await sync.start(1);
    expect(p).toMatchObject({ downloaded: 1, failed: 1 });
    expect(sync.status(1)).toMatchObject({
      activities: { fetched: 1, failed: 1 },
      lastError: '1 activities could not be downloaded',
    });
    const again = await sync.start(1);
    expect(again.toDownload).toBe(0);
    const full = await sync.start(1, true);
    expect(full.toDownload).toBe(2);
  });

  it('fails the sync with a clear message when the password changed', async () => {
    const { fake, sync } = setup([act(1)]);
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    fake.state.token = 'expired';
    fake.state.password = md5Hex('changed');
    const p = await sync.start(1);
    expect(p.state).toBe('failed');
    expect(p.error).toMatch(/connect the account again/);
    expect(sync.status(1).lastError).toMatch(/connect the account again/);
  });
});

/** `n` days of COROS health data ending on `last` (HRV only for the newest `hrvDays`). */
function healthDays(last: string, n: number, hrvDays = n): FakeDay[] {
  const out: FakeDay[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = new Date(Date.parse(`${last}T00:00:00Z`) - i * 86400_000).toISOString().slice(0, 10);
    out.push({
      happenDay: ymd(day),
      rhr: 48 + (i % 3),
      ...(i < hrvDays ? { avgSleepHrv: 110 + (i % 5), sleepHrvBase: 105 } : {}),
      ati: 40,
      cti: 30,
      tiredRate: 7,
      trainingLoad: i % 2 ? 0 : 80,
      ...(i < 7 ? { vo2max: 52 } : {}),
    });
  }
  return out;
}

describe('COROS health sync', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('fetches the whole history window by window, then only the recent days', async () => {
    const { fake, sync } = setup([], healthDays(today, 200, 30));
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    const p = await sync.start(1);
    expect(p).toMatchObject({ state: 'done', error: null, healthDays: 200 });
    // 24-week windows, walked back until two empty ones: 200 days → 2 windows with data + 2 empty ones
    expect(fake.state.analyseCalls).toHaveLength(4);
    const metric = (m: string) =>
      all<{ day: string; value: number }>(
        db,
        'SELECT day, value FROM daily_metrics WHERE metric = ? ORDER BY day',
        [m],
      );
    expect(metric('COROSRestingHeartRate')).toHaveLength(200);
    expect(metric('COROSSleepHRV')).toHaveLength(30);
    expect(metric('COROSSleepHRV').at(-1)).toEqual({ day: today, value: 110 });
    expect(metric('COROSTrainingLoad')).toHaveLength(100); // rest days (0) are no value
    expect(metric('COROSVO2Max')).toHaveLength(7);
    expect(sync.status(1).health).toMatchObject({ days: 200, lastDay: today });

    fake.state.analyseCalls = [];
    await sync.start(1);
    // incremental: one window reaching back a week before the last sync
    expect(fake.state.analyseCalls).toHaveLength(1);
    expect(metric('COROSRestingHeartRate')).toHaveLength(200);
  });

  it('makes COROS the watch on the first connection and reads its values for readiness', async () => {
    const { sync } = setup([], healthDays(today, 20));
    // Apple data exists too
    run(
      db,
      `INSERT INTO daily_metrics (athlete_id, metric, day, value, n) VALUES (1, 'HKQuantityTypeIdentifierRestingHeartRate', ?, 60, 1)`,
      [today],
    );
    expect(heartMetric(db, 1, 'restingHr')).toBe('HKQuantityTypeIdentifierRestingHeartRate');
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    expect(getSettings(db, 1).watch).toBe('coros');
    await sync.start(1);
    expect(heartMetric(db, 1, 'restingHr')).toBe('COROSRestingHeartRate');
    expect(heartMetric(db, 1, 'hrv')).toBe('COROSSleepHRV');
    // per type override back to Apple
    updateSettings(db, 1, { sources: { workouts: 'auto', heart: 'apple' } });
    expect(heartMetric(db, 1, 'restingHr')).toBe('HKQuantityTypeIdentifierRestingHeartRate');
    // Apple preferred but there is no Apple HRV: COROS' is used rather than nothing
    expect(heartMetric(db, 1, 'hrv')).toBe('COROSSleepHRV');
  });

  it('syncs sleep, steps and all-day heart rate from the COROS app API, logging in only once', async () => {
    const { fake, sync } = setup([], healthDays(today, 10));
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    const p = await sync.start(1);
    expect(p).toMatchObject({ state: 'done', error: null, sleepNights: 10 });
    expect(sync.status(1).lastError).toBeNull();
    expect(fake.state.mobileLogins).toBe(1);
    const nights = all<{ day: string; asleep_s: number; deep_s: number; rem_s: number; timed: number; source: string }>(
      db,
      "SELECT day, asleep_s, deep_s, rem_s, timed, source FROM health_sleep_nights WHERE kind = 'night' ORDER BY day",
    );
    expect(nights).toHaveLength(10);
    expect(nights.at(-1)).toEqual({ day: today, asleep_s: 420 * 60, deep_s: 80 * 60, rem_s: 90 * 60, timed: 0, source: 'COROS' });
    const hr = get<{ value: number; min: number; max: number }>(
      db,
      "SELECT value, min, max FROM daily_metrics WHERE metric = 'COROSHeartRate' AND day = ?",
      [today],
    );
    expect(hr).toEqual({ value: 70, min: 45, max: 160 });
    expect(heartMetric(db, 1, 'steps')).toBe('COROSSteps');
    // the next sync reuses the token
    await sync.start(1);
    expect(fake.state.mobileLogins).toBe(1);
    // the phone app logged in again → token rejected → one new login
    fake.state.mobileToken = 'phone';
    await sync.start(1);
    expect(fake.state.mobileLogins).toBe(2);
  });

  it('leaves the COROS app API alone when sleep & daily data is switched off', async () => {
    const { fake, sync } = setup([], healthDays(today, 5));
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    sync.setMobileData(1, false);
    await sync.start(1);
    expect(fake.state.mobileLogins).toBe(0);
    expect(sync.status(1).mobileData).toBe(false);
  });

  it('keeps an explicitly chosen watch when COROS is connected', async () => {
    const { sync } = setup([]);
    updateSettings(db, 1, { watch: 'apple' });
    await sync.connect(1, 'me@example.com', 'secret', 'eu');
    expect(getSettings(db, 1).watch).toBe('apple');
  });
});

describe('connect API', () => {
  it('reports the connection and validates requests', async () => {
    const { buildApp } = await import('../src/app');
    const { loadConfig } = await import('../src/config');
    const config = loadConfig({ CADENCE_DATA_DIR: dir, CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
    const app = await buildApp(config, db, { jobRunner: 'inline' });
    await app.ready();
    try {
      const s = await app.inject({ url: '/api/connect/coros' });
      expect(s.statusCode).toBe(200);
      expect(s.json()).toMatchObject({ connected: false, region: 'eu', activities: { fetched: 0 } });
      const bad = await app.inject({
        method: 'POST',
        url: '/api/connect/coros/login',
        payload: { email: 'me@example.com', password: 'x', region: 'mars' },
      });
      expect(bad.statusCode).toBe(400);
      const sync = await app.inject({ method: 'POST', url: '/api/connect/coros/sync', payload: {} });
      expect(sync.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
