import { AlertTriangle, BatteryFull, BatteryLow, Sparkles, Target, type LucideIcon } from 'lucide-react';
import type { ProgressFormZone } from '@cadence/shared';
import { Badge } from '@/components/ui';
import { useT } from '@/lib/i18n';

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warning' | 'critical';

export const ZONE_STYLE: Record<ProgressFormZone, { tone: BadgeTone; icon: LucideIcon }> = {
  transition: { tone: 'neutral', icon: BatteryFull },
  fresh: { tone: 'good', icon: Sparkles },
  optimal: { tone: 'accent', icon: Target },
  tired: { tone: 'warning', icon: BatteryLow },
  overreaching: { tone: 'critical', icon: AlertTriangle },
};

/** Form zone as a status badge (icon + label, never color alone). Light module: safe for dashboard widgets. */
export function FormZoneBadge({ zone }: { zone: ProgressFormZone }) {
  const t = useT();
  const s = ZONE_STYLE[zone];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {t(`progress.fitness.zones.${zone}`)}
    </Badge>
  );
}
