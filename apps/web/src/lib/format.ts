import { useMemo } from 'react';
import { M_PER_FT, M_PER_KM, M_PER_MI, KG_PER_LB, sportInfo, type Units } from '@cadence/shared';
import { useI18n, type Lang, type TFunction } from './i18n';
import { useSettings } from './settings';
import { browserTzAt, dayToDate, localDate } from './time';

/** Splits a formatted quantity into value + unit for stat tiles (value large, unit small). */
export interface Parts {
  value: string;
  unit: string;
}

export type DateStyle =
  | 'day' // 2. Nov. 2026 / Nov 2, 2026
  | 'dayShort' // 2. Nov. / Nov 2
  | 'weekday' // Montag, 2. November 2026
  | 'weekdayShort' // Mo., 2. Nov.
  | 'dateTime' // Mo., 2. Nov. 2026, 07:30
  | 'time' // 07:30
  | 'month' // November 2026
  | 'monthShort' // Nov.
  | 'monthYearShort' // Nov. 26
  | 'year'; // 2026

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  day: { day: 'numeric', month: 'short', year: 'numeric' },
  dayShort: { day: 'numeric', month: 'short' },
  weekday: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  weekdayShort: { weekday: 'short', day: 'numeric', month: 'short' },
  dateTime: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit' },
  month: { month: 'long', year: 'numeric' },
  monthShort: { month: 'short' },
  monthYearShort: { month: 'short', year: '2-digit' },
  year: { year: 'numeric' },
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string, style: DateStyle): Intl.DateTimeFormat {
  const k = `${locale}|${style}`;
  let f = dtfCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...DATE_STYLES[style], timeZone: 'UTC' });
    dtfCache.set(k, f);
  }
  return f;
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = `${locale}|${JSON.stringify(opts)}`;
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    nfCache.set(k, f);
  }
  return f;
}

/** Weekday and month names (formatters without a fixed date style). */
const namesCache = new Map<string, Intl.DateTimeFormat>();
function namesFormat(locale: string, opts: Pick<Intl.DateTimeFormatOptions, 'weekday' | 'month'>): Intl.DateTimeFormat {
  const k = `${locale}|${opts.weekday ?? ''}|${opts.month ?? ''}`;
  let f = namesCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' });
    namesCache.set(k, f);
  }
  return f;
}

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();
function rtf(locale: string): Intl.RelativeTimeFormat {
  let f = rtfCache.get(locale);
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    rtfCache.set(locale, f);
  }
  return f;
}

const two = (n: number) => (n < 10 ? `0${n}` : String(n));

/** 0 for a value that shows as zero at `digits` decimals: Intl keeps the sign of -0.3 ("-0 °C"), zero has none. */
const unsignedZero = (v: number, digits: number) => (Math.round(Math.abs(v) * 10 ** digits) === 0 ? 0 : v);

