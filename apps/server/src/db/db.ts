import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

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
  const r = prepare(db, sql).run(...(bind(params) as SqlValue[]));
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
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    rollback(db, 'ROLLBACK');
    throw e;
  }
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
