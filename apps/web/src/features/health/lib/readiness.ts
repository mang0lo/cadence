/**
 * Readiness on the web: data hook, band styles (status color + icon + label, never color alone), factor icons and the
 * formatting of each signal's value, normal range and missing reason.
 */
import { useMemo } from 'react';
import {
  Activity,
  BatteryFull,
  BatteryLow,
  BatteryMedium,
  BatteryWarning,
  Clock3,
  Droplets,
  Dumbbell,
  HeartPulse,
  Moon,
  Thermometer,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import type {
  ReadinessBand,
  ReadinessDay,
  ReadinessFactor,
  ReadinessFactorKey,
  ReadinessModelInfo,
  ReadinessResponse,
} from '@cadence/shared';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useMetricFormat } from './metrics';
import { wrapMinutes } from './sleep';

const HRV = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN';
const RHR = 'HKQuantityTypeIdentifierRestingHeartRate';
const RESP = 'HKQuantityTypeIdentifierRespiratoryRate';
const WRIST = 'HKQuantityTypeIdentifierAppleSleepingWristTemperature';

/** Readiness of `day` (default: the latest day with data) and `days` days of history. */
export function useReadiness(day: string | undefined, days: number, enabled = true) {
  return useApi<ReadinessResponse>(
    ['health', 'readiness', day ?? 'latest', days],
    enabled ? '/health/readiness' : null,
    { day, days },
    { staleTime: 30_000 },
  );
}

export type BadgeTone = 'neutral' | 'good' | 'warning' | 'critical';

/** Status styling per band; `color` is a CSS color for the ring. */
export const BAND_STYLE: Record<ReadinessBand, { tone: BadgeTone; icon: LucideIcon; color: string }> = {
  ready: { tone: 'good', icon: BatteryFull, color: 'var(--good)' },
  normal: { tone: 'neutral', icon: BatteryMedium, color: 'var(--fg-3)' },
  easy: { tone: 'warning', icon: BatteryLow, color: 'var(--warning)' },
  recover: { tone: 'critical', icon: BatteryWarning, color: 'var(--critical)' },
};

export const FACTOR_ICON: Record<ReadinessFactorKey, LucideIcon> = {
  hrv: Activity,
  restingHr: HeartPulse,
  sleep: Moon,
  sleepTiming: Clock3,
  load: Dumbbell,
  respiratoryRate: Wind,
  wristTemp: Thermometer,
  spo2: Droplets,
};

/** Factor a reason code belongs to ('hrv.low' → hrv; 'capped' / 'allNormal' → null). */
export function reasonFactor(code: string): ReadinessFactorKey | null {
  const key = code.split('.')[0] as ReadinessFactorKey;
  return code.includes('.') ? key : null;
}

/** Direction of a reason for its icon: + better recovered, − strain, 0 neutral. */
export function reasonSign(day: ReadinessDay, code: string): -1 | 0 | 1 {
  if (code === 'allNormal') return 0;
  if (code === 'capped' || code === 'load.hardDay') return -1;
  const key = reasonFactor(code);
  const points = day.factors.find((f) => f.key === key)?.points ?? 0;
  return points > 0 ? 1 : points < 0 ? -1 : 0;
}

