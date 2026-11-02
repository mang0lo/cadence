import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EcgClass, EcgDetail, EcgSummary } from '@cadence/shared';
import { all, get } from '../../db/db';
import { gunzipFloat32 } from '../../lib/gzip';
import { notFound } from '../../lib/http';
import type { DeriveStep } from '../types';
import { classifyEcg, detectRPeaks, ensureEcgStats } from './ecg';

interface EcgListRow {
  id: number;
  recorded_ts: number;
  tz_min: number;
  classification: string | null;
  symptoms: string | null;
  device: string | null;
  software_version: string | null;
  sample_rate_hz: number | null;
  lead: string | null;
  avg_hr: number | null;
  duration_s: number | null;
  class_key: EcgClass | null;
}

const COLS = `e.id, e.recorded_ts, e.tz_min, e.classification, e.symptoms, e.device, e.software_version,
  e.sample_rate_hz, e.lead, s.avg_hr, s.duration_s, s.class_key`;

const toSummary = (r: EcgListRow): EcgSummary => ({
  id: r.id,
  recordedTs: r.recorded_ts,
  tzMin: r.tz_min,
  classification: r.classification,
  classKey: r.class_key ?? classifyEcg(r.classification),
  symptoms: r.symptoms?.trim() ? r.symptoms : null,
  device: r.device,
  softwareVersion: r.software_version,
  sampleRateHz: r.sample_rate_hz,
  durationS: r.duration_s,
  avgHr: r.avg_hr,
  lead: r.lead,
});

const idParam = z.object({ id: z.coerce.number().int().positive() });

export function registerEcgRoutes(app: FastifyInstance): void {
  // Recordings, newest first (stats are computed on first access when the derive step has not run yet)
  app.get('/ecg', async (req): Promise<EcgSummary[]> => {
    ensureEcgStats(app.db, req.athleteId);
    return all<EcgListRow>(
      app.db,
      `SELECT ${COLS} FROM ecg_readings e LEFT JOIN health_ecg_stats s ON s.ecg_id = e.id
       WHERE e.athlete_id = ? ORDER BY e.recorded_ts DESC`,
      [req.athleteId],
    ).map(toSummary);
  });

  // One recording with its waveform (µV) and the detected R peaks
  app.get('/ecg/:id', async (req): Promise<EcgDetail> => {
    const { id } = idParam.parse(req.params);
    ensureEcgStats(app.db, req.athleteId);
    const row = get<EcgListRow & { samples: Uint8Array | null }>(
      app.db,
      `SELECT ${COLS}, e.samples FROM ecg_readings e LEFT JOIN health_ecg_stats s ON s.ecg_id = e.id
       WHERE e.athlete_id = ? AND e.id = ?`,
      [req.athleteId, id],
    );
    if (!row) throw notFound('ECG recording');
    const raw = row.samples ? gunzipFloat32(row.samples) : new Float32Array(0);
    const rate = row.sample_rate_hz ?? 0;
    return {
      ...toSummary(row),
      samples: Array.from(raw, (v) => Math.round(v)),
      rPeaks: rate > 0 ? detectRPeaks(raw, rate) : [],
    };
  });
}

/** Derive step: average heart rate / duration / normalised classification of every ECG recording. */
export const ecgStep: DeriveStep = {
  id: 'health.ecg',
  label: 'ECG analysis',
  weight: 0.5,
  run(ctx) {
    const n = ensureEcgStats(ctx.db, ctx.athleteId, ctx.sinceDay === null && ctx.workoutIds === 'all', ctx.checkCancelled);
    ctx.log(`health.ecg: ${n} recordings analysed`);
    ctx.report(1);
  },
};
