import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { sportInfo, type ActivityAnalysis, type WorkoutDetail } from '@cadence/shared';
import { Card, Hint, KeyValues } from '@/components/ui';
import { showsPace, useFormat, type Formatter } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { TFunction } from '@/lib/i18n';
import { shortDistanceParts } from '../../lib/display';

interface HeroStat {
  key: string;
  label: string;
  value: string;
  unit?: string;
  hint?: ReactNode;
}

/** Pool lengths of a swim: lap events, else distance / pool length. */
export function swimLengths(w: WorkoutDetail, analysis: ActivityAnalysis | undefined): number | null {
  const laps = analysis?.laps.filter((l) => l.kind === 'lap').length ?? 0;
  if (laps) return laps;
  if (w.lapLengthM && w.distanceM) return Math.round(w.distanceM / w.lapLengthM);
  return null;
}

function primaryStats(w: WorkoutDetail, a: ActivityAnalysis | undefined, fmt: Formatter, t: TFunction): HeroStat[] {
  const info = sportInfo(w.sport);
  const moving = w.movingS ?? w.durationS;
  const out: HeroStat[] = [];
  const dist = (): HeroStat => {
    const p = w.sport === 'swim' ? shortDistanceParts(w.distanceM ?? 0, fmt) : fmt.distanceParts(w.distanceM);
    return { key: 'distance', label: t('common.distance'), ...p };
  };
  const pace = (): HeroStat | null => {
    if (!w.avgSpeed || info.speedMode === 'none') return null;
    const p = fmt.paceParts(w.avgSpeed, w.sport);
    return {
      key: 'pace',
      label: info.speedMode === 'pace100' ? t('activities.stats.pace100') : showsPace(w.sport) ? t('activities.stats.avgPace') : t('activities.stats.avgSpeed'),
      ...p,
    };
  };
  const effort = (): HeroStat | null =>
    w.effort === null
      ? null
      : {
          key: 'effort',
          label: t('common.effort'),
          value: fmt.int(w.effort),
          hint: w.effortEstimated ? t('activities.stats.estimated') : undefined,
        };
  const kcal = (): HeroStat | null =>
    w.energyKcal ? { key: 'kcal', label: t('common.calories'), value: fmt.int(w.energyKcal), unit: 'kcal' } : null;
  const elev = (): HeroStat | null => {
    if (w.elevationGainM === null || (!w.hasRoute && !w.elevationGainM)) return null;
    return { key: 'elevation', label: t('common.elevationGain'), ...fmt.elevationParts(w.elevationGainM) };
  };
  const hr = (): HeroStat | null => (w.avgHr ? { key: 'hr', label: t('common.avgHr'), value: fmt.int(w.avgHr), unit: 'bpm' } : null);
  const time = (): HeroStat => ({ key: 'time', label: t('activities.stats.moving'), value: fmt.duration(moving) });

  if (info.distance && (w.distanceM ?? 0) > 0) {
    out.push(dist(), time());
    const p = pace();
    if (p) out.push(p);
    if (w.sport === 'swim') {
      if (w.swimStrokes) out.push({ key: 'strokes', label: t('activities.stats.strokes'), value: fmt.int(w.swimStrokes) });
      const lengths = swimLengths(w, a);
      if (lengths) out.push({ key: 'lengths', label: t('activities.stats.lengths'), value: fmt.int(lengths) });
    } else {
      const e = elev();
      if (e) out.push(e);
      if (info.group === 'cycle' && w.avgPower)
        out.push({ key: 'power', label: t('activities.stats.avgPower'), value: fmt.int(w.avgPower), unit: 'W' });
    }
    for (const s of [effort(), kcal(), hr()]) if (s && out.length < 6) out.push(s);
  } else {
    out.push({ key: 'time', label: t('activities.stats.duration'), value: fmt.duration(w.durationS) });
    for (const s of [hr(), kcal(), effort()]) if (s) out.push(s);
    if (w.maxHr) out.push({ key: 'maxHr', label: t('common.maxHr'), value: fmt.int(w.maxHr), unit: 'bpm' });
  }
  return out.slice(0, 6);
}

