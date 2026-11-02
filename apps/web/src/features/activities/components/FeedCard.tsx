import { Link, useNavigate } from 'react-router';
import { EyeOff, MapPinOff } from 'lucide-react';
import { workoutTitle, type ActivityListItem } from '@cadence/shared';
import { RouteThumbnail } from '@/components/map/RouteThumbnail';
import { Badge, Card, Skeleton } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { keyStats } from '../lib/display';
import { MedalList } from './MedalBadge';
import { StatList } from './StatList';

/** One activity in the dashboard feed (Strava-style card). */
export function FeedCard({ w }: { w: ActivityListItem }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const navigate = useNavigate();
  const title = workoutTitle(w, lang);
  const href = `/activities/${w.id}`;
  return (
    <Card
      as="article"
      padded={false}
      className="cursor-pointer overflow-hidden transition-shadow hover:shadow-pop"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button')) return;
        navigate(href);
      }}
    >
      <div className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span
            className="grid size-10 shrink-0 place-items-center rounded-full text-white"
            style={{ background: sportColorVar(w.sport) }}
            title={sportLabel(w.sport, lang)}
          >
            <SportIcon sport={w.sport} size={19} strokeWidth={2.25} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-fg-3">
              {t('activities.feed.at', {
                date: fmt.date(w.startTs, w.tzMin, 'dateTime'),
                relative: fmt.relative(w.startTs),
              })}
            </div>
            <h3 className="mt-0.5 text-base font-semibold leading-snug text-fg">
              <Link to={href} className="hover:text-accent-fg hover:underline">
                {title}
              </Link>
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-3">
              <span>{sportLabel(w.sport, lang)}</span>
              {w.indoor && <MapPinOff size={12} aria-label={t('activities.feed.indoor')} />}
              {w.sourceName && (
                <>
                  <span aria-hidden>·</span>
                  <span className="truncate">{w.sourceName}</span>
                </>
              )}
              {w.hidden && (
                <Badge icon={EyeOff} className="ml-1">
                  {t('activities.feed.hidden')}
                </Badge>
              )}
            </div>
          </div>
        </div>
        {w.notes && <p className="mt-3 line-clamp-2 whitespace-pre-line text-sm text-fg-2">{w.notes}</p>}
        <StatList items={keyStats(w, fmt, t, 5)} className="mt-4" />
        {w.medals.length > 0 && <MedalList medals={w.medals} sport={w.sport} className="mt-3" />}
      </div>
      {w.polyline && (
        <Link to={href} aria-label={t('activities.feed.openActivity')} className="block border-t border-border">
          <RouteThumbnail
            polyline={w.polyline}
            width={640}
            height={220}
            strokeWidth={3}
            color={sportColorVar(w.sport)}
            className="h-auto w-full rounded-none"
            ariaLabel={title}
          />
        </Link>
      )}
    </Card>
  );
}

export function FeedCardSkeleton() {
  return (
    <Card>
      <div className="flex gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>
      <Skeleton className="mt-5 h-10 w-3/4" />
      <Skeleton className="mt-4 h-40 w-full" />
    </Card>
  );
}
