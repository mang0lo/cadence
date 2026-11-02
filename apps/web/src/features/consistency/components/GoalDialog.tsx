import { useEffect, useState } from 'react';
import { GOAL_METRICS, sportInfo, type GoalInput, type GoalMetric, type GoalPeriod } from '@cadence/shared';
import { Button, Dialog, ErrorState, Field, Input, SegmentedControl, Select } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sortSports, sportLabel } from '@/lib/sports';
import { useConsistencyMutations, useSports } from '../api';
import { fromInputValue, targetUnit, toInputValue } from '../lib';
import { FieldGroup } from './FieldGroup';

const MAX_DAYS: Record<GoalPeriod, number> = { week: 7, month: 31, year: 366 };
const COMMON_SPORTS = ['run', 'ride', 'swim', 'walk', 'hike'];

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
    setTarget(String(toInputValue(fmt, g.metric, g.target)));
    setError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  const known = (sportsQ.data ?? []).map((s) => s.sport);
  const sports = sortSports([...new Set([...known, ...COMMON_SPORTS, ...(sport !== 'all' ? [sport] : [])])]);
  const hasDistance = sport === 'all' || sportInfo(sport).distance;
  const metricOptions = GOAL_METRICS.filter((m) => m !== 'distance' || hasDistance);
  const effectiveMetric: GoalMetric = metricOptions.includes(metric) ? metric : 'time';

  const parsed = Number(target.replace(',', '.'));
  const canonical = Number.isFinite(parsed) ? fromInputValue(fmt, effectiveMetric, parsed) : NaN;
  const invalid = !(canonical > 0) ? t('consistency.goals.form.invalid') : null;
  const tooMany =
    effectiveMetric === 'active_days' && canonical > MAX_DAYS[period]
      ? t(`consistency.goals.form.tooMany.${period}`, { count: MAX_DAYS[period] })
      : null;
  const problem = target.trim() === '' ? null : (invalid ?? tooMany);

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
              {targetUnit(fmt, t, effectiveMetric)} {t(`consistency.goals.perUnit.${period}`)}
            </span>
          </div>
        </Field>
        {problem && <p className="text-xs text-critical-fg">{problem}</p>}
        {error ? <ErrorState error={error} /> : null}
      </div>
    </Dialog>
  );
}
