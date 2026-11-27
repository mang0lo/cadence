import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ImportJob, ImportStatus } from '@cadence/shared';
import {
  currentJob,
  finishedSince,
  jobErrorText,
  jobPhaseLabel,
  jobSourceLabel,
  jobStepLabel,
  loadJobs,
  stepKey,
  uploadFailure,
  uploadQueue,
  waitingJobs,
  wantsFullList,
  type JobsIo,
} from '@/features/platform/importJobs';
import type { TFunction } from '@/lib/i18n';

let seq = 0;
function job(status: ImportStatus, over: Partial<ImportJob> = {}): ImportJob {
  seq++;
  return {
    id: over.id ?? `job-${seq}`,
    kind: 'import',
    status,
    phase: status === 'running' ? 'parse' : null,
    progress: 0,
    message: null,
    sourceName: 'export.zip',
    sizeBytes: null,
    stats: {} as ImportJob['stats'],
    error: null,
    createdAt: 1_700_000_000 + seq,
    startedAt: null,
    finishedAt: status === 'done' ? 1_700_000_100 + seq : null,
    etaS: null,
    step: null,
    ...over,
  };
}

/** t() that shows the key and its variables, enough to see which message is used. */
const t: TFunction = (key, vars) => (vars ? `${key}(${JSON.stringify(vars)})` : key);

describe('current import job', () => {
  it('is the running job, not the newest queued one', () => {
    // the list is newest first: a derive queued by a settings change sits above the running import
    const queued = job('queued');
    const running = job('running');
    const old = job('done');
    expect(currentJob([queued, running, old])).toBe(running);
    expect(waitingJobs([queued, running, old])).toBe(1);
  });

  it('is the oldest queued job when none runs (the server runs them first in, first out)', () => {
    const newer = job('queued');
    const older = job('queued');
    expect(currentJob([newer, older, job('done')])).toBe(older);
    expect(waitingJobs([newer, older])).toBe(1);
  });

  it('is null when nothing is queued or running', () => {
    expect(currentJob([job('done'), job('failed'), job('cancelled')])).toBeNull();
    expect(waitingJobs([job('done')])).toBe(0);
    expect(currentJob([])).toBeNull();
  });
});

describe('finished jobs', () => {
  it('reports a job that was active before and is over now', () => {
    const a = job('running', { id: 'a' });
    const done = { ...a, status: 'done' as const };
    expect(finishedSince([a], [done])).toEqual([done]);
  });

  it('reports a job that started and finished between two fetches', () => {
    const old = job('done', { id: 'old' });
    const quick = job('done', { id: 'quick' });
    expect(finishedSince([old], [quick, old]).map((j) => j.id)).toEqual(['quick']);
  });

  it('reports nothing on the first load or when nothing changed', () => {
    const list = [job('done'), job('failed')];
    expect(finishedSince(undefined, list)).toEqual([]);
    expect(finishedSince(list, list)).toEqual([]);
    const running = job('running');
    expect(finishedSince([running], [running])).toEqual([]);
  });

  it('does not report a job that is still queued or running', () => {
    expect(finishedSince([], [job('queued'), job('running')])).toEqual([]);
  });
});

function fakeIo(list: ImportJob[], byId: Record<string, ImportJob> = {}) {
  return {
    list: vi.fn(async (limit?: number) => (limit ? list.slice(0, limit) : list)),
    get: vi.fn(async (id: string) => {
      const j = byId[id] ?? list.find((x) => x.id === id);
      if (!j) throw new Error('404');
      return j;
    }),
  } satisfies JobsIo;
}

