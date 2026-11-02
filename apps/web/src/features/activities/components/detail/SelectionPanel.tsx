import { useMemo } from 'react';
import { Scissors, X } from 'lucide-react';
import { Button, Card, CardHeader } from '@/components/ui';
import { clock, useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { isPaceSport } from '../../lib/display';
import { rangeStats, type Prepared } from '../../lib/streams';

/** Stats of the section selected on the charts (or picked from splits, laps, climbs, efforts). */
export function SelectionPanel({
  P,
  sport,
  selection,
  onClear,
}: {
  P: Prepared;
  sport: string;
  selection: [number, number];
  onClear: () => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const s = useMemo(() => rangeStats(P, selection[0], selection[1], sport), [P, selection, sport]);
  const pace = isPaceSport(sport);
  const items: [string, string][] = [];
  if (s.distanceM !== null) items.push([t('common.distance'), fmt.distance(s.distanceM)]);
  items.push([t('activities.stats.moving'), fmt.duration(s.movingS)]);
  if (s.elapsedS - s.movingS >= 5) items.push([t('activities.stats.elapsed'), fmt.duration(s.elapsedS)]);
  if (s.avgSpeed) items.push([pace ? t('activities.stats.avgPace') : t('activities.stats.avgSpeed'), fmt.pace(s.avgSpeed, sport)]);
  if (s.gapSpeed && pace) items.push([t('activities.stats.gap'), fmt.pace(s.gapSpeed, sport)]);
  if (s.avgHr) items.push([t('common.avgHr'), fmt.hr(s.avgHr)]);
  if (s.maxHr) items.push([t('activities.selection.maxHr'), fmt.hr(s.maxHr)]);
  if (s.gainM !== null) items.push([t('activities.selection.gain'), fmt.elevation(s.gainM)]);
  if (s.lossM !== null) items.push([t('activities.selection.loss'), fmt.elevation(s.lossM)]);
  if (s.avgGrade !== null) items.push([t('activities.selection.avgGrade'), `${fmt.num(s.avgGrade * 100, 1)} %`]);
  if (s.avgCadence) items.push([t('activities.stats.avgCadence'), fmt.cadence(s.avgCadence, sport)]);
  if (s.avgPower) items.push([t('activities.stats.avgPower'), fmt.power(s.avgPower)]);
  const from = P.dist ? fmt.distance(P.dist[s.i0]!) : clock(P.t[s.i0]!);
  const to = P.dist ? fmt.distance(P.dist[s.i1]!) : clock(P.t[s.i1]!);
  return (
    <Card className="border-accent/40">
      <CardHeader
        title={t('activities.selection.title')}
        subtitle={t('activities.selection.range', { from, to })}
        icon={Scissors}
        actions={
          <Button size="sm" variant="ghost" icon={X} onClick={onClear}>
            {t('activities.selection.clear')}
          </Button>
        }
      />
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6 gap-y-3">
        {items.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="truncate text-xs text-fg-3">{k}</dt>
            <dd className="whitespace-nowrap text-base font-semibold text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
