import { useEffect, useMemo, useState } from 'react';
import { SPORTS } from '@cadence/shared';
import { Button, Dialog, ErrorState, Field, Select } from '@/components/ui';
import { useI18n, type Lang } from '@/lib/i18n';
import { sportLabel } from '@/lib/sports';
import { usePatchWorkout } from '../api';

/** All sports as select options, alphabetically in the current language. */
export function sportOptions(lang: Lang): { value: string; label: string }[] {
  return Object.keys(SPORTS)
    .map((k) => ({ value: k, label: sportLabel(k, lang) }))
    .sort((a, b) => a.label.localeCompare(b.label, lang));
}

/** Dialog to change the sport of a workout (PATCH sport; the server re-derives in the background). */
export function SportDialog({
  workout,
  onClose,
}: {
  workout: { id: number; sport: string; title: string } | null;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const patch = usePatchWorkout();
  const [sport, setSport] = useState(workout?.sport ?? 'other');
  useEffect(() => {
    if (workout) setSport(workout.sport);
    patch.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workout?.id]);
  const options = useMemo(() => sportOptions(lang), [lang]);
  return (
    <Dialog
      open={!!workout}
      onClose={onClose}
      title={workout ? t('activities.list.changeSportTitle', { title: workout.title }) : ''}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={patch.isPending}
            disabled={!workout || sport === workout.sport}
            onClick={async () => {
              if (!workout) return;
              await patch.mutateAsync({ id: workout.id, patch: { sport } });
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('common.sport')} help={t('activities.list.changeSportHint')}>
        <Select value={sport} onChange={setSport} options={options} className="w-full" />
      </Field>
      {patch.error && <ErrorState error={patch.error} className="mt-3" />}
    </Dialog>
  );
}
