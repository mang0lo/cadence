import {
  M_PER_FT,
  M_PER_KM,
  M_PER_MI,
  placeName,
  sportInfo,
  workoutTitle,
  type ActivitySort,
  type Units,
} from '@cadence/shared';
import { SUMMARY_COLS, toSummary, type WorkoutRow } from '../../core/workouts';
import { all, type Db } from '../../db/db';
import { SORT_EXPR, listWhere, type ListFilter } from './queries';

export type CsvLang = 'en' | 'de';

export interface CsvOptions extends ListFilter {
  lang: CsvLang;
  units: Units;
  sort: ActivitySort;
  order: 'asc' | 'desc';
}

type Column =
  | 'id'
  | 'date'
  | 'start'
  | 'title'
  | 'sport'
  | 'place'
  | 'distance'
  | 'moving'
  | 'elapsed'
  | 'pace'
  | 'speed'
  | 'elevation'
  | 'avgHr'
  | 'maxHr'
  | 'avgPower'
  | 'cadence'
  | 'energy'
  | 'effort'
  | 'temperature'
  | 'indoor'
  | 'source'
  | 'notes';

const COLUMNS: Column[] = [
  'id',
  'date',
  'start',
  'title',
  'sport',
  'place',
  'distance',
  'moving',
  'elapsed',
  'pace',
  'speed',
  'elevation',
  'avgHr',
  'maxHr',
  'avgPower',
  'cadence',
  'energy',
  'effort',
  'temperature',
  'indoor',
  'source',
  'notes',
];

function headers(lang: CsvLang, units: Units): Record<Column, string> {
  const imperial = units === 'imperial';
  const d = imperial ? 'mi' : 'km';
  const e = imperial ? 'ft' : 'm';
  const v = imperial ? 'mph' : 'km/h';
  const deg = imperial ? '°F' : '°C';
  return lang === 'de'
    ? {
        id: 'ID',
        date: 'Datum',
        start: 'Startzeit',
        title: 'Titel',
        sport: 'Sportart',
        place: 'Ort',
        distance: `Distanz (${d})`,
        moving: 'Bewegungszeit',
        elapsed: 'Gesamtzeit',
        pace: `Pace (min/${d})`,
        speed: `Geschwindigkeit (${v})`,
        elevation: `Höhenmeter (${e})`,
        avgHr: 'Ø Herzfrequenz (bpm)',
        maxHr: 'Max. Herzfrequenz (bpm)',
        avgPower: 'Ø Leistung (W)',
        cadence: 'Ø Kadenz (spm/rpm)',
        energy: 'Aktive Energie (kcal)',
        effort: 'Relative Anstrengung',
        temperature: `Temperatur (${deg})`,
        indoor: 'Indoor',
        source: 'Quelle',
        notes: 'Notizen',
      }
    : {
        id: 'ID',
        date: 'Date',
        start: 'Start time',
        title: 'Title',
        sport: 'Sport',
        place: 'Place',
        distance: `Distance (${d})`,
        moving: 'Moving time',
        elapsed: 'Elapsed time',
        pace: `Pace (min/${d})`,
        speed: `Speed (${v})`,
        elevation: `Elevation gain (${e})`,
        avgHr: 'Avg heart rate (bpm)',
        maxHr: 'Max heart rate (bpm)',
        avgPower: 'Avg power (W)',
        cadence: 'Avg cadence (spm/rpm)',
        energy: 'Active energy (kcal)',
        effort: 'Relative effort',
        temperature: `Temperature (${deg})`,
        indoor: 'Indoor',
        source: 'Source',
        notes: 'Notes',
      };
}

const P2 = (n: number) => String(n).padStart(2, '0');

/** h:mm:ss (hours not wrapped at 24). */
export function clockDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s) || s < 0) return '';
  const t = Math.round(s);
  return `${Math.floor(t / 3600)}:${P2(Math.floor((t % 3600) / 60))}:${P2(t % 60)}`;
}

/** m:ss per km/mi. */
function paceText(mps: number | null, imperial: boolean): string {
  if (!mps || mps <= 0 || !Number.isFinite(mps)) return '';
  const s = Math.round((imperial ? M_PER_MI : M_PER_KM) / mps);
  if (s >= 100 * 60) return '';
  return `${Math.floor(s / 60)}:${P2(s % 60)}`;
}

