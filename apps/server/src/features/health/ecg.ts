import type { EcgClass } from '@cadence/shared';
import { all, run, type Db } from '../../db/db';
import { gunzipFloat32 } from '../../lib/gzip';

/**
 * R-peak detection on an ECG strip (Pan–Tompkins style): slope → square → moving-window integration, an adaptive
 * threshold on the integrated signal, a 250 ms refractory period, then each peak is moved to the largest deflection
 * of the (baseline-corrected) signal within ±60 ms. Returns sample indices. Works on single-lead strips like the
 * 30 second recordings of the Apple Watch (512 Hz, µV).
 */
export function detectRPeaks(samples: ArrayLike<number>, rateHz: number): number[] {
  const n = samples.length;
  if (!(rateHz > 20) || n < rateHz * 3) return [];
  // baseline wander: subtract a moving mean over ~0.6 s
  const win = Math.max(3, Math.round(rateHz * 0.6)) | 1;
  const half = win >> 1;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + (Number.isFinite(samples[i]!) ? (samples[i] as number) : 0);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    x[i] = (Number.isFinite(samples[i]!) ? (samples[i] as number) : 0) - (prefix[hi]! - prefix[lo]!) / (hi - lo);
  }
  // squared slope, integrated over ~100 ms
  const sq = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const d = x[i + 1]! - x[i - 1]!;
    sq[i] = d * d;
  }
  const iw = Math.max(3, Math.round(rateHz * 0.1));
  const integ = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += sq[i]!;
    if (i >= iw) acc -= sq[i - iw]!;
    integ[i] = acc / iw;
  }
  // adaptive threshold from a robust maximum (99.5th percentile) of the integrated signal
  const sorted = Float64Array.from(integ).sort();
  const top = sorted[Math.min(n - 1, Math.floor(n * 0.995))]!;
  if (!(top > 0)) return [];
  const thr = top * 0.25;
  const refractory = Math.round(rateHz * 0.25);
  const cand: number[] = [];
  let last = -refractory;
  for (let i = 1; i < n - 1; i++) {
    const v = integ[i]!;
    if (v < thr || v < integ[i - 1]! || v < integ[i + 1]!) continue;
    if (i - last < refractory) {
      // within the refractory period keep the stronger candidate
      if (cand.length && v > integ[cand[cand.length - 1]!]!) {
        cand[cand.length - 1] = i;
        last = i;
      }
      continue;
    }
    cand.push(i);
    last = i;
  }
  // move each candidate to the largest deflection of the corrected signal nearby (the QRS peak)
  const reach = Math.round(rateHz * 0.06);
  const peaks: number[] = [];
  for (const c of cand) {
    // the integrated window trails the beat by roughly half its width
    const centre = Math.max(0, c - Math.round(iw / 2));
    let best = centre;
    let bestV = -1;
    for (let j = Math.max(0, centre - reach); j <= Math.min(n - 1, centre + reach); j++) {
      const a = Math.abs(x[j]!);
      if (a > bestV) {
        bestV = a;
        best = j;
      }
    }
    if (!peaks.length || best - peaks[peaks.length - 1]! >= refractory) peaks.push(best);
  }
  return peaks;
}

/** Mean heart rate (bpm) over the strip from the R peaks; null with fewer than three beats. */
export function averageHeartRate(peaks: number[], rateHz: number): number | null {
  if (peaks.length < 3 || !(rateHz > 0)) return null;
  const seconds = (peaks[peaks.length - 1]! - peaks[0]!) / rateHz;
  if (!(seconds > 0)) return null;
  const bpm = ((peaks.length - 1) / seconds) * 60;
  return bpm >= 20 && bpm <= 300 ? bpm : null;
}