/** Text of a signal: name, measured value, normal range, explanation line, missing reason. */
export function useReadinessFormat() {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  return useMemo(() => {
    const k = (key: string, vars?: Record<string, string | number>) => t(`health.readiness.${key}`, vars);
    const clock = (min: number) => fmt.time(wrapMinutes(min) * 60, 0);
    /** Wrist temperature is shown as the change from the usual value (like the Health app). */
    const tempDelta = (v: number) => m.delta(WRIST, v).text;

    const value = (f: ReadinessFactor): string => {
      const v = f.value;
      if (v === null) return '–';
      switch (f.key) {
        case 'hrv':
          return m.value(HRV, v);
        case 'restingHr':
          return m.value(RHR, v);
        case 'sleep':
          return fmt.durationShort(v);
        case 'sleepTiming':
          return clock(v);
        case 'load':
          return fmt.num(v, 2);
        case 'respiratoryRate':
          return m.value(RESP, v);
        case 'wristTemp':
          return f.range ? tempDelta(v - f.range.mean) : m.value(WRIST, v);
        case 'spo2':
          return fmt.pct(v, 1);
      }
    };

    const range = (f: ReadinessFactor): string | null => {
      const r = f.range;
      if (!r) return null;
      switch (f.key) {
        case 'hrv':
          return `${m.plain(HRV, r.low)}–${m.value(HRV, r.high)}`;
        case 'restingHr':
          return `${m.plain(RHR, r.low)}–${m.value(RHR, r.high)}`;
        case 'sleep':
          return `${fmt.durationShort(r.low)} – ${fmt.durationShort(r.high)}`;
        case 'sleepTiming':
          return `${clock(r.low)}–${clock(r.high)}`;
        case 'load':
          return `${fmt.num(r.low, 2)}–${fmt.num(r.high, 2)}`;
        case 'respiratoryRate':
          return `${m.plain(RESP, r.low)}–${m.value(RESP, r.high)}`;
        case 'wristTemp':
          return `±${tempDelta((r.high - r.low) / 2).replace(/^[+−±]/, '')}`;
        case 'spo2':
          return `${fmt.num(r.low * 100, 1)}–${fmt.pct(r.high, 1)}`;
      }
    };

    const usual = (f: ReadinessFactor): string | null => {
      const r = f.range;
      if (!r || f.key === 'load' || f.key === 'wristTemp') return null;
      return value({ ...f, value: r.mean, range: null });
    };

    /** "usual 52 bpm · normal 51–54 bpm" (load: "balanced 0.70–1.30"). */
    const comparison = (f: ReadinessFactor): string | null => {
      const rangeText = range(f);
      if (!rangeText) return null;
      if (f.key === 'load') return k('factors.balanced', { range: rangeText });
      const u = usual(f);
      const n = k('factors.normal', { range: rangeText });
      return u ? `${k('factors.usual', { value: u })} · ${n}` : n;
    };

    const hint = (f: ReadinessFactor, day: string, model: ReadinessModelInfo): string => {
      const d = f.detail;
      switch (f.key) {
        case 'hrv':
          return d.today != null
            ? k('factors.hint.hrvToday', { days: model.hrvDays, value: m.value(HRV, d.today) })
            : k('factors.hint.hrv', { days: model.hrvDays });
        case 'restingHr':
          return f.valueDay && f.valueDay !== day ? k('factors.hint.restingHrYesterday') : k('factors.hint.restingHr');
        case 'sleepTiming': {
          const shift = Math.round(d.shiftMin ?? 0);
          if (Math.abs(shift) < 1) return k('factors.hint.sleepTiming');
          const text = k(shift > 0 ? 'factors.later' : 'factors.earlier', { min: fmt.int(Math.abs(shift)) });
          return k('factors.hint.sleepTimingShift', { shift: text });
        }
        case 'load':
          return d.ctl != null && d.atl != null && d.tsb != null
            ? k('factors.hint.load', { atl: fmt.int(d.atl), ctl: fmt.int(d.ctl), tsb: fmt.signed(d.tsb) })
            : '';
        case 'wristTemp':
          return f.range ? k('factors.hint.wristTemp', { value: m.value(WRIST, f.range.mean) }) : '';
        default:
          return k(`factors.hint.${f.key}`);
      }
    };

    const missing = (f: ReadinessFactor, model: ReadinessModelInfo): string => {
      switch (f.missing) {
        case 'never':
          return k('factors.missing.never');
        case 'baseline':
          return f.key === 'load'
            ? k('factors.missing.baselineLoad', { count: fmt.int(f.baselineDays), min: model.minLoadDays })
            : k('factors.missing.baseline', { count: fmt.int(f.baselineDays), min: model.minBaselineDays });
        case 'noValue':
          return k(`factors.missing.noValue.${f.key}`, { days: model.hrvDays });
        default:
          return k('factors.missing.available');
      }
    };

    return {
      name: (key: ReadinessFactorKey) => k(`factors.names.${key}`),
      band: (band: ReadinessBand) => k(`bands.${band}`),
      reason: (code: string) => k(`reasons.${code}`),
      value,
      range,
      comparison,
      hint,
      missing,
    };
  }, [t, fmt, m]);
}

export type ReadinessFormat = ReturnType<typeof useReadinessFormat>;