/** Spreadsheets evaluate cells starting with these as formulas (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A text cell: quoted when needed, formula-like text neutralized with a leading apostrophe. */
function textCell(s: string | null | undefined, sep: string): string {
  if (!s) return '';
  const v = FORMULA_START.test(s) ? `'${s}` : s;
  return v.includes(sep) || /["\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * All activities matching a list filter as CSV in the user's units and language. German files use ";" and a decimal
 * comma like spreadsheets in German locales expect; a UTF-8 byte order mark makes Excel read umlauts correctly.
 */
export function activitiesCsv(db: Db, athleteId: number, o: CsvOptions): string {
  const { sql, params } = listWhere(athleteId, o);
  const expr = SORT_EXPR[o.sort];
  const dir = o.order === 'asc' ? 'ASC' : 'DESC';
  const rows = all<
    WorkoutRow & { avg_power: number | null; avg_cadence: number | null; temperature_c: number | null; device: string | null }
  >(
    db,
    `SELECT ${SUMMARY_COLS}, avg_power, avg_cadence, temperature_c, device FROM workouts WHERE ${sql}
     ORDER BY (${expr}) IS NULL, ${expr} ${dir}, start_ts ${dir}, id ${dir}`,
    params,
  );
  const de = o.lang === 'de';
  const sep = de ? ';' : ',';
  const imperial = o.units === 'imperial';
  const num = (x: number | null | undefined, digits: number): string => {
    if (x === null || x === undefined || !Number.isFinite(x)) return '';
    const s = x.toFixed(digits);
    return de ? s.replace('.', ',') : s;
  };
  const head = headers(o.lang, o.units);
  const lines = [COLUMNS.map((c) => textCell(head[c], sep)).join(sep)];
  for (const r of rows) {
    const w = toSummary(r);
    const local = new Date((w.startTs + w.tzMin * 60) * 1000);
    const place = w.place
      ? w.placeEnd
        ? `${placeName(w.place, o.lang)} → ${placeName(w.placeEnd, o.lang)}`
        : placeName(w.place, o.lang)
      : '';
    const moving = w.movingS ?? w.durationS;
    const hasDistance = (w.distanceM ?? 0) > 0;
    const cell: Record<Column, string> = {
      id: String(w.id),
      date: `${local.getUTCFullYear()}-${P2(local.getUTCMonth() + 1)}-${P2(local.getUTCDate())}`,
      start: `${P2(local.getUTCHours())}:${P2(local.getUTCMinutes())}`,
      title: textCell(workoutTitle(w, o.lang), sep),
      sport: textCell(sportInfo(w.sport).label[o.lang], sep),
      place: textCell(place, sep),
      distance: hasDistance ? num(w.distanceM! / (imperial ? M_PER_MI : M_PER_KM), 2) : '',
      moving: clockDuration(moving),
      elapsed: clockDuration(w.elapsedS),
      pace: hasDistance ? paceText(w.avgSpeed, imperial) : '',
      speed: hasDistance && w.avgSpeed ? num(w.avgSpeed * (imperial ? 3600 / M_PER_MI : 3.6), 1) : '',
      elevation: w.hasRoute && w.elevationGainM !== null ? num(w.elevationGainM / (imperial ? M_PER_FT : 1), 0) : '',
      avgHr: num(w.avgHr, 0),
      maxHr: num(w.maxHr, 0),
      avgPower: num(r.avg_power, 0),
      cadence: num(r.avg_cadence, 0),
      energy: num(w.energyKcal, 0),
      effort: num(w.effort, 0),
      temperature: num(r.temperature_c === null ? null : imperial ? (r.temperature_c * 9) / 5 + 32 : r.temperature_c, 1),
      indoor: w.indoor ? (de ? 'ja' : 'yes') : de ? 'nein' : 'no',
      source: textCell([w.sourceName, r.device !== w.sourceName ? r.device : null].filter(Boolean).join(' · '), sep),
      notes: textCell(w.notes, sep),
    };
    lines.push(COLUMNS.map((c) => cell[c]).join(sep));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
