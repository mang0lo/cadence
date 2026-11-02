import { Medal, Trophy } from 'lucide-react';
import type { ActivityMedal } from '@cadence/shared';
import { Badge, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { effortLabel } from '../lib/display';

/** Rank 1 = personal record (accent + trophy), 2/3 = medal icon + rank label. Never color alone. */
export function MedalBadge({
  rank,
  effort,
  sport,
  elapsedS,
  showEffort = true,
}: {
  rank: number;
  effort?: string;
  sport: string;
  elapsedS?: number;
  showEffort?: boolean;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  if (rank < 1 || rank > 3) return null;
  const key = rank === 1 ? 'pr' : rank === 2 ? 'second' : 'third';
  const label = effort ? effortLabel(sport, effort, lang) : '';
  const title = [t(`activities.medal.${key}Long`), label, elapsedS !== undefined ? fmt.duration(elapsedS) : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <span title={title} className="inline-flex">
      <Badge tone={rank === 1 ? 'accent' : 'neutral'} icon={rank === 1 ? Trophy : Medal}>
        {t(`activities.medal.${key}`)}
        {showEffort && label && <span className="font-normal">{label}</span>}
      </Badge>
    </span>
  );
}

/** Up to `max` medals of an activity, then "+N". */
export function MedalList({
  medals,
  sport,
  max = 3,
  className,
}: {
  medals: ActivityMedal[];
  sport: string;
  max?: number;
  className?: string;
}) {
  const { t } = useI18n();
  if (!medals.length) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {medals.slice(0, max).map((m) => (
        <MedalBadge key={m.effort} rank={m.rank} effort={m.effort} sport={sport} elapsedS={m.elapsedS} />
      ))}
      {medals.length > max && <Badge>{t('activities.medal.more', { count: medals.length - max })}</Badge>}
    </div>
  );
}
