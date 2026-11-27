/**
 * Charts of the similar-efforts card (apps/web/src/features/activities/lib/similar.ts).
 */
import { describe, expect, it } from 'vitest';
import type { ChartTheme } from '@/components/charts/theme';
import { createFormatter } from '@/lib/format';
import { linearTrend, trendChart, type Pt } from '@/features/activities/lib/similar';

const fmt = createFormatter('metric', 'en-US', 'en');
const theme = { muted: '#888', fg: '#111', fg2: '#333', axis: '#ccc', grid: '#eee', other: '#999', accent: '#f60' } as unknown as ChartTheme;
const names = { others: 'Others', current: 'This activity', trend: 'Trend' };

type Formatter = (p: unknown) => string;

describe('similar efforts: trend chart', () => {
  // 20:30 in New York (UTC−4) on Jul 2 is already Jul 3 in UTC
  const evening = Date.UTC(2026, 6, 3, 0, 30);
  const pts: Pt[] = [
    { id: 1, x: Date.UTC(2026, 5, 1, 12), y: 300, current: false, title: 'June', tzMin: 120 },
    { id: 2, x: evening, y: 290, current: false, title: 'Evening run', tzMin: -240 },
    { id: 3, x: Date.UTC(2026, 7, 1, 23, 30), y: 280, current: true, title: 'Late run', tzMin: 120 },
  ];
  const option = trendChart(pts, theme, {
    inverse: true,
    format: (v) => String(v),
    names,
    dateLabel: (ms, tzMin) => fmt.date(ms / 1000, tzMin, 'day'),
  }) as { tooltip: { formatter: Formatter }; series: { name: string; data: unknown[][] }[] };
  const tip = (series: string, i: number) => {
    const s = option.series.find((x) => x.name === series)!;
    return option.tooltip.formatter({ data: s.data[i], seriesName: series, color: '#000' });
  };

  it('dates every point by its own local day', () => {
    expect(tip('Others', 1)).toContain('Jul 2, 2026');
    expect(tip('Others', 1)).not.toContain('Jul 3');
    // 23:30 UTC on Aug 1 is Aug 2 in Vienna (UTC+2)
    expect(tip('This activity', 0)).toContain('Aug 2, 2026');
  });

  it('dates the ends of the trend line like the activities there', () => {
    expect(tip('Trend', 0)).toContain('Jun 1, 2026');
    expect(tip('Trend', 1)).toContain('Aug 2, 2026');
  });

  it('fits the trend by least squares', () => {
    expect(linearTrend([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])).toEqual({ slope: 2, intercept: 1 });
    expect(linearTrend([{ x: 0, y: 1 }, { x: 1, y: 3 }])).toBeNull();
  });
});