describe('loading the job list', () => {
  it('loads the whole list the first time and when asked to', async () => {
    const list = [job('done')];
    const io = fakeIo(list);
    expect(await loadJobs(undefined, io, false)).toEqual({ jobs: list, full: true });
    expect(await loadJobs(list, io, true)).toEqual({ jobs: list, full: true });
    expect(io.list).toHaveBeenCalledWith();
  });

  it('polls only the running job while it runs', async () => {
    const queued = job('queued');
    const running = job('running', { id: 'r', progress: 0.2 });
    const prev = [queued, running];
    const io = fakeIo([], { r: { ...running, progress: 0.4 } });
    const res = await loadJobs(prev, io, false);
    expect(res.full).toBe(false);
    expect(res.jobs[0]).toBe(queued);
    expect(res.jobs[1]!.progress).toBe(0.4);
    expect(io.list).not.toHaveBeenCalled();
  });

  it('loads the whole list when the running job ended or is gone', async () => {
    const running = job('running', { id: 'r' });
    const after = [{ ...running, status: 'done' as const }];
    const io = fakeIo(after);
    expect(await loadJobs([running], io, false)).toEqual({ jobs: after, full: true });
    const gone = fakeIo([]);
    expect(await loadJobs([running], gone, false)).toEqual({ jobs: [], full: true });
  });

  it('only checks the newest job while nothing runs, and keeps the same list when nothing is new', async () => {
    const prev = [job('done', { id: 'n' }), job('done')];
    const io = fakeIo(prev);
    const res = await loadJobs(prev, io, false);
    expect(res).toEqual({ jobs: prev, full: false });
    expect(res.jobs).toBe(prev);
    expect(io.list).toHaveBeenCalledWith(1);
  });

  it('asks for the whole list only when invalidated, or now and then while a job runs', () => {
    const idle = [job('done'), job('failed')];
    const busy = [job('queued'), job('running')];
    // idle: the newest job is enough, however long ago the whole list was loaded
    expect(wantsFullList(idle, false, 60_000, 15_000)).toBe(false);
    expect(wantsFullList(idle, true, 0, 15_000)).toBe(true);
    // running: only that job, but the whole list at least every 15 s (jobs queued meanwhile)
    expect(wantsFullList(busy, false, 5_000, 15_000)).toBe(false);
    expect(wantsFullList(busy, false, 16_000, 15_000)).toBe(true);
    expect(wantsFullList(undefined, false, 60_000, 15_000)).toBe(false);
  });

  it('loads the whole list when the server started a job by itself', async () => {
    const prev = [job('done', { id: 'n' })];
    const server = [job('running', { id: 'coros' }), ...prev];
    const io = fakeIo(server);
    expect(await loadJobs(prev, io, false)).toEqual({ jobs: server, full: true });
  });
});

describe('failed uploads', () => {
  const tooLarge = new Error('Upload exceeds the size limit');
  const wrongType = new Error('Upload the export.zip (or export.xml) from the Health app, or FIT files (.fit / .zip)');

  it('shows what the server said about a single file', () => {
    expect(uploadFailure(t, 1, [{ name: 'export.zip', error: tooLarge }])).toBe(tooLarge);
    expect(uploadFailure(t, 1, [])).toBeNull();
    expect(uploadFailure(t, 5, [])).toBeNull();
  });

  it('names the files that failed among several, with the reason when only one did', () => {
    // five FIT files dropped, one refused: the user learns which one is missing and why
    expect((uploadFailure(t, 5, [{ name: 'c.gpx', error: wrongType }]) as Error).message).toBe(
      `platform.import.uploadsFailed({"count":1,"names":"c.gpx"}) ${wrongType.message}`,
    );
    const two = [
      { name: 'a.fit', error: tooLarge },
      { name: 'b.fit', error: new Error('network') },
    ];
    expect((uploadFailure(t, 5, two) as Error).message).toBe('platform.import.uploadsFailed({"count":2,"names":"a.fit, b.fit"})');
  });

  it('takes files dropped during an upload into the running series instead of ignoring them', () => {
    const q = uploadQueue<string>();
    expect(q.add([])).toBe(false);
    expect(q.add(['a.fit', 'b.fit'])).toBe(true);
    expect(q.next()).toBe('a.fit');
    // dropped while a.fit uploads: the running series uploads it after b.fit
    expect(q.add(['c.fit'])).toBe(false);
    expect(q.waiting).toBe(2);
    expect(q.next()).toBe('b.fit');
    expect(q.next()).toBe('c.fit');
    expect(q.next()).toBeUndefined();
    // the series is over: the next drop starts a new one
    expect(q.add(['d.fit'])).toBe(true);
    expect(q.next()).toBe('d.fit');
    expect(q.next()).toBeUndefined();
  });
});

