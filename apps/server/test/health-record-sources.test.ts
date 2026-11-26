import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetricSources } from '@cadence/shared';
import { all, get, run } from '../src/db/db';
import { refreshRecordSources } from '../src/features/health/record-sources';
import { SRC, createHealthFixture, type HealthFixture } from './health-fixture';

/**
 * The sources of a metric's whole history come from the derive step's counts (no grouping of millions of samples on
 * the HTTP thread) while the type's samples are unchanged, and from a live count as soon as they changed.
 */
let fx: HealthFixture;
const URL = '/api/health/metric/sources?type=HeartRate';
const counts = (s: MetricSources) => Object.fromEntries(s.sources.map((x) => [x.name, x.count]));

beforeAll(async () => {
  fx = await createHealthFixture();
  fx.T.hr = fx.addType(1, 'HKQuantityTypeIdentifierHeartRate', 'quantity', 'count/min', 'avg');
  run(fx.db, "INSERT INTO devices (id, raw, name, hardware) VALUES (1, '<<HKDevice>> Apple Watch', 'Apple Watch', 'Watch7,3')");
  for (let i = 0; i < 6; i++) fx.rec(fx.T.hr, `2026-03-0${i + 1}T10:00:00+01:00`, `2026-03-0${i + 1}T10:00:00+01:00`, { value: 60 + i });
  fx.rec(fx.T.hr, '2026-03-02T12:00:00+01:00', '2026-03-02T12:00:00+01:00', { value: 70, source: SRC.phone });
  run(fx.db, 'UPDATE records SET device_id = 1 WHERE source_id = ?', [SRC.watch]);
  fx.refreshStats();
}, 60_000);

afterAll(async () => {
  await fx?.close();
});

describe('metric sources of the whole history', () => {
  it('counts every type once and only recounts types whose samples changed', () => {
    expect(refreshRecordSources(fx.db, 1)).toBe(1);
    expect(refreshRecordSources(fx.db, 1)).toBe(0);
    expect(all(fx.db, 'SELECT source_id, device_id, n FROM health_record_sources ORDER BY source_id')).toEqual([
      { source_id: SRC.phone, device_id: null, n: 1 },
      { source_id: SRC.watch, device_id: 1, n: 6 },
    ]);
  });

  it('serves the stored counts while the type is unchanged', async () => {
    // mark the stored counts: the answer must come from them, not from grouping the samples
    run(fx.db, 'UPDATE health_record_sources SET n = 600 WHERE source_id = ?', [SRC.watch]);
    const s = await fx.getJson<MetricSources>(URL);
    expect(counts(s)).toEqual({ 'Apple Watch von Hannes': 600, 'iPhone von Hannes': 1 });
    expect(s.sources[0]!.devices).toEqual(['Apple Watch (Watch7,3)']);
    expect(s.total).toBe(601);
  });

  it('counts live once the samples changed, until the derive step counted them again', async () => {
    fx.rec(fx.T.hr!, '2026-03-07T10:00:00+01:00', '2026-03-07T10:00:00+01:00', { value: 61, source: SRC.scale });
    fx.refreshStats();
    const live = await fx.getJson<MetricSources>(URL);
    expect(counts(live)).toEqual({ 'Apple Watch von Hannes': 6, 'iPhone von Hannes': 1, Withings: 1 });
    expect(live.total).toBe(8);
    // a derive run (the step is part of the health feature) stores the new counts
    fx.app.jobs.enqueueDerive(1, { workoutIds: [], sinceDay: '2026-03-07' });
    for (let i = 0; i < 500 && fx.app.jobs.busy(1); i++) await new Promise((r) => setTimeout(r, 10));
    const stored = all<{ source_id: number; n: number }>(fx.db, 'SELECT source_id, n FROM health_record_sources ORDER BY source_id');
    expect(stored).toEqual([
      { source_id: SRC.phone, n: 1 },
      { source_id: SRC.watch, n: 6 },
      { source_id: SRC.scale, n: 1 },
    ]);
  });

  it('forgets types without samples', () => {
    run(fx.db, 'DELETE FROM records');
    fx.refreshStats();
    refreshRecordSources(fx.db, 1);
    expect(get(fx.db, 'SELECT COUNT(*) AS n FROM health_record_sources')).toEqual({ n: 0 });
    expect(get(fx.db, 'SELECT COUNT(*) AS n FROM health_record_sources_stamp')).toEqual({ n: 0 });
  });
});
