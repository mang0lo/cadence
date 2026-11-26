import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { getEnvironmentData, isMainThread, setEnvironmentData } from 'node:worker_threads';

/**
 * Thin helpers over node:sqlite (synchronous, no native addon needed).
 *
 * Binding rules of node:sqlite: only number | bigint | string | null | Uint8Array are accepted.
 * The helpers below convert `boolean → 0/1` and `undefined → null`; hot paths that use prepared
 * statements directly must do this themselves.
 */
export type Db = DatabaseSync;
export type SqlValue = number | bigint | string | null | Uint8Array;
export type Params = unknown[] | Record<string, unknown>;

export function openDb(file: string, opts: { readOnly?: boolean } = {}): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly: opts.readOnly ?? false });
  try {
    db.exec(`
      PRAGMA busy_timeout = 15000;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -65536;
      PRAGMA mmap_size = 268435456;
    `);
    if (!opts.readOnly && file !== ':memory:') {
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
    }
  } catch (e) {
    // not a database (e.g. a bad restore): do not keep the file open, it is moved aside next
    db.close();
    throw e;
  }
  return db;
}

/**
 * Writes of the HTTP (main) thread go first. node:sqlite is synchronous: a main-thread write that finds the write
 * lock taken sleeps in SQLite's busy handler on the event loop, and a job worker's back-to-back transactions leave it
 * almost no gap (the whole server froze for seconds, writes failed with 'database is locked' after busy_timeout).
 * Main-thread writes therefore announce themselves in a counter shared with every worker thread (environment data,
 * which workers created after this module loaded inherit), and a worker lets them through before it takes the write
 * lock again. A main-thread write now waits for at most the worker's current transaction.
 */
const WRITE_GATE = 'cadence.db.writeGate';
const writeGate: Int32Array | null = (() => {
  const shared = getEnvironmentData(WRITE_GATE);
  if (shared instanceof Int32Array) return shared;
  if (!isMainThread) return null;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  setEnvironmentData(WRITE_GATE, gate);
  return gate;
})();
/** A worker waits at most this long per write for the main thread (never while it holds the lock itself). */
const MAX_YIELD_MS = 2000;

/** Main thread: `fn` (a write) with the gate raised. Inside a transaction the lock is held already. */
function announced<T>(db: Db, fn: () => T): T {
  if (!writeGate || !isMainThread || db.isTransaction) return fn();
  Atomics.add(writeGate, 0, 1);
  try {
    return fn();
  } finally {
    Atomics.sub(writeGate, 0, 1);
    Atomics.notify(writeGate, 0);
  }
}

/** Worker: before it takes the write lock, let announced main-thread writes through (bounded). */
function yieldToMainThread(db: Db): void {
  if (!writeGate || isMainThread) return;
  let waiting = Atomics.load(writeGate, 0);
  if (waiting <= 0 || db.isTransaction) return;
  const deadline = Date.now() + MAX_YIELD_MS;
  while (waiting > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    Atomics.wait(writeGate, 0, waiting, Math.min(left, 50));
    waiting = Atomics.load(writeGate, 0);
  }
}

const statementCache = new WeakMap<Db, Map<string, StatementSync>>();

/** Prepare (and cache per connection) a statement. */
export function prepare(db: Db, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let st = cache.get(sql);
  if (!st) {
    st = db.prepare(sql);
    cache.set(sql, st);
  }
  return st;
}

function clean(v: unknown): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v as SqlValue;
}

function bind(params?: Params): SqlValue[] | [Record<string, SqlValue>] {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(clean);
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = clean(v);
  return [out];
}

export function all<T = Record<string, unknown>>(db: Db, sql: string, params?: Params): T[] {
  return prepare(db, sql).all(...(bind(params) as SqlValue[])) as T[];
}

export function get<T = Record<string, unknown>>(db: Db, sql: string, params?: Params): T | undefined {
  return prepare(db, sql).get(...(bind(params) as SqlValue[])) as T | undefined;
}

export function run(db: Db, sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
  const st = prepare(db, sql);
  const args = bind(params) as SqlValue[];
  yieldToMainThread(db);
  const r = announced(db, () => st.run(...args));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

/**
 * Undo after a failed statement, keeping the error that says why: for SQLITE_FULL, I/O errors or RAISE(ROLLBACK)
 * SQLite has already rolled the whole transaction back, and a second ROLLBACK would only report that none is active.
 */
function rollback(db: Db, sql: string): void {
  if (!db.isTransaction) return;
  try {
    db.exec(sql);
  } catch {
    /* the original error is rethrown */
  }
}

/** Run `fn` inside a transaction (nested calls become savepoints). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      rollback(db, `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  }
  yieldToMainThread(db);
  return announced(db, () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      rollback(db, 'ROLLBACK');
      throw e;
    }
  });
}

/** Parse a JSON column, returning `fallback` for NULL / invalid content. */
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
