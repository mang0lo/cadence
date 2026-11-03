import { Link } from 'react-router';
import { Trophy } from 'lucide-react';
import { workoutTitle } from '@cadence/shared';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { WhatsNewProps } from '../../types';
import { MedalBadge } from './MedalBadge';

/** Personal records and podium places of the new activities (import summary). */
export default function WhatsNewRecords({ items }: WhatsNewProps) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const records = items.filter((h) => h.kind === 'record');
  if (!records.length) return null;
  return (
    <section>
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-3">
        <Trophy size={14} aria-hidden />
        {t('activities.whatsNew.records')}
      </h3>
      <ul className="divide-y divide-border">
        {records.map((h) => {
          const sport = String(h.data.sport);
          return (
            <li key={`${h.workoutId}-${String(h.data.effort)}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <MedalBadge rank={Number(h.data.rank)} effort={String(h.data.effort)} sport={sport} elapsedS={Number(h.data.elapsedS)} />
              <span className="tabular text-sm font-semibold text-fg">{fmt.duration(Number(h.data.elapsedS))}</span>
              {h.workout && (
                <Link
                  to={`/activities/${h.workout.id}`}
                  className="min-w-0 flex-1 truncate text-sm text-fg-2 hover:text-accent-fg hover:underline"
                >
                  {workoutTitle(h.workout, lang)} · {fmt.date(h.workout.startTs, h.workout.tzMin, 'day')}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