describe('job labels', () => {
  it('translates the phase, or the status while queued', () => {
    expect(jobPhaseLabel(t, job('running', { phase: 'derive' }))).toBe('platform.import.phases.derive');
    expect(jobPhaseLabel(t, job('queued'))).toBe('platform.import.status.queued');
    expect(jobPhaseLabel(t, job('running', { phase: null }))).toBe('platform.import.status.running');
  });

  it('translates the derive step by its id instead of showing the English label', () => {
    const j = job('running', { phase: 'derive', stepId: 'core.workouts', step: 'Workout streams, splits & best efforts' });
    expect(jobStepLabel(t, 'de', j)).toBe('platform.import.steps.workouts');
    expect(stepKey('core.workouts')).toBe('workouts');
    // the id is what counts: a label the server rewords keeps its translation
    expect(jobStepLabel(t, 'de', { ...j, step: 'Streams, splits and best efforts' })).toBe('platform.import.steps.workouts');
    // unknown steps only in English, with the server's label
    const unknown = job('running', { phase: 'derive', stepId: 'core.something-new', step: 'Something new' });
    expect(jobStepLabel(t, 'de', unknown)).toBeNull();
    expect(jobStepLabel(t, 'en', unknown)).toBe('Something new');
    expect(jobStepLabel(t, 'en', job('running', { phase: 'parse', step: null, stepId: null }))).toBeNull();
    expect(jobStepLabel(t, 'de', { ...j, status: 'done' })).toBeNull();
  });

  it("translates a failed job's error by its code, else shows the server's text", () => {
    expect(jobErrorText(t, 'Interrupted: the server stopped', 'interrupted')).toBe('platform.import.errors.interrupted');
    expect(jobErrorText(t, 'Source file is gone', 'source_gone')).toBe('platform.import.errors.sourceGone');
    expect(jobErrorText(t, 'Import worker exited unexpectedly (code 1)', 'worker_crashed')).toBe('platform.import.errors.crashed');
    // the code decides, not the wording
    expect(jobErrorText(t, 'Der Import-Thread ist abgestürzt', 'worker_crashed')).toBe('platform.import.errors.crashed');
    expect(jobErrorText(t, 'Interrupted by nothing we know', 'failed')).toBe('Interrupted by nothing we know');
    // codes without a translation keep the English detail
    const unreadable = 'Not a readable zip file: End of central directory record signature not found';
    expect(jobErrorText(t, unreadable, 'invalid_input')).toBe(unreadable);
    // without a code (a caller that passes only the text): the server's known wording
    expect(jobErrorText(t, 'Interrupted: the server stopped')).toBe('platform.import.errors.interrupted');
    expect(jobErrorText(t, 'File not found: /Users/me/Downloads/export.zip')).toBe('platform.import.errors.sourceGone');
    expect(jobErrorText(t, 'Something else')).toBe('Something else');
  });

  it('names COROS batches and rebuilds in the language of the interface', () => {
    expect(jobSourceLabel(t, job('done', { sourceName: 'COROS (3 activities)' }))).toBe(
      'platform.import.corosBatch({"count":3})',
    );
    expect(jobSourceLabel(t, job('done', { sourceName: 'COROS (1 activity)' }))).toBe(
      'platform.import.corosBatch({"count":1})',
    );
    expect(jobSourceLabel(t, job('done', { kind: 'rederive', sourceName: null }))).toBe('platform.import.rederive');
    expect(jobSourceLabel(t, job('done', { sourceName: 'export.zip' }))).toBe('export.zip');
  });

  it('knows every derive step of the server', () => {
    // the server reports the id of the running step (job.stepId): a step added there needs a translation
    const root = fileURLToPath(new URL('../../../../server/src', import.meta.url));
    const steps: { id: string; label: string }[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const src = fs.readFileSync(p, 'utf8');
          for (const m of src.matchAll(/id: '([a-z]+\.[a-z-]+)',\s*label: '([^']+)'/g)) steps.push({ id: m[1]!, label: m[2]! });
        }
      }
    };
    walk(root);
    expect(steps.length).toBeGreaterThan(10);
    for (const s of steps) expect(stepKey(s.id), `${s.id} (${s.label})`).not.toBeNull();
    // ids, not English labels, are what the translations hang on
    for (const s of steps) expect(stepKey(s.label), s.label).toBeNull();
  });
});
