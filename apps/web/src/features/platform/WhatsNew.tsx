import { Suspense, useEffect } from 'react';
import { Link } from 'react-router';
import { HeartPulse, Sparkles } from 'lucide-react';
import { workoutTitle, type ImportJob, type ImportSummary } from '@cadence/shared';
import { Card, CardHeader } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { placeName } from '@/lib/places';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { featureModules } from '../registry';
import { markSummarySeen } from './whatsNewState';

/** "What's new" after an import: new activities by sport, the newest ones, and every feature's highlights. */
export function WhatsNewCard({ job }: { job: ImportJob & { stats: { summary: ImportSummary } } }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const s = job.stats.summary;
  useEffect(() => markSummarySeen(job.id), [job.id]);

  const range =
    s.fromDay && s.toDay
      ? s.fromDay === s.toDay
        ? fmt.day(s.fromDay, 'day')
        : `${fmt.day(s.fromDay, 'day')} – ${fmt.day(s.toDay, 'day')}`
      : null;
  const finished = job.finishedAt ? fmt.date(job.finishedAt, -new Date().getTimezoneOffset(), 'dateTime') : '';
  const sections = featureModules.flatMap((f) => {
    const items = s.highlights.filter((h) => h.feature === f.name);
    return f.whatsNew && items.length ? [{ name: f.name, Component: f.whatsNew, items }] : [];
  });

  return (
    <Card>
      <CardHeader title={t('platform.whatsNew.title')} subtitle={t('platform.whatsNew.subtitle', { date: finished })} icon={Sparkles} />
      {s.count === 0 ? (
        <p className="text-sm text-fg-2">
          {t('platform.whatsNew.nothing')}
          {job.stats.recordsInserted > 0 && (
            <span className="text-fg-3"> {t('platform.whatsNew.healthRecords', { count: fmt.int(job.stats.recordsInserted) })}</span>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-base font-semibold text-fg">
              {t(s.initial ? 'platform.whatsNew.initial' : 'platform.whatsNew.activities', { count: s.count, n: fmt.int(s.count) })}
            </p>
            <p className="text-sm text-fg-3">
              {[range, job.stats.recordsInserted > 0 ? t('platform.whatsNew.healthRecords', { count: fmt.int(job.stats.recordsInserted) }) : null]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <ul className="mt-3 flex flex-wrap gap-2" aria-label={t('platform.whatsNew.bySport')}>
              {s.sports.slice(0, 8).map((x) => (
                <li key={x.sport} className="inline-flex items-center gap-2 rounded-control border border-border bg-surface-2 px-2.5 py-1.5 text-xs">
                  <span className="grid size-5 place-items-center rounded-full text-white" style={{ background: sportColorVar(x.sport) }}>
                    <SportIcon sport={x.sport} size={11} strokeWidth={2.5} />
                  </span>
                  <span className="font-medium text-fg">
                    {x.count} × {sportLabel(x.sport, lang)}
                  </span>
                  <span className="tabular text-fg-3">
                    {x.distanceM > 0 ? `${fmt.distance(x.distanceM)} · ` : ''}
                    {fmt.durationShort(x.movingS)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {!s.initial && s.latest.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-3">{t('platform.whatsNew.latest')}</h3>
              <ul className="divide-y divide-border">
                {s.latest.map((w) => (
                  <li key={w.id}>
                    <Link to={`/activities/${w.id}`} className="group flex items-center gap-3 py-2">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full text-white" style={{ background: sportColorVar(w.sport) }}>
                        <SportIcon sport={w.sport} size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-fg group-hover:text-accent-fg group-hover:underline">
                          {workoutTitle(w, lang)}
                        </span>
                        <span className="block truncate text-xs text-fg-3">
                          {fmt.date(w.startTs, w.tzMin, 'dateTime')}
                          {w.place ? ` · ${placeName(w.place, lang)}` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-sm tabular text-fg-2">
                        {w.distanceM ? fmt.distance(w.distanceM) : fmt.duration(w.movingS)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sections.map(({ name, Component, items }) => (
            <Suspense key={name} fallback={null}>
              <Component items={items} />
            </Suspense>
          ))}

          {!s.initial && !sections.length && (
            <p className="flex items-center gap-2 text-xs text-fg-3">
              <HeartPulse size={14} aria-hidden />
              {t('platform.whatsNew.noHighlights')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
