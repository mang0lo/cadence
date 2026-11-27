import { describe, expect, it } from 'vitest';
import type { EChartsOption } from 'echarts';
import { axisNumberFormatter, chartLocale, localizeAxes, valueAxis } from '@/components/charts/options';
import type { ChartTheme } from '@/components/charts/theme';

const theme = { muted: '#888', grid: '#eee', axis: '#ccc' } as ChartTheme;
const de = axisNumberFormatter('de-DE');
const own = (v: number) => `${v} h`;
type Axis = { type?: string; axisLabel?: { formatter?: unknown; color?: string } };

describe('chart axes in the user language', () => {
  it('formats axis numbers like the rest of the app, with the decimals the tick has', () => {
    expect(de(12345)).toBe('12.345');
    expect(de(0.25)).toBe('0,25');
    expect(de(-0)).toBe('0');
    expect(de(-1e-7)).toBe('0');
    expect(de(-0.000001)).toBe('-0,000001');
    expect(de(1.5e6)).toBe('1.500.000');
    expect(axisNumberFormatter('en-US')(12345.5)).toBe('12,345.5');
  });

  it('gives value axes without a formatter of their own the user number format', () => {
    const option: EChartsOption = {
      xAxis: { type: 'time' },
      // no type: ECharts' y axis is a value axis
      yAxis: [{ axisLabel: { color: '#888' } }, valueAxis(theme, { axisLabel: { color: '#888', formatter: own } })],
    };
    const out = localizeAxes(option, de);
    const [y0, y1] = out.yAxis as Axis[];
    expect(y0!.axisLabel).toEqual({ color: '#888', formatter: de });
    expect(y1!.axisLabel!.formatter).toBe(own);
    expect((out.xAxis as Axis).axisLabel).toBeUndefined();
    // the caller's (memoised) option is left alone
    expect((option.yAxis as Axis[])[0]!.axisLabel).toEqual({ color: '#888' });
  });

  it('covers the builders, log axes and value x axes, but not category axes', () => {
    const out = localizeAxes(
      {
        xAxis: [{ type: 'value' }, { type: 'category', data: ['2025', '2026'] }, {}],
        yAxis: [valueAxis(theme), { type: 'log' }],
      },
      de,
    );
    const xs = out.xAxis as Axis[];
    expect(xs[0]!.axisLabel!.formatter).toBe(de);
    expect(xs[1]!.axisLabel).toBeUndefined();
    // no type and no data: ECharts makes it a value axis (x or y alike)
    expect(xs[2]!.axisLabel!.formatter).toBe(de);
    const ys = out.yAxis as Axis[];
    expect(ys[0]!.axisLabel).toMatchObject({ color: '#888', fontSize: 11, formatter: de });
    expect(ys[1]!.axisLabel!.formatter).toBe(de);
  });

  it('leaves the names of a category axis without a type alone (horizontal bars), they are no numbers', () => {
    // ECharts makes an axis with data a category axis: a number format would turn its labels into "NaN"
    const out = localizeAxes({ xAxis: { type: 'value' }, yAxis: { data: ['Laufen', 'Radfahren'] } }, de);
    expect((out.yAxis as Axis).axisLabel).toBeUndefined();
    expect((out.xAxis as Axis).axisLabel!.formatter).toBe(de);
  });

  it('names months and weekdays on time axes in the user language', () => {
    const l = chartLocale('de-DE');
    expect(l.time.monthAbbr[2]).toMatch(/^Mär/); // 'Mär' standing alone (ICU), 'März' in older data
    expect(l.time.month[11]).toBe('Dezember');
    expect(l.time.dayOfWeek[0]).toBe('Sonntag');
    expect(chartLocale('en-US').time.monthAbbr[2]).toBe('Mar');
    expect(chartLocale('en-US').time.dayOfWeekAbbr[1]).toBe('Mon');
  });
});
