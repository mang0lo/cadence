import { useMemo } from 'react';
import { Smartphone } from 'lucide-react';
import type { MetricSources } from '@cadence/shared';
import { useChartTheme } from '@/components/charts/theme';
import { Card, CardHeader, ErrorState, Skeleton, Table, TD, TH } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { assignSlots } from '../../lib/colors';

const browserTz = () => -new Date().getTimezoneOffset();
const MAX_SEGMENTS = 6;

/** Which sources / devices wrote the samples of a type: thin segmented share bar + table (swatches replace a legend). */
export function SourcesCard({ type, fromDay, toDay, enabled = true }: { type: string; fromDay?: string; toDay?: string; enabled?: boolean }) {
  const t = useT();
  const fmt = useFormat();
  const theme = useChartTheme();
  const q = useApi<MetricSources>(['health', 'metric', 'sources'], '/health/metric/sources', { type, fromDay, toDay }, { enabled });
  const d = q.data && q.data.type === type ? q.data : null;

  const model = useMemo(() => {
    if (!d) return null;
    const slots = assignSlots(d.sources.map((s) => s.name));
    const colorOf = (name: string) => `var(--series-${slots.get(name) ?? 1})`;
    const top = d.sources.slice(0, MAX_SEGMENTS);
    const restCount = d.sources.slice(MAX_SEGMENTS).reduce((n, s) => n + s.count, 0);
    const segments = [
      ...top.map((s) => ({ name: s.name, count: s.count, color: colorOf(s.name) })),
      ...(restCount ? [{ name: t('health.metric.sources.other'), count: restCount, color: 'var(--series-other)' }] : []),
    ];
    return { colorOf, segments };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, theme, t]);

  return (
    <Card>
      <CardHeader title={t('health.metric.sources.title')} subtitle={t('health.metric.sources.subtitle')} icon={Smartphone} />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        <Skeleton className="h-24 w-full" />
      ) : d.sources.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-3">{t('health.metric.sources.none')}</p>
      ) : (
        <div className={q.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <div
            className="mb-4 flex h-2 w-full gap-[2px] overflow-hidden rounded-full"
            role="img"
            aria-label={model!.segments.map((s) => `${s.name}: ${fmt.pct(s.count / d.total, 1)}`).join(', ')}
          >
            {model!.segments.map((s) => (
              <span key={s.name} title={`${s.name} · ${fmt.pct(s.count / d.total, 1)}`} style={{ width: `${(s.count / d.total) * 100}%`, background: s.color }} />
            ))}
          </div>
          <Table>
            <thead>
              <tr>
                <TH>{t('health.metric.sources.name')}</TH>
                <TH className="hidden md:table-cell">{t('health.metric.sources.devices')}</TH>
                <TH numeric>{t('health.metric.sources.samples')}</TH>
                <TH numeric>{t('health.metric.sources.share')}</TH>
                <TH className="hidden sm:table-cell">{t('health.metric.sources.first')}</TH>
                <TH className="hidden sm:table-cell">{t('health.metric.sources.last')}</TH>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.sourceId}>
                  <TD className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-2 font-medium text-fg">
                      <span
                        className="inline-block size-2.5 shrink-0 rounded-[3px]"
                        style={{ background: model!.segments.some((x) => x.name === s.name) ? model!.colorOf(s.name) : 'var(--series-other)' }}
                        aria-hidden
                      />
                      {s.name}
                    </span>
                  </TD>
                  <TD className="hidden w-full max-w-0 truncate text-xs text-fg-3 md:table-cell">
                    <span title={s.devices.join(', ')}>{s.devices.join(', ') || '–'}</span>
                  </TD>
                  <TD numeric>{fmt.int(s.count)}</TD>
                  <TD numeric>{fmt.pct(s.count / d.total, 1)}</TD>
                  <TD className="hidden whitespace-nowrap text-xs sm:table-cell">{fmt.date(s.firstTs, browserTz(), 'day')}</TD>
                  <TD className="hidden whitespace-nowrap text-xs sm:table-cell">{fmt.date(s.lastTs, browserTz(), 'day')}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
