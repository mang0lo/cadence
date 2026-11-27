import type { ActivityTotals } from '@cadence/shared';
import { Card, Stat, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/** Totals of everything matching the filters (all pages). */
export function Totals({ totals, dim }: { totals: ActivityTotals; dim: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const d = fmt.distanceParts(totals.distanceM, 0);
  const e = fmt.elevationParts(totals.elevationM);
  return (
    <Card className={cn('mb-4 transition-opacity', dim && 'opacity-60')} aria-label={t('activities.list.totals')}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat size="sm" label={t('activities.athlete.count')} value={fmt.int(totals.count)} />
        {totals.distanceM > 0 && <Stat size="sm" label={t('common.distance')} value={d.value} unit={d.unit} />}
        <Stat size="sm" label={t('common.movingTime')} value={fmt.num(totals.movingS / 3600, 1)} unit="h" />
        {totals.elevationM >= 1 && <Stat size="sm" label={t('common.elevationGain')} value={e.value} unit={e.unit} />}
        <Stat size="sm" label={t('common.calories')} value={fmt.compact(totals.energyKcal)} unit="kcal" />
        <Stat size="sm" label={t('common.effort')} value={fmt.int(totals.effort)} />
      </div>
    </Card>
  );
}
