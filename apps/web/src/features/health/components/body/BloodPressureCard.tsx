import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, HeartPulse, OctagonAlert, type LucideIcon } from 'lucide-react';
import { classifyBloodPressure, mean, type BloodPressureCategory, type BloodPressureReading } from '@cadence/shared';
import { ChartCard } from '@/components/charts/ChartCard';
import { EChart } from '@/components/charts/EChart';
import { measureColor } from '@/components/charts/measures';
import { axisTooltip, grid, legend, lineSeries, timeAxis, tooltipHtml, valueAxis } from '@/components/charts/options';
import { useChartTheme } from '@/components/charts/theme';
import { Badge } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { LEGEND_LINE_ICON, dayAxisLabelUtc, numAxisLabel } from '../../lib/chart';

/** Status colors are only used together with an icon and a label (the badge text). */
const CATEGORY: Record<BloodPressureCategory, { tone: 'good' | 'warning' | 'critical'; icon: LucideIcon }> = {
  normal: { tone: 'good', icon: CheckCircle2 },
  elevated: { tone: 'warning', icon: CircleAlert },
  stage1: { tone: 'warning', icon: AlertTriangle },
  stage2: { tone: 'critical', icon: AlertTriangle },
  crisis: { tone: 'critical', icon: OctagonAlert },
};

export function BloodPressureBadge({ systolic, diastolic }: { systolic: number; diastolic: number }) {
  const t = useT();
  const cat = classifyBloodPressure(systolic, diastolic);
  const c = CATEGORY[cat];
  return (
    <Badge tone={c.tone} icon={c.icon}>
      {t(`health.body.bp.cat.${cat}`)}
    </Badge>
  );
}

/** Blood pressure readings (systolic / diastolic over time) with ACC/AHA categories in the table view and footer. */
export function BloodPressureCard({ readings, loading }: { readings: BloodPressureReading[]; loading?: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const sysColor = measureColor(theme, 'systolic');
  const diaColor = measureColor(theme, 'diastolic');
  const sysName = t('health.body.bp.systolic');
  const diaName = t('health.body.bp.diastolic');

  const option = useMemo(() => {
    const x = (r: BloodPressureReading) => (r.ts + r.tzMin * 60) * 1000;
    const symbols = readings.length <= 60;
    const sys = lineSeries(theme, sysName, readings.map((r) => [x(r), r.systolic]), sysColor, { showSymbol: symbols, symbolSize: 7 });
    const dia = lineSeries(theme, diaName, readings.map((r) => [x(r), r.diastolic]), diaColor, { showSymbol: symbols, symbolSize: 7 });
    return {
      useUTC: true,
      grid: grid({ top: 34 }),
      legend: legend(theme, 'line', { data: [sysName, diaName], ...LEGEND_LINE_ICON }),
      tooltip: axisTooltip(theme, (params) => {
        const p = (params as { dataIndex: number }[])[0];
        const r = p ? readings[p.dataIndex] : undefined;
        if (!r) return '';
        const rows = [
          { color: sysColor, label: sysName, value: `${fmt.int(r.systolic)} mmHg` },
          { color: diaColor, label: diaName, value: `${fmt.int(r.diastolic)} mmHg` },
        ];
        if (r.pulse !== null) rows.push({ color: theme.fg2, label: t('health.body.bp.pulse'), value: `${fmt.int(r.pulse)} bpm` });
        return tooltipHtml(fmt.date(r.ts, r.tzMin, 'dateTime'), rows, theme);
      }),
      xAxis: timeAxis(theme, { axisLabel: { color: theme.muted, fontSize: 11, hideOverlap: true, formatter: dayAxisLabelUtc(fmt) } }),
      yAxis: valueAxis(theme, { scale: true, axisLabel: { color: theme.muted, fontSize: 11, formatter: numAxisLabel(fmt) } }),
      series: [sys, dia],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readings, theme, fmt, sysColor, diaColor, sysName, diaName]);

  const latest = readings[readings.length - 1];
  const avgSys = mean(readings.map((r) => r.systolic));
  const avgDia = mean(readings.map((r) => r.diastolic));

  return (
    <ChartCard
      title={`${t('health.body.bp.title')} (mmHg)`}
      subtitle={t('health.body.bp.subtitle')}
      icon={HeartPulse}
      // rows only while the table view is open: up to thousands of readings, each with a badge
      table={
        readings.length
          ? () => ({
              columns: [
                { key: 'when', label: t('health.common.date') },
                { key: 'sys', label: sysName, numeric: true },
                { key: 'dia', label: diaName, numeric: true },
                { key: 'cat', label: t('health.body.bp.category') },
              ],
              rows: [...readings].reverse().map((r) => ({
                when: fmt.date(r.ts, r.tzMin, 'dateTime'),
                sys: fmt.int(r.systolic),
                dia: fmt.int(r.diastolic),
                cat: <BloodPressureBadge systolic={r.systolic} diastolic={r.diastolic} />,
              })),
            })
          : undefined
      }
      footer={
        latest ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="inline-flex items-center gap-2">
                {t('health.body.bp.latest')}{' '}
                <b className="font-semibold text-fg">
                  {fmt.int(latest.systolic)}/{fmt.int(latest.diastolic)} mmHg
                </b>
                <BloodPressureBadge systolic={latest.systolic} diastolic={latest.diastolic} />
                <span className="text-fg-3">{fmt.date(latest.ts, latest.tzMin, 'day')}</span>
              </span>
              {avgSys !== null && avgDia !== null && (
                <span>
                  {t('health.body.bp.average')}{' '}
                  <b className="font-semibold text-fg">
                    {fmt.int(avgSys)}/{fmt.int(avgDia)} mmHg
                  </b>{' '}
                  <span className="text-fg-3">({t('health.body.bp.readings', { count: readings.length })})</span>
                </span>
              )}
            </div>
            <div className="text-fg-3">{t('health.body.bp.hint')}</div>
          </div>
        ) : undefined
      }
    >
      {readings.length === 0 ? (
        <p className="py-10 text-center text-sm text-fg-3">{loading ? t('common.loading') : t('health.body.bp.none')}</p>
      ) : (
        <EChart option={option} height={250} ariaLabel={t('health.body.bp.title')} />
      )}
    </ChartCard>
  );
}
