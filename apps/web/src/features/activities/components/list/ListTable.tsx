import { Link } from 'react-router';
import { EyeOff } from 'lucide-react';
import { sportInfo, workoutTitle, type ActivityListItem, type ActivitySort } from '@cadence/shared';
import { Badge, Table, TD, TH, cn } from '@/components/ui';
import { PlaceText } from '@/components/map/PlaceText';
import { WorkoutTags } from '@/components/WorkoutTags';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportIcon, sportColorVar, sportLabel } from '@/lib/sports';
import { shortDistanceParts, shownGain } from '../../lib/display';
import { MedalList } from '../MedalBadge';
import { Actions, type RowActions } from './RowActions';

function distanceText(w: ActivityListItem, fmt: ReturnType<typeof useFormat>): string {
  if (!w.distanceM || !sportInfo(w.sport).distance) return '–';
  if (w.sport === 'swim') {
    const p = shortDistanceParts(w.distanceM, fmt);
    return `${p.value} ${p.unit}`;
  }
  return fmt.distance(w.distanceM);
}

/** The list as a table (wide screens); the column headers sort it. */
export function ListTable({
  items,
  sort,
  order,
  onSort,
  actions,
}: {
  items: ActivityListItem[];
  sort: ActivitySort;
  order: 'asc' | 'desc';
  onSort: (s: ActivitySort) => void;
  actions: RowActions;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const th = (key: ActivitySort | null, label: string, numeric = true, className?: string) => (
    <TH
      className={className}
      numeric={numeric}
      onClick={key ? () => onSort(key) : undefined}
      sorted={key && sort === key ? order : null}
      title={key ? t('activities.list.sortBy', { column: label }) : undefined}
    >
      {label}
    </TH>
  );
  return (
    <Table>
      <thead>
        <tr>
          {th('start', t('activities.list.columns.date'), false)}
          {th(null, t('activities.list.columns.title'), false)}
          {th('distance', t('activities.list.columns.distance'))}
          {th('time', t('activities.list.columns.time'))}
          {th('pace', t('activities.list.columns.pace'))}
          {th('elevation', t('activities.list.columns.elevation'), true, 'hidden xl:table-cell')}
          {th('hr', t('activities.list.columns.hr'), true, 'hidden xl:table-cell')}
          {th('effort', t('activities.list.columns.effort'))}
          <TH numeric>
            <span className="sr-only">{t('activities.list.columns.actions')}</span>
          </TH>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => {
          const title = workoutTitle(w, lang);
          const info = sportInfo(w.sport);
          return (
            <tr key={w.id} className={cn('hover:bg-surface-2/60', w.hidden && 'opacity-60')}>
              <TD className="whitespace-nowrap">
                <div className="text-fg">{fmt.date(w.startTs, w.tzMin, 'dayShort')}</div>
                <div className="text-xs text-fg-3">
                  {fmt.date(w.startTs, w.tzMin, 'year')} · {fmt.time(w.startTs, w.tzMin)}
                </div>
              </TD>
              <TD className="w-full max-w-0 min-w-44">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="grid size-6 shrink-0 place-items-center rounded-full text-white"
                    style={{ background: sportColorVar(w.sport) }}
                    title={sportLabel(w.sport, lang)}
                  >
                    <SportIcon sport={w.sport} size={13} strokeWidth={2.25} />
                  </span>
                  <Link
                    to={`/activities/${w.id}`}
                    title={title}
                    className="truncate font-medium text-fg hover:text-accent-fg hover:underline"
                  >
                    {title}
                  </Link>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden pl-7.5 text-xs text-fg-3">
                  <span className="shrink-0">{sportLabel(w.sport, lang)}</span>
                  {w.place && (
                    <>
                      <span aria-hidden>·</span>
                      <PlaceText w={w} size={11} />
                    </>
                  )}
                  {w.hidden && <Badge icon={EyeOff} className="shrink-0">{t('activities.list.hiddenBadge')}</Badge>}
                </div>
                <WorkoutTags w={w} className="mt-1 pl-7.5" />
                {/* medals in their own line, so the place is never squeezed to its icon */}
                <MedalList medals={w.medals} sport={w.sport} max={1} className="mt-1 min-w-0 pl-7.5" />
              </TD>
              <TD numeric className="whitespace-nowrap">
                {distanceText(w, fmt)}
              </TD>
              <TD numeric className="whitespace-nowrap">
                {fmt.duration(w.movingS ?? w.durationS)}
              </TD>
              <TD numeric className="whitespace-nowrap">
                {info.speedMode !== 'none' && w.avgSpeed ? fmt.pace(w.avgSpeed, w.sport) : '–'}
              </TD>
              <TD numeric className="hidden whitespace-nowrap xl:table-cell">
                {shownGain(w) !== null ? fmt.elevation(shownGain(w)) : '–'}
              </TD>
              <TD numeric className="hidden xl:table-cell">
                {w.avgHr ? fmt.int(w.avgHr) : '–'}
              </TD>
              <TD numeric>
                {w.effort !== null ? (
                  <span title={w.effortEstimated ? t('common.estimated') : undefined}>
                    {fmt.int(w.effort)}
                    {w.effortEstimated && <span className="text-fg-3">*</span>}
                  </span>
                ) : (
                  '–'
                )}
              </TD>
              <TD numeric>
                <Actions w={w} a={actions} />
              </TD>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
