import { all, run, tx, type Db } from './db';

export interface Migration {
  /** Globally unique, never renamed. Convention: `<feature>_<nnn>_<what>`, e.g. `maps_001_explorer_tiles`. */
  id: string;
  up: string | ((db: Db) => void);
}

/** Apply all migrations that have not been applied yet, in the given order. */
export function migrate(db: Db, migrations: Migration[]): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(all<{ id: string }>(db, 'SELECT id FROM _migrations').map((r) => r.id));
  const ran: string[] = [];
  const seen = new Set<string>();
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`);
    seen.add(m.id);
    if (applied.has(m.id)) continue;
    tx(db, () => {
      if (typeof m.up === 'string') db.exec(m.up);
      else m.up(db);
      run(db, 'INSERT INTO _migrations (id, applied_at) VALUES (?, unixepoch())', [m.id]);
    });
    ran.push(m.id);
  }
  return ran;
}
