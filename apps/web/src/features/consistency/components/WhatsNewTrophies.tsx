import { Link } from 'react-router';
import { Award } from 'lucide-react';
import type { Achievement, AchievementGroup, AchievementKind, AchievementTier } from '@cadence/shared';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { WhatsNewProps } from '../../types';
import { Medallion, achievementIcon } from './Medallion';
import { achievementDesc, achievementTitle } from './TrophyParts';

/** Trophies earned by the new activities (import summary). */
export default function WhatsNewTrophies({ items }: WhatsNewProps) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const trophies: Achievement[] = items
    .filter((h) => h.kind === 'trophy')
    .map((h) => ({
      key: String(h.data.key),
      group: h.data.group as AchievementGroup,
      kind: h.data.kind as AchievementKind,
      tier: h.data.tier as AchievementTier,
      sport: (h.data.sport as string | null) ?? null,
      threshold: Number(h.data.threshold),
      name: (h.data.name as string | null) ?? null,
      progress: Number(h.data.threshold),
      earned: true,
      earnedDay: (h.data.earnedDay as string | null) ?? null,
      workout: h.workout ?? null,
      isNew: true,
    }));
  if (!trophies.length) return null;
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-fg-3">
          <Award size={14} aria-hidden />
          {t('consistency.whatsNew.trophies', { count: trophies.length })}
        </h3>
        <Link to="/trophies" className="text-xs font-medium text-accent-fg hover:underline">
          {t('consistency.whatsNew.allTrophies')}
        </Link>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {trophies.map((a) => {
          const title = achievementTitle(a, t, fmt, lang);
          return (
            <li key={a.key} className="flex min-w-0 items-center gap-3">
              <Medallion tier={a.tier} icon={achievementIcon(a)} size={44} label={title} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{title}</div>
                <div className="line-clamp-2 text-xs text-fg-3">{achievementDesc(a, t, fmt, lang)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
