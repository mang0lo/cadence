import { Link } from 'react-router';
import { EyeOff } from 'lucide-react';
import { workoutTitle, type ActivityListItem } from '@cadence/shared';
import { Badge, Card, cn } from '@/components/ui';
import { PlaceText } from '@/components/map/PlaceText';
import { WorkoutTags } from '@/components/WorkoutTags';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { keyStats } from '../../lib/display';
import { MedalList } from '../MedalBadge';
import { StatList } from '../StatList';
import { Actions, type RowActions } from './RowActions';

/** The list as cards (narrow screens). */
export function ListCards({ items, actions }: { items: ActivityListItem[]; actions: RowActions }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  return (
    <div className="grid gap-3">
      {items.map((w) => (
        <Card key={w.id} className={cn(w.hidden && 'opacity-60')}>
          <div className="flex items-start gap-3">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-full text-white"
              style={{ background: sportColorVar(w.sport) }}
              title={sportLabel(w.sport, lang)}
            >
              <SportIcon sport={w.sport} size={17} strokeWidth={2.25} />
            </span>
            <div className="min-w-0 flex-1">
              <Link to={`/activities/${w.id}`} className="block truncate font-semibold text-fg hover:text-accent-fg">
                {workoutTitle(w, lang)}
              </Link>
              <div className="flex min-w-0 items-center gap-x-1 text-xs text-fg-3">
                <span className="shrink-0">
                  {fmt.date(w.startTs, w.tzMin, 'dateTime')} · {sportLabel(w.sport, lang)}
                </span>
                {w.place && (
                  <>
                    <span aria-hidden>·</span>
                    <PlaceText w={w} size={11} />
                  </>
                )}
              </div>
            </div>
            <Actions w={w} a={actions} />
          </div>
          <StatList items={keyStats(w, fmt, t, 4)} size="sm" className="mt-3" />
          <WorkoutTags w={w} className="mt-3" />
          {(w.medals.length > 0 || w.hidden) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <MedalList medals={w.medals} sport={w.sport} max={3} />
              {w.hidden && <Badge icon={EyeOff}>{t('activities.list.hiddenBadge')}</Badge>}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
