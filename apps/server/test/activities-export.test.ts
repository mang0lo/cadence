import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityListPage, ImportJob } from '@cadence/shared';
import { generateSample } from '../scripts/sample/generate';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { run, openDb, type Db } from '../src/db/db';
import { clockDuration } from '../src/features/activities/export';

let dir: string;
let db: Db;
let app: FastifyInstance;

async function waitForJob(id: string): Promise<ImportJob> {
  for (;;) {
    const job = (await app.inject({ url: `/api/import/jobs/${id}` })).json<ImportJob>();
    if (['done', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, CRLF). */
function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\r') continue;
    else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  return rows;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-csv-'));
  const zip = path.join(dir, 'export.zip');
  await generateSample({ out: zip, size: 'small', seed: 5, endDate: '2026-06-30' });
  const config = loadConfig({
    CADENCE_DATA_DIR: path.join(dir, 'data'),
    CADENCE_MODE: 'dev',
    CADENCE_ALLOW_LOCAL_IMPORT: '1',
    LOG_LEVEL: 'silent',
  });
  db = openDb(config.dbPath);
  migrateAll(db);
  app = await buildApp(config, db, { jobRunner: 'inline' });
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/api/import/local', payload: { path: zip } });
  expect((await waitForJob(res.json<ImportJob>().id)).status).toBe('done');
}, 180_000);

afterAll(async () => {
  await app?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('activities CSV export', () => {
  it('formats durations as h:mm:ss', () => {
    expect(clockDuration(59.6)).toBe('0:01:00');
    expect(clockDuration(3 * 3600 + 25 * 60 + 7)).toBe('3:25:07');
    expect(clockDuration(30 * 3600)).toBe('30:00:00');
    expect(clockDuration(null)).toBe('');
  });

  it('exports every activity of the filter, in English with metric units', async () => {
    const list = (await app.inject({ url: '/api/activities/list?sport=run&limit=1' })).json<ActivityListPage>();
    const res = await app.inject({ url: '/api/activities/export.csv?sport=run&lang=en&units=metric' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="cadence-activities-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.body.startsWith('﻿')).toBe(true);
    const rows = parseCsv(res.body.slice(1), ',');
    const head = rows[0]!;
    expect(head.slice(0, 7)).toEqual(['ID', 'Date', 'Start time', 'Title', 'Sport', 'Place', 'Distance (km)']);
    expect(rows.length - 1).toBe(list.total);
    const first = Object.fromEntries(head.map((h, i) => [h, rows[1]![i]!]));
    const w = list.items[0]!;
    // newest first, like the list
    expect(Number(first.ID)).toBe(w.id);
    expect(first.Sport).toBe('Run');
    expect(Number(first['Distance (km)'])).toBeCloseTo(w.distanceM! / 1000, 2);
    expect(first['Pace (min/km)']).toMatch(/^\d{1,2}:\d{2}$/);
    expect(first['Moving time']).toMatch(/^\d+:\d{2}:\d{2}$/);
    expect(first.Indoor).toMatch(/^(yes|no)$/);
    if (w.place) expect(first.Place.startsWith(w.place)).toBe(true);
  });

  it('uses semicolons, decimal commas and German headers for German, miles for imperial', async () => {
    const res = await app.inject({ url: '/api/activities/export.csv?sport=ride&lang=de&units=imperial' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-disposition'])).toContain('cadence-aktivitaeten-');
    const rows = parseCsv(res.body.slice(1), ';');
    const head = rows[0]!;
    expect(head).toContain('Distanz (mi)');
    expect(head).toContain('Geschwindigkeit (mph)');
    expect(head).toContain('Höhenmeter (ft)');
    const i = head.indexOf('Distanz (mi)');
    const withDistance = rows.slice(1).find((r) => r[i]);
    expect(withDistance?.[i]).toMatch(/^\d+,\d{2}$/);
    expect(rows.slice(1).every((r) => r[head.indexOf('Sportart')] === 'Radfahrt')).toBe(true);
    // place names in German ("Wien", not "Vienna")
    const all = parseCsv((await app.inject({ url: '/api/activities/export.csv?lang=de' })).body.slice(1), ';');
    const places = all.slice(1).map((r) => r[all[0]!.indexOf('Ort')]!);
    expect(places.some((p) => p.length > 0)).toBe(true);
    expect(places.some((p) => p.includes('Vienna'))).toBe(false);
  });

  it('quotes text with separators and neutralizes formulas', async () => {
    const id = (await app.inject({ url: '/api/activities/list?limit=1' })).json<ActivityListPage>().items[0]!.id;
    run(db, 'UPDATE workouts SET name = ?, name_locked = 1, notes = ? WHERE id = ?', [
      '=HYPERLINK("x"), "quoted"',
      'line one\nline two; with separator',
      id,
    ]);
    const res = await app.inject({ url: '/api/activities/export.csv?lang=de' });
    const rows = parseCsv(res.body.slice(1), ';');
    const head = rows[0]!;
    const row = rows.find((r) => r[0] === String(id))!;
    expect(row[head.indexOf('Titel')]).toBe('\'=HYPERLINK("x"), "quoted"');
    expect(row[head.indexOf('Notizen')]).toBe('line one\nline two; with separator');
    // every row has the same number of cells
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
  });
});
