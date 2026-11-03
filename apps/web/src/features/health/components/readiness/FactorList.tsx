import type { ReadinessDay, ReadinessFactor, ReadinessModelInfo } from '@cadence/shared';
import { Delta, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { FACTOR_ICON, useReadinessFormat } from '../../lib/readiness';

/** Points at which a contribution bar is full (half the track): the largest share a signal has (HRV, 30 %) × 50. */
const FULL_POINTS = 15;

/** Diverging bar around the midline: right (good) adds points, left (critical) takes them away. */
function PointsBar({ points }: { points: number }) {
  const w = Math.min(1, Math.abs(points) / FULL_POINTS) * 50;
  return (
    <div className="relative h-1.5 w-full rounded-full bg-surface-2" aria-hidden>
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-border-strong" />
      {w > 0.5 && (
        <span
          className={cn('absolute inset-y-0 rounded-full', points > 0 ? 'left-1/2 bg-good' : 'right-1/2 bg-critical')}
          style={{ width: `${w}%` }}
        />
      )}
    </div>
  );
}

function FactorRow({ f, day, model, totalWeight }: { f: ReadinessFactor; day: string; model: ReadinessModelInfo; totalWeight: number }) {
  const t = useT();
  const fmt = useFormat();
  const rf = useReadinessFormat();
  const Icon = FACTOR_ICON[f.key];
  const name = rf.name(f.key);
  const available = f.missing === null;
  const share = f.used && totalWeight > 0 ? f.weight / totalWeight : f.weight / 100;
  const comparison = available ? rf.comparison(f) : null;
  const sub = f.used ? rf.hint(f, day, model) : rf.missing(f, model);
  return (
    <li
      className={cn(
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)_5.5rem]',
        !f.used && 'opacity-80',
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon size={16} className={cn('mt-0.5 shrink-0', f.used ? 'text-fg-2' : 'text-fg-3')} aria-hidden />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-1.5 text-sm font-medium text-fg">
            <span>{name}</span>
            <span className="text-xs font-normal text-fg-3">
              {f.used ? t('health.readiness.factors.weight', { pct: fmt.pct(share) }) : t('health.readiness.factors.notUsed')}
            </span>
          </div>
          {sub && <div className="text-xs text-fg-3">{sub}</div>}
        </div>
      </div>
      <div className="col-start-1 row-start-2 min-w-0 pl-[26px] sm:col-start-2 sm:row-start-1 sm:pl-0">
        <div className={cn('text-sm font-semibold', available ? 'text-fg' : 'text-fg-3')}>{rf.value(f)}</div>
        {comparison && <div className="text-xs text-fg-3">{comparison}</div>}
      </div>
      <div className="col-start-2 row-span-2 row-start-1 flex w-[5.5rem] flex-col items-end gap-1.5 sm:col-start-3 sm:row-span-1">
        {f.points !== null ? (
          <>
            <Delta value={Math.round(f.points)} text={fmt.signed(f.points, 0)} />
            <PointsBar points={f.points} />
          </>
        ) : (
          <span className="text-xs text-fg-3">–</span>
        )}
      </div>
    </li>
  );
}

/** Every signal of the day: value vs. personal baseline and normal range, its share and the points it adds or takes. */
export function FactorList({ day, model }: { day: ReadinessDay; model: ReadinessModelInfo }) {
  const t = useT();
  const totalWeight = day.factors.filter((f) => f.used).reduce((s, f) => s + f.weight, 0);
  return (
    <div>
      <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,15rem)_5.5rem] gap-x-4 border-b border-border pb-1.5 text-[11px] font-medium uppercase tracking-wider text-fg-3 sm:grid">
        <span />
        <span />
        <span className="text-right">{t('health.readiness.factors.points')}</span>
      </div>
      <ul className="divide-y divide-border" aria-label={t('health.readiness.factors.title')}>
        {day.factors.map((f) => (
          <FactorRow key={f.key} f={f} day={day.day} model={model} totalWeight={totalWeight} />
        ))}
      </ul>
    </div>
  );
}
