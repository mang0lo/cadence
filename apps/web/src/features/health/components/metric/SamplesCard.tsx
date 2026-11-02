import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ListOrdered } from 'lucide-react';
import type { MetricSample, Page, RecordTypeInfo } from '@cadence/shared';
import { Card, CardHeader, ErrorState, IconButton, SegmentedControl, Skeleton, Table, TD, TH } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { localDate } from '@/lib/time';
import { useMetricFormat } from '../../lib/metrics';

const PAGE_SIZE = 50;

/** Wall-clock time with seconds ("14:03:27") in the locale of the user, for the local time of the sample. */
function useSecondsTime() {
  const { locale } = useI18n();
  return useMemo(() => {
    const f = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
    return (ts: number, tzMin: number) => f.format(localDate(ts, tzMin));
  }, [locale]);
}

/** Every record of a type in the selected range, newest first, 50 per page. */
export function SamplesCard({ type, fromDay, toDay }: { type: RecordTypeInfo; fromDay?: string; toDay?: string }) {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const time = useSecondsTime();
  const [page, setPage] = useState(0);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  // a new range or order starts on the first page
  useEffect(() => setPage(0), [type.identifier, fromDay, toDay, order]);

  const q = useApi<Page<MetricSample>>(['health', 'metric', 'samples'], '/health/metric/samples', {
    type: type.identifier,
    fromDay,
    toDay,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    order,
  });
  const d = q.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / PAGE_SIZE)) : 1;
  const isCategory = type.kind === 'category';
  const hasInterval = d?.items.some((s) => s.endTs - s.startTs >= 1) ?? false;

  return (
    <Card>
      <CardHeader
        title={t('health.metric.samples.title')}
        subtitle={t('health.metric.samples.subtitle')}
        icon={ListOrdered}
        actions={
          <SegmentedControl
            size="sm"
            label={t('health.metric.samples.order')}
            value={order}
            onChange={setOrder}
            items={[
              { value: 'desc', label: t('health.metric.samples.newest') },
              { value: 'asc', label: t('health.metric.samples.oldest') },
            ]}
          />
        }
      />
      {q.error ? (
        <ErrorState error={q.error} />
      ) : !d ? (
        <Skeleton className="h-64 w-full" />
      ) : d.items.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-3">{t('health.metric.samples.none')}</p>
      ) : (
        <div className={q.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <Table>
            <thead>
              <tr>
                <TH>{t('health.metric.samples.time')}</TH>
                {hasInterval && <TH className="hidden sm:table-cell">{t('health.metric.samples.end')}</TH>}
                <TH numeric>{t('health.metric.samples.value')}</TH>
                <TH className="hidden md:table-cell">{t('health.metric.samples.source')}</TH>
                <TH className="hidden xl:table-cell">{t('health.metric.samples.device')}</TH>
              </tr>
            </thead>
            <tbody>
              {d.items.map((s, i) => (
                <tr key={`${s.startTs}-${i}`}>
                  <TD className="whitespace-nowrap">
                    {fmt.date(s.startTs, s.tzMin, 'weekdayShort')} <span className="tabular text-fg">{time(s.startTs, s.tzMin)}</span>
                  </TD>
                  {hasInterval && (
                    <TD className="hidden whitespace-nowrap sm:table-cell">
                      {s.endTs - s.startTs >= 1 ? (
                        <>
                          {fmt.day(
                            new Date((s.endTs + s.tzMin * 60) * 1000).toISOString().slice(0, 10),
                            'dayShort',
                          )}{' '}
                          <span className="tabular text-fg">{time(s.endTs, s.tzMin)}</span>
                        </>
                      ) : (
                        '–'
                      )}
                    </TD>
                  )}
                  <TD numeric className="whitespace-nowrap font-medium text-fg">
                    {isCategory ? (s.text ? m.categoryLabel(s.text) : '–') : s.value === null ? (s.text ?? '–') : m.value(type.identifier, s.value, type.unit)}
                  </TD>
                  <TD className="hidden max-w-[220px] truncate md:table-cell">{s.source ?? '–'}</TD>
                  <TD className="hidden max-w-[220px] truncate text-xs text-fg-3 xl:table-cell">{s.device ?? '–'}</TD>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-3">
            <span className="tabular">
              {t('health.metric.samples.rows', {
                from: fmt.int(d.offset + 1),
                to: fmt.int(d.offset + d.items.length),
                total: fmt.int(d.total),
              })}
            </span>
            <span className="inline-flex items-center gap-1">
              <IconButton icon={ChevronLeft} label={t('health.metric.samples.prev')} disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="disabled:opacity-40" />
              <span className="tabular">{t('health.metric.samples.page', { page: fmt.int(page + 1), pages: fmt.int(pages) })}</span>
              <IconButton icon={ChevronRight} label={t('health.metric.samples.next')} disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-40" />
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
