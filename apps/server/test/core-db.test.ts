import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, openDb, run, tx, type Db } from '../src/db/db';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-db-'));
  db = openDb(path.join(dir, 'cadence.db'));
  db.exec('CREATE TABLE writes (id INTEGER PRIMARY KEY, who TEXT NOT NULL, at INTEGER NOT NULL)');
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('transactions', () => {
  it('keeps the real error when SQLite already rolled the transaction back', () => {
    // RAISE(ROLLBACK) ends the whole transaction, like SQLITE_FULL or an I/O error can
    db.exec(`CREATE TRIGGER no_mallory BEFORE INSERT ON writes WHEN NEW.who = 'mallory'
             BEGIN SELECT RAISE(ROLLBACK, 'disk is full (simulated)'); END`);
    const insert = (who: string) => run(db, 'INSERT INTO writes (who, at) VALUES (?, 0)', [who]);
    expect(() => tx(db, () => (insert('a'), insert('mallory')))).toThrow(/disk is full/);
    expect(db.isTransaction).toBe(false);
    // nested: the savepoint is gone with the transaction
    expect(() => tx(db, () => tx(db, () => (insert('b'), insert('mallory'))))).toThrow(/disk is full/);
    expect(db.isTransaction).toBe(false);
    expect(all(db, 'SELECT who FROM writes')).toEqual([]);
    // ordinary errors still roll back what the transaction did
    expect(() => tx(db, () => (insert('c'), run(db, 'INSERT INTO nope VALUES (1)')))).toThrow(/no such table/);
    expect(() => tx(db, () => (insert('d'), tx(db, () => (insert('e'), run(db, 'INSERT INTO nope VALUES (1)')))))).toThrow(/no such table/);
    expect(all(db, 'SELECT who FROM writes')).toEqual([]);
  });

  it('closes the connection when a file is not a database', () => {
    const file = path.join(dir, 'text.db');
    fs.writeFileSync(file, 'plain text, no database '.repeat(100));
    expect(() => openDb(file)).toThrow(/not a database/);
    // nothing holds the file open (Windows could not move it otherwise)
    fs.renameSync(file, `${file}.moved`);
  });
});

describe('writes of the HTTP thread while a job worker writes', () => {
  it('wait for one worker transaction, not for the whole job', async () => {
    const batches = 16;
    const holdMs = 150;
    const worker = new Worker(new URL('./core-db-writer.worker.ts', import.meta.url), {
      workerData: { file: path.join(dir, 'cadence.db'), batches, holdMs },
      execArgv: ['--import', 'tsx'],
    });
    let done: { ms: number } | null = null;
    let failed: Error | null = null;
    const exited = new Promise((r) => worker.once('exit', r));
    await new Promise<void>((resolve, reject) => {
      worker.on('error', (e: Error) => ((failed = e), reject(e)));
      void exited.then((code) => reject(new Error(`worker exited with ${String(code)}`)));
      worker.on('message', (m: { type: string; ms: number }) => {
        if (m.type === 'started') resolve();
        else done = m;
      });
    });
    const waits: number[] = [];
    while (!done && !failed && waits.length < 40) {
      await new Promise((r) => setTimeout(r, 120));
      const t0 = performance.now();
      run(db, 'INSERT INTO writes (who, at) VALUES (?, ?)', ['main', Date.now()]);
      waits.push(performance.now() - t0);
    }
    await exited;
    expect(failed).toBeNull();
    const workerRows = all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM writes WHERE who = 'worker'")[0]!.n;
    expect(workerRows).toBe(batches);
    expect(waits.length).toBeGreaterThan(5);
    // without coordination the first write waits for the whole job (~2.4 s); one transaction plus slack for slow CI
    expect(Math.max(...waits)).toBeLessThan(holdMs * 2 + 600);
  });
});
