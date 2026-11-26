/**
 * Formatting of health values for the UI: catalogue names (en/de), unit conversion (metric/imperial,
 * fractions → %, minutes → h:mm) and signed deltas. Built on the shared catalogue + `useFormat()`.
 */
import { useMemo } from 'react';
import {
  autoDigits,
  categoryValueLabel,
  displaySpec,
  metricGood,
  metricName,
  roundTo,
  splitMetric,
  type DisplaySpec,
  type GoodDirection,
} from '@cadence/shared';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';

export interface ValueParts {
  value: string;
  unit: string;
}

/**
 * A duration as `fmt.durationShort` writes it, split into number + unit pairs ("6 Std. 53 Min." → 6 Std., 53 Min.;
 * "6h 53m" → 6 h, 53 m), so a tile can show the numbers large and the units small. Text without numbers stays whole.
 */
export function durationParts(text: string): ValueParts[] {
  const pairs = [...text.matchAll(/(\d+)\s*([^\d\s]+)/g)].map((p) => ({ value: p[1]!, unit: p[2]! }));
  return pairs.length ? pairs : [{ value: text, unit: '' }];
}

export interface DeltaInfo {
  /** Rounded signed change in display units – decides arrow direction and color. */
  value: number;
  /** "+2 bpm", "−0.4 %", "+0:32" */
  text: string;
}

export function useMetricFormat() {
  const { lang } = useI18n();
  const { settings } = useSettings();
  const fmt = useFormat();

  return useMemo(() => {
    const units = settings.units;

    const spec = (metric: string, unit?: string | null, maxAbs?: number): DisplaySpec =>
      displaySpec(splitMetric(metric).identifier, unit, units, maxAbs);

    /** Display value (number) for charts and tables. */
    const toDisplay = (metric: string, v: number, unit?: string | null, maxAbs?: number): number =>
      spec(metric, unit, maxAbs).convert(v);

    const digitsFor = (s: DisplaySpec, shown: number) => s.digits ?? autoDigits(shown);

    const parts = (metric: string, v: number | null | undefined, unit?: string | null, maxAbs?: number): ValueParts => {
      if (v === null || v === undefined || !Number.isFinite(v)) return { value: '–', unit: spec(metric, unit, maxAbs).unit };
      const s = spec(metric, unit, maxAbs);
      if (s.duration) return { value: fmt.durationShort(s.duration === 'minutes' ? v * 60 : v), unit: '' };
      const shown = s.convert(v);
      return { value: fmt.num(shown, digitsFor(s, shown)), unit: s.unit };
    };

    const value = (metric: string, v: number | null | undefined, unit?: string | null, maxAbs?: number): string => {
      const p = parts(metric, v, unit, maxAbs);
      return p.value === '–' || !p.unit ? p.value : `${p.value} ${p.unit}`;
    };

    /** Number only (no unit), e.g. for table columns whose header carries the unit. */
    const plain = (metric: string, v: number | null | undefined, unit?: string | null, maxAbs?: number): string =>
      parts(metric, v, unit, maxAbs).value;

    const unitLabel = (metric: string, unit?: string | null, maxAbs?: number): string => spec(metric, unit, maxAbs).unit;

    /** Signed change as shown to the user; all conversions are affine, so the offset is dropped. */
    const delta = (metric: string, diff: number, unit?: string | null, maxAbs?: number): DeltaInfo => {
      const s = spec(metric, unit, maxAbs);
      if (s.duration) {
        const minutes = s.duration === 'minutes' ? diff : diff / 60;
        const r = Math.round(minutes);
        const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
        return { value: r, text: `${sign}${fmt.durationShort(Math.abs(r) * 60)}` };
      }
      const shown = s.convert(diff) - s.convert(0);
      // deltas are small: one more digit than the value when the value is shown as a whole number
      const base = s.digits ?? autoDigits(shown);
      const digits = base === 0 && Math.abs(shown) < 10 ? 1 : base;
      const r = roundTo(shown, digits);
      return { value: r, text: `${fmt.signed(r, digits)}${s.unit ? ` ${s.unit}` : ''}` };
    };

    /** Relative change, e.g. "+4 %". */
    const pctDelta = (fraction: number): DeltaInfo => {
      const r = roundTo(fraction * 100, 0);
      return { value: r, text: `${fmt.signed(r, 0)} %` };
    };

    return {
      lang,
      units,
      spec,
      toDisplay,
      parts,
      value,
      plain,
      unitLabel,
      delta,
      pctDelta,
      name: (metric: string) => metricName(metric, lang),
      good: (metric: string): GoodDirection => metricGood(metric),
      categoryLabel: (v: string) => categoryValueLabel(v, lang),
    };
  }, [lang, settings.units, fmt]);
}

export type MetricFormat = ReturnType<typeof useMetricFormat>;
