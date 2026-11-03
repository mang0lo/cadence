/**
 * npm run coros-probe -w @cadence/server
 *
 * Saves what the COROS Training Hub API returns for the connected account (Watches page) to a local JSON file, so
 * the health sync can be built against real responses. Uses the stored login of CADENCE_DATA_DIR (no password
 * needed) and only reads. The file contains your health data: it stays in the data folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { getSetting } from '../src/core/settings';
import { openDb } from '../src/db/db';
import { CorosApiError, CorosClient } from '../src/features/connect/coros-client';

interface Account {
  email: string;
  region: 'en' | 'eu' | 'cn';
  pwdMd5: string;
  accessToken: string | null;
}

const config = loadConfig();
if (!fs.existsSync(config.dbPath)) {
  console.error(
    `No database at ${config.dbPath} – set CADENCE_DATA_DIR to the folder you used with npm run dev.`,
  );
  process.exit(1);
}
const db = openDb(config.dbPath);
const account = getSetting<Account | null>(db, 1, 'connect.coros', null);
db.close();
if (!account) {
  console.error('COROS is not connected in this database – connect it on the Watches page first.');
  process.exit(1);
}

const day = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');
const today = new Date();
const from = new Date(today.getTime() - 90 * 86400_000);
const client = new CorosClient({
  region: account.region,
  accessToken: account.accessToken,
  minIntervalMs: 1500,
});

const calls: {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number>;
}[] = [
  { name: 'account', method: 'GET', path: 'account/query' },
  {
    name: 'analyse (90 days)',
    method: 'GET',
    path: 'analyse/query',
    query: { startDay: day(from), endDay: day(today) },
  },
  { name: 'dashboard', method: 'GET', path: 'dashboard/query' },
  { name: 'dashboard detail', method: 'GET', path: 'dashboard/detail/query' },
  { name: 'latest activities', method: 'GET', path: 'activity/query', query: { pageNumber: 1, size: 3 } },
];

const out: Record<string, unknown> = { probedAt: today.toISOString(), region: account.region };
let relogged = false;
for (const c of calls) {
  process.stdout.write(`${c.name} … `);
  const run = () => client.call(c.method, c.path, c.query, c.method === 'POST' ? {} : undefined);
  try {
    out[c.path] = await run();
    console.log('ok');
  } catch (e) {
    if (e instanceof CorosApiError && !relogged) {
      relogged = true;
      // token expired: log in once with the stored hash and retry
      try {
        await client.login(account.email, account.pwdMd5);
        out[c.path] = await run();
        console.log('ok (after a new login)');
        continue;
      } catch (e2) {
        out[c.path] = { error: (e2 as Error).message };
      }
    } else out[c.path] = { error: (e as Error).message };
    console.log(`failed: ${(out[c.path] as { error: string }).error}`);
  }
}

const latest = (out['activity/query'] as { dataList?: { labelId: string; sportType: number }[] } | undefined)
  ?.dataList?.[0];
if (latest) {
  process.stdout.write('latest activity detail … ');
  try {
    out['activity/detail/query'] = await client.call(
      'POST',
      'activity/detail/query',
      {
        labelId: latest.labelId,
        sportType: latest.sportType,
      },
      {},
    );
    console.log('ok');
  } catch (e) {
    out['activity/detail/query'] = { error: (e as Error).message };
    console.log(`failed: ${(e as Error).message}`);
  }
}

const dir = path.join(config.dataDir, 'connect', 'coros');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `probe-${today.toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nSaved to ${file}`);