function secondaryStats(w: WorkoutDetail, a: ActivityAnalysis | undefined, fmt: Formatter, t: TFunction, shown: Set<string>) {
  const info = sportInfo(w.sport);
  const rows: [string, string][] = [];
  const add = (key: string, label: string, value: string | null) => {
    if (value !== null && !shown.has(key)) rows.push([label, value]);
  };
  add('elapsed', t('activities.stats.elapsed'), fmt.duration(w.elapsedS));
  if (w.movingS !== null && w.elapsedS - w.movingS >= 30) add('stopped', t('activities.stats.stopped'), fmt.duration(w.elapsedS - w.movingS));
  add('hr', t('common.avgHr'), w.avgHr ? fmt.hr(w.avgHr) : null);
  add('maxHr', t('common.maxHr'), w.maxHr ? fmt.hr(w.maxHr) : null);
  add('minHr', t('activities.stats.minHr'), w.minHr ? fmt.hr(w.minHr) : null);
  if (info.speedMode !== 'none' && w.maxSpeed)
    add('maxSpeed', t('activities.stats.maxSpeed'), showsPace(w.sport) ? fmt.pace(w.maxSpeed, w.sport) : fmt.speed(w.maxSpeed));
  if (a?.gapSpeed && showsPace(w.sport)) add('gap', t('activities.stats.gap'), fmt.pace(a.gapSpeed, w.sport));
  add('elevationLoss', t('activities.stats.elevationLoss'), w.elevationLossM ? fmt.elevation(w.elevationLossM) : null);
  add('cadence', t('activities.stats.avgCadence'), w.avgCadence ? fmt.cadence(w.avgCadence, w.sport) : null);
  add('power', t('activities.stats.avgPower'), w.avgPower ? fmt.power(w.avgPower) : null);
  add('maxPower', t('activities.stats.maxPower'), w.maxPower ? fmt.power(w.maxPower) : null);
  add('np', t('activities.stats.np'), a?.power?.normalizedW ? fmt.power(a.power.normalizedW) : null);
  add('steps', t('activities.stats.steps'), w.stepCount ? fmt.int(w.stepCount) : null);
  add('kcal', t('common.calories'), w.energyKcal ? fmt.energy(w.energyKcal) : null);
  add('effort', t('common.effort'), w.effort !== null ? fmt.int(w.effort) : null);
  if (w.sport === 'swim') {
    add('pool', t('activities.stats.pool'), w.lapLengthM ? fmt.shortDistance(w.lapLengthM) : null);
    const lengths = swimLengths(w, a);
    const swimTime = a?.laps.filter((l) => l.kind === 'lap').reduce((s, l) => s + l.durationS, 0) || (w.movingS ?? w.durationS);
    if (lengths && w.swimStrokes) add('swolf', t('activities.stats.swolf'), fmt.num((w.swimStrokes + swimTime) / lengths, 0));
  }
  add('temperature', t('activities.stats.temperature'), w.temperatureC !== null ? fmt.temperature(w.temperatureC) : null);
  add('humidity', t('activities.stats.humidity'), w.humidityPct !== null ? fmt.pct(w.humidityPct / 100) : null);
  return rows;
}

/** Big sport-specific numbers plus a details list. */
export function HeroStats({ w, analysis }: { w: WorkoutDetail; analysis: ActivityAnalysis | undefined }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const primary = primaryStats(w, analysis, fmt, t);
  const secondary = secondaryStats(w, analysis, fmt, t, new Set(primary.map((p) => p.key)));
  return (
    <Card className="mb-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
        {primary.map((s) => (
          <div key={s.key} className="min-w-0">
            <div className="flex items-center gap-1 truncate text-xs font-medium text-fg-3">
              {s.label}
              {s.hint && (
                <Hint content={s.hint}>
                  <Info size={12} aria-label={String(s.hint)} />
                </Hint>
              )}
            </div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">{s.value}</span>
              {s.unit && <span className="text-sm font-medium text-fg-3">{s.unit}</span>}
            </div>
          </div>
        ))}
      </div>
      {secondary.length > 0 && (
        <details className="group mt-4 border-t border-border pt-3" open>
          <summary className="cursor-pointer list-none text-xs font-medium text-fg-3 hover:text-fg">
            {t('activities.stats.more')}
          </summary>
          <KeyValues
            className="mt-2 grid-cols-[auto_1fr] gap-x-4 sm:grid-cols-[auto_1fr_auto_1fr] lg:grid-cols-[auto_1fr_auto_1fr_auto_1fr]"
            items={secondary}
          />
        </details>
      )}
    </Card>
  );
}
