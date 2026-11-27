/**
 * Dashboard widgets (FeatureModule.widgets, collected by features/registry.ts): each feature registers its own, the
 * dashboard shows them in one order, and their code stays out of the entry chunk (loaded by a dynamic import).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DataSourcesInfo } from '@cadence/shared';
import { dashboardWidgets, dashboardWidgetsFor, featureModules } from '@/features/registry';
import type { DashboardWidget } from '@/features/types';

const src = (path: string) =>
  fs.readFileSync(fileURLToPath(new URL(`../../src/${path}`, import.meta.url)), 'utf8');

const sources = (over: Partial<DataSourcesInfo> = {}): DataSourcesInfo => ({
  watch: 'apple',
  apple: { records: 10, workouts: 10 },
  coros: { connected: false, lastSyncAt: null, lastError: null, workouts: 0 },
  fitWorkouts: 0,
  metrics: [],
  sleepNights: 0,
  ecgCount: 0,
  rings: false,
  ...over,
});

describe('dashboard widgets', () => {
  it('come in the dashboard order', () => {
    expect(dashboardWidgets.map((w) => w.id)).toEqual([
      'weekly-snapshot',
      'readiness',
      'fitness',
      'power',
      'streak',
      'goals',
      'calendar',
      'health',
      'explorer',
    ]);
  });

  it('are registered by the feature that owns them, with unique ids and orders', () => {
    const owners = featureModules.flatMap((f) => (f.widgets ?? []).map((w) => [w.id, f.name] as const));
    expect(new Set(owners.map(([id]) => id)).size).toBe(owners.length);
    expect(new Set(dashboardWidgets.map((w) => w.order)).size).toBe(dashboardWidgets.length);
    expect(Object.fromEntries(owners)).toEqual({
      'weekly-snapshot': 'progress',
      fitness: 'progress',
      power: 'progress',
      readiness: 'health',
      health: 'health',
      streak: 'consistency',
      goals: 'consistency',
      calendar: 'consistency',
      explorer: 'maps',
    });
  });

  it('each load their component', async () => {
    for (const w of dashboardWidgets) expect(typeof (await w.component()), w.id).toBe('function');
  });

  it('leave out a widget whose data cannot exist for the athlete, once the data sources are known', () => {
    const ecg: DashboardWidget = {
      id: 'ecg',
      order: 1,
      component: async () => () => null,
      available: (s) => s.ecgCount > 0,
    };
    const all = [ecg, ...dashboardWidgets];
    // still unknown: nothing flickers away
    expect(dashboardWidgetsFor(undefined, all).map((w) => w.id)).toContain('ecg');
    expect(dashboardWidgetsFor(sources(), all).map((w) => w.id)).not.toContain('ecg');
    expect(dashboardWidgetsFor(sources({ ecgCount: 2 }), all)[0]?.id).toBe('ecg');
    // the current widgets show for every athlete (each renders nothing without its data)
    expect(dashboardWidgetsFor(sources())).toEqual(dashboardWidgets);
  });

  it('keep their code out of the feature modules (the entry chunk) and the dashboard page', () => {
    for (const f of featureModules) {
      const index = src(`features/${f.name}/index.tsx`);
      expect(index, f.name).not.toMatch(/from '\.\/widgets'/);
    }
    // the dashboard gets the widgets from the registry, never from another feature's files
    const home = src('features/activities/pages/HomePage.tsx');
    const imports = [...home.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((p) => /^(\.\.\/\.\.\/|@\/features\/)(?!registry$|types$)/.test(p))).toEqual([]);
  });
});