/**
 * Apple writes the classification in the language of the phone ("Sinus Rhythm", "Sinusrhythmus", "Rythme sinusal",
 * "洞調律", "Atrial Fibrillation", "Vorhofflimmern", "Fibrilación auricular", "Inconclusive", "Hohe Herzfrequenz" …).
 * Everything is mapped onto a few keys the UI localises. Stored keys follow new wording through a migration that calls
 * reclassifyEcgs (see migrations.ts).
 */
export function classifyEcg(raw: string | null | undefined): EcgClass {
  const s = (raw ?? '').toLowerCase();
  if (!s.trim()) return 'unrecognized';
  if (/sinus|洞調律/.test(s)) return 'sinus';
  if (/atrial|fibril|vorhofflimmern|auricul|心房細動/.test(s)) return 'afib';
  const heart = /(heart|herz|cardiaque|cardiac|cardíac|bpm|心拍)/;
  if (/(high|over|hohe|über|ueber|élevée|elevee|supérieure|superieure|alta|elevada|superior|高心拍|心拍数が高)/.test(s) && (heart.test(s) || /(150|120)/.test(s)))
    return 'highHr';
  if (/(low|under|niedrige|unter|faible|basse|inférieure|inferieure|baja|inferior|低心拍|心拍数が低)/.test(s) && (heart.test(s) || /(50|40)/.test(s)))
    return 'lowHr';
  if (/(poor|schlecht|unzureichend|quality|qualität|mauvais|qualité|deficiente|calidad|不良)/.test(s)) return 'poor';
  if (/(inconclusive|nicht eindeutig|unklar|concluant|concluyente|判定不能)/.test(s)) return 'inconclusive';
  if (/(unrecogni|not classified|nicht klassifiziert|nicht erkannt|notset|non reconnu|non classé|no reconocido|no clasificado|未分類|分類不能)/.test(s))
    return 'unrecognized';
  return 'other';
}

/** Re-classify the stored recordings with the current rules; returns the number of changed rows. */
export function reclassifyEcgs(db: Db): number {
  let n = 0;
  for (const r of all<{ ecg_id: number; classification: string | null; class_key: string }>(
    db,
    'SELECT s.ecg_id, e.classification, s.class_key FROM health_ecg_stats s JOIN ecg_readings e ON e.id = s.ecg_id',
  )) {
    const key = classifyEcg(r.classification);
    if (key === r.class_key) continue;
    run(db, 'UPDATE health_ecg_stats SET class_key = ? WHERE ecg_id = ?', [key, r.ecg_id]);
    n++;
  }
  return n;
}

interface EcgRow {
  id: number;
  classification: string | null;
  sample_rate_hz: number | null;
  samples: Uint8Array | null;
}

/** Compute and store the stats (avg HR, duration, class) of every ECG that has none yet (or of all with `force`). */
export function ensureEcgStats(db: Db, athleteId: number, force = false, check?: () => void): number {
  const rows = all<EcgRow>(
    db,
    `SELECT e.id, e.classification, e.sample_rate_hz, e.samples FROM ecg_readings e
     LEFT JOIN health_ecg_stats s ON s.ecg_id = e.id
     WHERE e.athlete_id = ? ${force ? '' : 'AND s.ecg_id IS NULL'}`,
    [athleteId],
  );
  for (const r of rows) {
    check?.();
    let avg: number | null = null;
    let duration: number | null = null;
    if (r.samples && r.sample_rate_hz) {
      try {
        const samples = gunzipFloat32(r.samples);
        duration = samples.length / r.sample_rate_hz;
        avg = averageHeartRate(detectRPeaks(samples, r.sample_rate_hz), r.sample_rate_hz);
      } catch {
        /* corrupt blob: keep the stats empty */
      }
    }
    run(
      db,
      `INSERT INTO health_ecg_stats (ecg_id, athlete_id, avg_hr, duration_s, class_key) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ecg_id) DO UPDATE SET avg_hr = excluded.avg_hr, duration_s = excluded.duration_s, class_key = excluded.class_key`,
      [r.id, athleteId, avg, duration, classifyEcg(r.classification)],
    );
  }
  return rows.length;
}
