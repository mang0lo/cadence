import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AthleteSettings } from '@cadence/shared';
import { mergeShown, moved, orderNav } from '../../web/src/components/layout/navOrder';
import { buildApp, migrateAll } from '../src/app';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/db';

const GROUPS = ['training', 'habits', 'health'];
const item = (path: string, group: string, order: number) => ({ path, group, order });
const ITEMS = [
  item('/activities', 'training', 20),
  item('/', 'training', 10),
  item('/progress', 'training', 30),
  item('/goals', 'habits', 20),
  item('/consistency', 'habits', 10),
  item('/health', 'health', 10),
];
const paths = (nav: { group: string; items: { path: string }[] }[]) => nav.map((g) => [g.group, ...g.items.map((i) => i.path)]);

describe('order of the sidebar', () => {
  it('uses the default order without a saved one', () => {
    expect(paths(orderNav(ITEMS, GROUPS, { order: [], groups: [] }))).toEqual([
      ['training', '/', '/activities', '/progress'],
      ['habits', '/consistency', '/goals'],
      ['health', '/health'],
    ]);
  });

  it('applies the saved order of pages and groups', () => {
    const nav = orderNav(ITEMS, GROUPS, {
      order: ['/progress', '/', '/activities', '/goals', '/consistency'],
      groups: ['habits', 'health', 'training'],
    });
    expect(paths(nav)).toEqual([
      ['habits', '/goals', '/consistency'],
      ['health', '/health'],
      ['training', '/progress', '/', '/activities'],
    ]);
  });

  it('puts pages and groups the saved order does not know after the known ones', () => {
    const nav = orderNav([...ITEMS, item('/new', 'training', 5), item('/gone-group', 'explore', 1)], [...GROUPS, 'explore'], {
      order: ['/progress', '/removed-page', '/'],
      groups: ['health'],
    });
    expect(paths(nav)).toEqual([
      ['health', '/health'],
      ['training', '/progress', '/', '/new', '/activities'],
      ['habits', '/consistency', '/goals'],
      ['explore', '/gone-group'],
    ]);
  });

  it('leaves out groups without pages', () => {
    expect(orderNav(ITEMS.slice(0, 3), GROUPS, { order: [], groups: [] }).map((g) => g.group)).toEqual(['training']);
  });

  it('moves an entry', () => {
    expect(moved(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moved(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
    expect(moved(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('keeps hidden pages in their slots when the shown ones are reordered', () => {
    // "ecg" is hidden for this athlete: moving "sleep" to the top must not push it around
    expect(mergeShown(['health', 'ecg', 'sleep', 'body'], ['sleep', 'health', 'body'])).toEqual(['sleep', 'ecg', 'health', 'body']);
    expect(mergeShown(['a', 'b'], ['b', 'a'])).toEqual(['b', 'a']);
  });
});

describe('sidebar order in the settings', () => {
  it('is stored with the athlete and validated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-nav-'));
    const config = loadConfig({ CADENCE_DATA_DIR: path.join(dir, 'data'), CADENCE_MODE: 'dev', LOG_LEVEL: 'silent' });
    const db = openDb(config.dbPath);
    migrateAll(db);
    const app = await buildApp(config, db, { jobRunner: 'inline' });
    await app.ready();
    try {
      const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/api/settings', payload });
      expect((await app.inject({ url: '/api/settings' })).json<AthleteSettings>()).toMatchObject({ navOrder: [], navGroups: [] });
      const res = await patch({ navOrder: ['/goals', '/', '/activities'], navGroups: ['habits', 'training'] });
      expect(res.statusCode).toBe(200);
      // the other settings stay as they are
      expect(res.json<AthleteSettings>()).toMatchObject({ navOrder: ['/goals', '/', '/activities'], navGroups: ['habits', 'training'], weekStart: 1 });
      expect((await app.inject({ url: '/api/settings' })).json<AthleteSettings>().navOrder).toEqual(['/goals', '/', '/activities']);
      expect((await patch({ navOrder: ['javascript:alert(1)'] })).statusCode).toBe(400);
      expect((await patch({ navOrder: 'goals' })).statusCode).toBe(400);
      // back to the default order
      expect((await patch({ navOrder: [], navGroups: [] })).json<AthleteSettings>()).toMatchObject({ navOrder: [], navGroups: [] });
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
