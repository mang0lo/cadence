/**
 * Distance axis of the segment elevation profile (apps/web/src/features/maps/lib/segments.ts). ECharts steps the axis
 * by 1, 2, 3 or 5 × 10ⁿ; one decimal turned the 0.03 km steps of a 150 m segment into '0.0, 0.0, 0.1, 0.1, 0.1 km'.
 */
import { describe, expect, it } from 'vitest';
import { number } from 'echarts';
import { createFormatter } from '@/lib/format';
import { distanceAxisDigits } from '@/features/maps/lib/segments';

/** The labels ECharts puts on a value axis from 0 to `max` with 4 splits (valueAxis), formatted with `digits`. */
function axisLabels(max: number, format: (v: number) => string): string[] {
  const interval = number.nice(max / 4, true);
  const out: string[] = [];
  for (let k = 0; k * interval <= max + 1e-9; k++) out.push(format(number.round(k * interval, 10)));
  return out;
}

describe('segment profile distance axis', () => {
  it('gives every tick its own label, for the shortest segments as for long climbs', () => {
    for (const units of ['metric', 'imperial'] as const) {
      const fmt = createFormatter(units, 'en-US', 'en');
      for (const m of [100, 120, 150, 180, 200, 250, 280, 400, 750, 1_500, 4_000, 12_000, 42_000]) {
        const max = fmt.distanceValue(m);
        const labels = axisLabels(max, (v) => fmt.num(v, distanceAxisDigits(max)));
        expect(new Set(labels).size, `${units} ${m} m: ${labels.join(', ')}`).toBe(labels.length);
      }
    }
  });

  it('uses no more decimals than the steps need', () => {
    const fmt = createFormatter('metric', 'en-US', 'en');
    const labels = (m: number) => axisLabels(m / 1000, (v) => fmt.num(v, distanceAxisDigits(m / 1000)));
    expect(labels(150)).toEqual(['0.00', '0.03', '0.06', '0.09', '0.12', '0.15']);
    expect(labels(2_000)).toEqual(['0.0', '0.5', '1.0', '1.5', '2.0']);
    expect(labels(12_000)).toEqual(['0', '3', '6', '9', '12']);
  });
});