/** 3725 → "1:02:05", 725 → "12:05" */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '–';
  const s = Math.round(Math.abs(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const sign = seconds < 0 && s > 0 ? '−' : '';
  return h > 0 ? `${sign}${h}:${two(m)}:${two(sec)}` : `${sign}${m}:${two(sec)}`;
}

export function createFormatter(units: Units, locale: string, lang: Lang) {
  const imperial = units === 'imperial';
  const num = (v: number, digits = 0) =>
    nf(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(unsignedZero(v, digits));

  const distanceUnit = imperial ? 'mi' : 'km';
  const distanceValue = (m: number) => m / (imperial ? M_PER_MI : M_PER_KM);
  const distanceDigits = (v: number) => (v >= 1000 ? 0 : v >= 100 ? 1 : 2);

  const f = {
    units,
    locale,
    lang,
    num,
    int: (v: number) => num(Math.round(v)),
    compact: (v: number) => nf(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(unsignedZero(v, 1)),
    pct: (fraction: number, digits = 0) =>
      nf(locale, { style: 'percent', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(
        unsignedZero(fraction * 100, digits) === 0 ? 0 : fraction,
      ),
    signed: (v: number, digits = 0) => {
      // decide the sign on the rounded value, so 0.04 → "±0.0" and not "+0.0"
      const r = Math.round(v * 10 ** digits) / 10 ** digits;
      return (r > 0 ? '+' : r < 0 ? '−' : '±') + num(Math.abs(r), digits);
    },

    // ---- distance ---------------------------------------------------------
    distanceUnit,
    distanceValue,
    distanceParts(m: number | null | undefined, digits?: number): Parts {
      if (m == null || !Number.isFinite(m)) return { value: '–', unit: distanceUnit };
      const v = distanceValue(m);
      return { value: num(v, digits ?? distanceDigits(v)), unit: distanceUnit };
    },
    distance(m: number | null | undefined, digits?: number): string {
      const p = f.distanceParts(m, digits);
      return p.value === '–' ? '–' : `${p.value} ${p.unit}`;
    },
    /** Short distances in m / yd (swims, intervals). */
    shortDistance(m: number | null | undefined): string {
      if (m == null) return '–';
      return imperial ? `${num(m / 0.9144)} yd` : `${num(m)} m`;
    },
    elevationParts(m: number | null | undefined): Parts {
      if (m == null || !Number.isFinite(m)) return { value: '–', unit: imperial ? 'ft' : 'm' };
      return imperial ? { value: num(m / M_PER_FT), unit: 'ft' } : { value: num(m), unit: 'm' };
    },
    elevation(m: number | null | undefined): string {
      const p = f.elevationParts(m);
      return p.value === '–' ? '–' : `${p.value} ${p.unit}`;
    },

    // ---- time -------------------------------------------------------------
    duration: (s: number | null | undefined) => (s == null ? '–' : clock(s)),
    /** 3725 → "1h 2m" (en) / "1 Std. 2 Min." (de) */
    durationShort(s: number | null | undefined): string {
      if (s == null || !Number.isFinite(s)) return '–';
      const t = Math.round(s);
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      if (lang === 'de') {
        if (h > 0) return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
        return m > 0 ? `${m} Min.` : `${t} Sek.`;
      }
      if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
      return m > 0 ? `${m}m` : `${t}s`;
    },
    /** Hours with one decimal for totals ("123.4 h"). */
    hours: (s: number) => `${num(s / 3600, s >= 360_000 ? 0 : 1)} h`,

    // ---- speed / pace -----------------------------------------------------
    /** Pace or speed depending on the sport ("5:12 /km", "1:45 /100m", "25.3 km/h"). */
    paceParts(mps: number | null | undefined, sport = 'run'): Parts {
      const mode = sportInfo(sport).speedMode;
      if (mps == null || !Number.isFinite(mps) || mps <= 0.05) {
        return { value: '–', unit: mode === 'speed' ? (imperial ? 'mph' : 'km/h') : imperial ? '/mi' : '/km' };
      }
      if (mode === 'pace') {
        return { value: clock((imperial ? M_PER_MI : M_PER_KM) / mps), unit: imperial ? '/mi' : '/km' };
      }
      if (mode === 'pace100') {
        return { value: clock((imperial ? 91.44 : 100) / mps), unit: imperial ? '/100yd' : '/100m' };
      }
      return f.speedParts(mps);
    },
    pace(mps: number | null | undefined, sport = 'run'): string {
      const p = f.paceParts(mps, sport);
      return p.value === '–' ? '–' : `${p.value} ${p.unit}`;
    },
    speedParts(mps: number | null | undefined): Parts {
      if (mps == null || !Number.isFinite(mps)) return { value: '–', unit: imperial ? 'mph' : 'km/h' };
      return imperial ? { value: num(mps / (M_PER_MI / 3600), 1), unit: 'mph' } : { value: num(mps * 3.6, 1), unit: 'km/h' };
    },
    speed(mps: number | null | undefined): string {
      const p = f.speedParts(mps);
      return p.value === '–' ? '–' : `${p.value} ${p.unit}`;
    },
    /** Seconds per km/mi as plain number (for charts). */
    paceSeconds: (mps: number) => (imperial ? M_PER_MI : M_PER_KM) / mps,

    // ---- body & physiology ------------------------------------------------
    hr: (bpm: number | null | undefined) => (bpm == null ? '–' : `${num(Math.round(bpm))} bpm`),
    energy: (kcal: number | null | undefined) => (kcal == null ? '–' : `${num(Math.round(kcal))} kcal`),
    power: (w: number | null | undefined) => (w == null ? '–' : `${num(Math.round(w))} W`),
    cadence: (spm: number | null | undefined, sport = 'run') =>
      spm == null ? '–' : `${num(Math.round(spm))} ${sportInfo(sport).group === 'cycle' ? 'rpm' : 'spm'}`,
    temperature: (c: number | null | undefined) =>
      c == null ? '–' : imperial ? `${num((c * 9) / 5 + 32)} °F` : `${num(c)} °C`,
    weight: (kg: number | null | undefined) =>
      kg == null ? '–' : imperial ? `${num(kg / KG_PER_LB, 1)} lb` : `${num(kg, 1)} kg`,

    // ---- dates ------------------------------------------------------------
    /** Format a timestamp in the local time of the activity/record (`tzMin`). */
    date: (ts: number, tzMin: number, style: DateStyle = 'day') => dtf(locale, style).format(localDate(ts, tzMin)),
    /**
     * Format a timestamp that has no time zone of its own (import jobs, sync times, first/last record of a type) in
     * the browser's time zone, with the offset in force at that instant.
     */
    browserDate: (ts: number, style: DateStyle = 'dateTime') => dtf(locale, style).format(localDate(ts, browserTzAt(ts))),
    time: (ts: number, tzMin: number) => dtf(locale, 'time').format(localDate(ts, tzMin)),
    /** Format a 'YYYY-MM-DD' day key. */
    day: (day: string, style: DateStyle = 'day') => dtf(locale, style).format(dayToDate(day)),
    /** "vor 3 Tagen" / "3 days ago" */
    relative(ts: number): string {
      const f = rtf(locale);
      const diff = ts - Date.now() / 1000;
      const abs = Math.abs(diff);
      if (abs < 3600) return f.format(Math.round(diff / 60), 'minute');
      if (abs < 86_400) return f.format(Math.round(diff / 3600), 'hour');
      if (abs < 7 * 86_400) return f.format(Math.round(diff / 86_400), 'day');
      if (abs < 30 * 86_400) return f.format(Math.round(diff / (7 * 86_400)), 'week');
      if (abs < 365 * 86_400) return f.format(Math.round(diff / (30.44 * 86_400)), 'month');
      return f.format(Math.round(diff / (365.25 * 86_400)), 'year');
    },
    /** Localized weekday names starting at `weekStart` (short). */
    weekdayNames(weekStart: 0 | 1 = 1, style: 'short' | 'narrow' | 'long' = 'short'): string[] {
      const fmt = namesFormat(locale, { weekday: style });
      // 2024-01-07 is a Sunday
      return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 7 + ((i + weekStart) % 7)))));
    },
    monthNames(style: 'short' | 'long' = 'short'): string[] {
      const fmt = namesFormat(locale, { month: style });
      return Array.from({ length: 12 }, (_, i) => fmt.format(new Date(Date.UTC(2024, i, 1))));
    },
  };
  return f;
}

export type Formatter = ReturnType<typeof createFormatter>;

/** Formatter bound to the user's units and locale. */
export function useFormat(): Formatter {
  const { locale, lang } = useI18n();
  const { settings } = useSettings();
  return useMemo(() => createFormatter(settings.units, locale, lang), [settings.units, locale, lang]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Speed and pace on charts and in comparisons (progress trends, route and segment efforts, the compare pages): one rule
// for which sports show a pace, and one conversion into the numbers a chart axis shows.

/**
 * A sport's speed values read as a pace (min/km, min/100 m): the rule of fmt.pace and speedFormat. Every other sport
 * (ride, nordic ski, golf …) shows km/h or mph.
 */
export function showsPace(sport: string): boolean {
  const mode = sportInfo(sport).speedMode;
  return mode === 'pace' || mode === 'pace100';
}

/** i18n key of a sport's speed label: "Pace" over paces, "Speed" over km/h or mph. */
export const speedLabelKey = (sport: string): 'common.pace' | 'common.speed' =>
  showsPace(sport) ? 'common.pace' : 'common.speed';

/** Header or label of a sport's speed values: "Pace" or "Speed", as they are formatted. */
export function speedLabel(t: TFunction, sport: string): string {
  return t(speedLabelKey(sport));
}

/** Meters per pace unit: 100 m / 100 yd for swims (pace100), else 1 km / 1 mi. */
export function paceUnitM(sport: string, units: Units): number {
  const imperial = units === 'imperial';
  if (sportInfo(sport).speedMode === 'pace100') return imperial ? 91.44 : 100;
  return imperial ? M_PER_MI : M_PER_KM;
}

/**
 * The number a chart shows for a speed (m/s), in the unit of fmt.paceParts(·, sport): seconds per km / mi (per
 * 100 m / 100 yd for swims) for pace sports, km/h or mph otherwise. No guard: a pace of 0 m/s is Infinity.
 */
export function speedChartValue(mps: number, sport: string, units: Units): number {
  if (showsPace(sport)) return paceUnitM(sport, units) / mps;
  return units === 'imperial' ? mps / (M_PER_MI / 3600) : mps * 3.6;
}

/** How a chart shows a metric: axis value and tick, value with unit, signed difference. */
export interface TrendFormat {
  /** Canonical value → chart value. */
  toChart: (v: number) => number;
  /** Chart value → axis tick label. */
  axisLabel: (n: number) => string;
  /** Canonical value → text with unit. */
  format: (v: number) => string;
  /** Short unit for axis names. */
  unit: string;
  /** Pace axes run inverted so that faster is up. */
  inverse: boolean;
  /** Signed difference between two canonical values, e.g. '−0:12 /km', '+3 bpm'. */
  delta: (from: number, to: number) => string;
}

/** A metric shown as a plain number: `scale` × the canonical value with `digits` decimals and `unit`. */
export function numberFormat(fmt: Formatter, unit: string, digits: number, scale = 1): TrendFormat {
  const withUnit = (s: string) => (unit ? `${s} ${unit}` : s);
  return {
    toChart: (v) => v * scale,
    axisLabel: (n) => fmt.num(n, digits),
    format: (v) => withUnit(fmt.num(v * scale, digits)),
    unit,
    inverse: false,
    // fmt.signed decides the sign on the rounded value: no "+0.0" / "−0" for tiny differences
    delta: (a, b) => withUnit(fmt.signed((b - a) * scale, digits)),
  };
}

/** Speed metric of a sport: pace (min/km, min/100 m) or speed (km/h, mph). */
export function speedFormat(fmt: Formatter, sport: string): TrendFormat {
  const toChart = (v: number) => speedChartValue(v, sport, fmt.units);
  // km/h and mph are proportional to the speed
  if (!showsPace(sport)) return numberFormat(fmt, fmt.units === 'imperial' ? 'mph' : 'km/h', 1, toChart(1));
  const unit = fmt.paceParts(1, sport).unit;
  return {
    toChart,
    axisLabel: (n) => clock(n),
    format: (v) => fmt.pace(v, sport),
    unit,
    inverse: true,
    delta: (a, b) => {
      const d = Math.round(toChart(b) - toChart(a));
      return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${clock(Math.abs(d))} ${unit}`;
    },
  };
}
