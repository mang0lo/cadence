import { useEffect, useState } from 'react';
import {
  GOAL_METRICS,
  LONGEST_PRESETS,
  M_PER_KM,
  M_PER_MI,
  sportInfo,
  type GoalInput,
  type GoalMetric,
  type GoalPeriod,
} from '@cadence/shared';
import { Button, Dialog, ErrorState, Field, Input, SegmentedControl, Select } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sortSports, sportLabel } from '@/lib/sports';
import { useConsistencyMutations, useSports } from '../api';
import { formatGoalValue, fromInputValue, targetUnit, toInputValue } from '../lib';
import { FieldGroup } from './FieldGroup';

const MAX_DAYS: Record<GoalPeriod, number> = { week: 7, month: 31, year: 366 };
const COMMON_SPORTS = ['run', 'ride', 'swim', 'walk', 'hike'];
type PresetSport = keyof typeof LONGEST_PRESETS;
const PRESET_SPORTS: PresetSport[] = ['run', 'ride', 'swim'];

/**
 * Ambitious round targets per metric and period ("bigger goals"); distances in km or miles (the unit setting), time
 * in hours, elevation in m, the rest as counts.
 */
const BIG_GOALS: Partial<Record<GoalMetric, Record<GoalPeriod, number[]>>> = {
  distance: { week: [25, 50, 100, 250], month: [100, 250, 500, 1000], year: [1000, 2500, 5000, 10000] },
  time: { week: [5, 10, 15], month: [20, 40, 60], year: [100, 250, 500] },
  elevation: { week: [500, 1000, 2500], month: [2000, 5000, 10000], year: [10000, 50000, 100000] },
  activities: { week: [3, 5, 7], month: [12, 20, 30], year: [150, 250, 365] },
  active_days: { week: [4, 5, 6], month: [15, 20, 25], year: [150, 250, 300] },
};

