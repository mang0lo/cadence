import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrateAll } from '../src/app';
import { lastAppleExport } from '../src/core/coverage';
import { openDb, run, type Db } from '../src/db/db';

/**
 * The newest Apple Health export is asked for on every consistency and health request: its stats JSON is read again
 * only when the set of finished import jobs changed, with the same answer as reading them every time.
 */
let db: Db;

beforeAll(() => {
  db = openDb(':memory:');
  migrateAll(db);
});

afterAll(() => db?.close());

beforeEach(() => run(db, 'DELETE FROM import_jobs'));

let seq = 0;
const job = (o: { athlete?: number; status?: string; exportDate?: string | null; kind?: string }) => {
  const id = `job-${seq++}`;
  run(db, 'INSERT INTO import_jobs (id, athlete_id, kind, status, stats, finished_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    o.athlete ?? 1,
    o.kind ?? 'import',
    o.status ?? 'done',
    JSON.stringify({ exportDate: o.exportDate ?? null, summary: { note: 'x'.repeat(2000) } }),
    o.status === 'running' ? null : 1000 + seq,
  ]);
  return id;
};

describe('newest Apple Health export', () => {
  it('follows every change of the finished import jobs', () => {
    expect(lastAppleExport(db, 1)).toBeNull();
    job({ exportDate: '2026-06-20 08:00:00 +0200' });
    job({}); // a COROS sync without an export date
    expect(lastAppleExport(db, 1)).toMatchObject({ day: '2026-06-20', tzMin: 120 });
    // an older export imported later does not move it back
    job({ exportDate: '2026-05-01 08:00:00 +0200' });
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-20');
    // a running import counts once it is done
    const running = job({ status: 'running', exportDate: '2026-06-24 07:00:00 +0200' });
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-20');
    run(db, "UPDATE import_jobs SET status = 'done', finished_at = 5000 WHERE id = ?", [running]);
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-24');
    // other athletes and rederive jobs are not mixed in
    job({ athlete: 2, exportDate: '2026-07-01 08:00:00 +0200' });
    job({ kind: 'rederive', exportDate: '2026-07-02 08:00:00 +0200' });
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-24');
    expect(lastAppleExport(db, 2)?.day).toBe('2026-07-01');
    // "Delete all data" removes the jobs
    run(db, "DELETE FROM import_jobs WHERE athlete_id = 1 AND status NOT IN ('queued', 'running')");
    expect(lastAppleExport(db, 1)).toBeNull();
  });

  it('reads the stats again only when the set of finished jobs changed', () => {
    const id = job({ exportDate: '2026-06-20 08:00:00 +0200' });
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-20');
    // finished jobs never change; a change behind the server's back shows that nothing was read again
    run(db, 'UPDATE import_jobs SET stats = ? WHERE id = ?', [JSON.stringify({ exportDate: '2026-06-22 08:00:00 +0200' }), id]);
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-20');
    job({});
    expect(lastAppleExport(db, 1)?.day).toBe('2026-06-22');
  });
});
