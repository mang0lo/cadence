/**
 * Distance axis of the segment elevation profile (apps/web/src/features/maps/lib/segments.ts). ECharts steps the axis
 * by 1, 2, 3 or 5 × 10ⁿ; one decimal turned the 0.03 km steps of a 150 m segment into '0.0, 0.0, 0.1, 0.1, 0.1 km'.
 */
import { describe, expect, it } from 'vitest';
import * as echarts from 'echarts';
import { number } from 'echarts';
import { grid, valueAxis } from '@/components/charts/options';
import type { ChartTheme } from '@/components/charts/theme';
import { createFormatter } from '@/lib/format';
import { distanceAxisDigits, distanceAxisLabel } from '@/features/maps/lib/segments';

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

/**
 * The distance labels ECharts shows on the profile (the page's axis settings, rendered to SVG): with a fixed max the
 * axis also labels its end, the segment's length, unless that label overlaps the last step's.
 */
function shownLabels(max: number, format: (v: number) => string, width: number): string[] {
  const theme = { muted: '#888', grid: '#eee', axis: '#ccc' } as ChartTheme;
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height: 240 });
  chart.setOption({
    animation: false,
    grid: grid({ top: 12, right: 30 }),
    xAxis: valueAxis(theme, { min: 0, max, axisLabel: { fontSize: 11, formatter: format } }),
    yAxis: valueAxis(theme, { scale: true }),
    series: [{ type: 'line', data: [[0, 100], [max / 2, 120], [max, 110]] }],
  });
  const svg = chart.renderToSVGString();
  chart.dispose();
  return [...svg.matchAll(/>([^<>]* (?:km|mi))</g)].map((m) => m[1]!);
}

describe('segment profile distance axis end', () => {
  it('labels the segment length apart from the last step (4.4 km read "4 km, 4 km")', () => {
    for (const units of ['metric', 'imperial'] as const) {
      const fmt = createFormatter(units, 'en-US', 'en');
      for (const m of [104, 150, 436, 543, 2_300, 4_400, 5_400, 6_300, 7_100, 9_400, 12_300, 16_600, 42_195]) {
        const max = fmt.distanceValue(m);
        for (const width of [340, 760]) {
          const labels = shownLabels(max, distanceAxisLabel(fmt, max), width);
          expect(new Set(labels).size, `${units} ${m} m @${width}px: ${labels.join(', ')}`).toBe(labels.length);
        }
      }
    }
  });

  it('gives the end one decimal more than the steps, unless it is on a step', () => {
    const fmt = createFormatter('metric', 'en-US', 'en');
    expect(shownLabels(4.4, distanceAxisLabel(fmt, 4.4), 760)).toEqual(['0 km', '1 km', '2 km', '3 km', '4 km', '4.4 km']);
    expect(shownLabels(0.436, distanceAxisLabel(fmt, 0.436), 760).slice(-2)).toEqual(['0.4 km', '0.44 km']);
    expect(shownLabels(0.15, distanceAxisLabel(fmt, 0.15), 760).slice(-2)).toEqual(['0.12 km', '0.15 km']);
    const de = createFormatter('metric', 'de-DE', 'de');
    expect(distanceAxisLabel(de, 5.4)(5.4)).toBe('5,4 km');
  });
});