/** Create or edit a goal. `initial` with an id edits, without one it pre-fills a new goal. */
export function GoalDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial: (GoalInput & { id?: number }) | null;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const sportsQ = useSports();
  const { createGoal, updateGoal } = useConsistencyMutations();
  const [period, setPeriod] = useState<GoalPeriod>('week');
  const [sport, setSport] = useState<string>('all');
  const [metric, setMetric] = useState<GoalMetric>('active_days');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const g = initial ?? { period: 'week', sport: null, metric: 'active_days', target: 3 };
    setPeriod(g.period);
    setSport(g.sport ?? 'all');
    setMetric(g.metric);
    setTarget(fieldValue(toInputValue(fmt, g.metric, g.target)));
    setError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  const known = (sportsQ.data ?? []).map((s) => s.sport);
  const sports = sortSports([...new Set([...known, ...COMMON_SPORTS, ...(sport !== 'all' ? [sport] : [])])]);
  const hasDistance = sport === 'all' || sportInfo(sport).distance;
  const metricOptions = GOAL_METRICS.filter((m) => (m !== 'distance' && m !== 'longest') || hasDistance);
  const effectiveMetric: GoalMetric = metricOptions.includes(metric) ? metric : 'time';

  // the input shows the locale's decimal separator (42,195 km in German, not "42.195")
  function fieldValue(v: number): string {
    return lang === 'de' ? String(v).replace('.', ',') : String(v);
  }
  const parsed = Number(target.replace(',', '.'));
  const canonical = Number.isFinite(parsed) ? fromInputValue(fmt, effectiveMetric, parsed) : NaN;
  const invalid = !(canonical > 0) ? t('consistency.goals.form.invalid') : null;
  const tooMany =
    effectiveMetric === 'active_days' && canonical > MAX_DAYS[period]
      ? t(`consistency.goals.form.tooMany.${period}`, { count: MAX_DAYS[period] })
      : null;
  const problem = target.trim() === '' ? null : (invalid ?? tooMany);

  // quick picks: classic single distances (marathon, Ironman legs …) or bigger round targets
  const pick = (m: GoalMetric, v: number, s?: string) => {
    if (s) setSport(s);
    setMetric(m);
    setTarget(fieldValue(toInputValue(fmt, m, v)));
  };
  const presetSports = effectiveMetric === 'longest' ? PRESET_SPORTS.filter((s) => sport === 'all' || s === sport) : [];
  const big = BIG_GOALS[effectiveMetric]?.[period] ?? [];
  const bigCanonical = (v: number) =>
    effectiveMetric === 'distance' ? v * (fmt.units === 'imperial' ? M_PER_MI : M_PER_KM) : effectiveMetric === 'time' ? v * 3600 : v;
  const chip = 'rounded-full border border-border px-2.5 py-1 text-xs font-medium text-fg-2 hover:bg-surface-2';

  const save = async () => {
    if (invalid || tooMany || saving) return;
    setSaving(true);
    setError(null);
    const input: GoalInput = { period, sport: sport === 'all' ? null : sport, metric: effectiveMetric, target: canonical };
    try {
      if (initial?.id) await updateGoal(initial.id, input);
      else await createGoal(input);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial?.id ? t('consistency.goals.edit') : t('consistency.goals.new')}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={saving} disabled={!!invalid || !!tooMany} onClick={() => void save()}>
            {initial?.id ? t('common.save') : t('consistency.goals.create')}
          </Button>
        </>
      }
    >
      {/* no <form>: the shared Button/SegmentedControl render type=submit buttons; Enter is handled on the input */}
      <div className="grid gap-4">
        <FieldGroup label={t('consistency.goals.form.period')}>
          <SegmentedControl
            value={period}
            onChange={setPeriod}
            className="self-start"
            items={(['week', 'month', 'year'] as const).map((p) => ({ value: p, label: t(`consistency.goals.periods.${p}`) }))}
          />
        </FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('consistency.goals.form.sport')}>
            <Select
              value={sport}
              onChange={setSport}
              className="w-full"
              options={[
                { value: 'all', label: t('common.allSports') },
                ...sports.map((s) => ({ value: s, label: sportLabel(s, lang) })),
              ]}
            />
          </Field>
          <Field label={t('consistency.goals.form.metric')}>
            <Select
              value={effectiveMetric}
              onChange={(m) => {
                setMetric(m);
                // keep the number meaningful when switching units
                if (m !== effectiveMetric) setTarget('');
              }}
              className="w-full"
              options={metricOptions.map((m) => ({ value: m, label: t(`consistency.goals.metrics.${m}`) }))}
            />
          </Field>
        </div>
        <Field
          label={t('consistency.goals.form.target')}
          help={
            effectiveMetric === 'time' && canonical > 0 && !problem
              ? `= ${fmt.durationShort(canonical)} ${t(`consistency.goals.perUnit.${period}`)}`
              : undefined
          }
        >
          <div className="flex items-center gap-2">
            <Input
              inputMode="decimal"
              value={target}
              autoFocus
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
              className="max-w-40"
              aria-invalid={!!problem}
            />
            <span className="text-sm text-fg-3">
              {targetUnit(fmt, t, effectiveMetric)}{' '}
              {t(`consistency.goals.${effectiveMetric === 'longest' ? 'onceUnit' : 'perUnit'}.${period}`)}
            </span>
          </div>
        </Field>
        {presetSports.length > 0 && (
          <div className="grid gap-2" role="group" aria-label={t('consistency.goals.presets.title')}>
            <span className="text-xs font-medium text-fg-2">{t('consistency.goals.presets.title')}</span>
            {presetSports.map((s) => (
              <div key={s} className="flex flex-wrap items-center gap-1.5">
                {sport === 'all' && <span className="w-20 shrink-0 text-xs text-fg-3">{sportLabel(s, lang)}</span>}
                {LONGEST_PRESETS[s].map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className={chip}
                    onClick={() => pick('longest', p.distanceM, sport === 'all' ? s : undefined)}
                  >
                    {t(`consistency.goals.presets.${p.key}`)}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {big.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('consistency.goals.presets.bigger')}>
            <span className="mr-1 text-xs font-medium text-fg-2">{t('consistency.goals.presets.bigger')}</span>
            {big.map((v) => (
              <button key={v} type="button" className={chip} onClick={() => pick(effectiveMetric, bigCanonical(v))}>
                {formatGoalValue(fmt, t, effectiveMetric, bigCanonical(v))}
              </button>
            ))}
          </div>
        )}
        {problem && <p className="text-xs text-critical-fg">{problem}</p>}
        {error ? <ErrorState error={error} /> : null}
      </div>
    </Dialog>
  );
}
