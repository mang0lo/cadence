import {
  Accessibility,
  Activity,
  BedDouble,
  Bike,
  Dumbbell,
  Fish,
  Flag,
  Flower2,
  Footprints,
  Gamepad2,
  HeartPulse,
  Medal,
  Mountain,
  MountainSnow,
  Music,
  PersonStanding,
  Repeat,
  Sailboat,
  Smile,
  Snowflake,
  StretchHorizontal,
  Swords,
  Target,
  Timer,
  TrendingUp,
  Trophy,
  Waves,
  Zap,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { SPORTS, sportInfo, type SportGroup } from '@cadence/shared';
import { useI18n, type Lang } from './i18n';

const ICONS: Record<string, LucideIcon> = {
  Accessibility,
  Activity,
  BedDouble,
  Bike,
  Dumbbell,
  Fish,
  Flag,
  Flower2,
  Footprints,
  Gamepad2,
  HeartPulse,
  Medal,
  Mountain,
  MountainSnow,
  Music,
  PersonStanding,
  Repeat,
  Sailboat,
  Smile,
  Snowflake,
  StretchHorizontal,
  Swords,
  Target,
  Timer,
  TrendingUp,
  Trophy,
  Waves,
  Zap,
};

export function sportIcon(sport: string): LucideIcon {
  return ICONS[sportInfo(sport).icon] ?? Activity;
}

export function SportIcon({ sport, ...props }: { sport: string } & LucideProps) {
  const Icon = sportIcon(sport);
  return <Icon aria-hidden {...props} />;
}

export function sportLabel(sport: string, lang: Lang): string {
  return sportInfo(sport).label[lang];
}

export function useSportLabel(): (sport: string) => string {
  const { lang } = useI18n();
  return (sport) => sportLabel(sport, lang);
}

/**
 * Color identity per sport — FIXED by entity (never by rank), so filtering never repaints a sport.
 * Slots refer to the validated categorical palette (--series-1 … --series-8); everything else
 * folds into the neutral "other" color.
 */
const SPORT_SLOT: Record<string, number> = { run: 1, ride: 2, handcycle: 2, swim: 3, walk: 4, wheelchair: 4, hike: 6 };
const GROUP_SLOT: Partial<Record<SportGroup, number>> = { foot: 1, cycle: 2, water: 3, mind: 5, gym: 7, winter: 8 };

/** 1..8, or 0 for the neutral "other" color. */
export function sportSlot(sport: string): number {
  if (sport in SPORT_SLOT) return SPORT_SLOT[sport]!;
  return GROUP_SLOT[sportInfo(sport).group] ?? 0;
}

/** CSS color (var reference) for a sport — use in DOM/SVG. Charts use `sportColor(theme, sport)`. */
export function sportColorVar(sport: string): string {
  const slot = sportSlot(sport);
  return slot ? `var(--series-${slot})` : 'var(--series-other)';
}

/**
 * Canonical stacking/legend order of sports (palette order, so adjacent stack segments are the
 * validated adjacent pairs). Unknown sports go last.
 */
export function sortSports(sports: string[]): string[] {
  const rank = (s: string) => {
    const slot = sportSlot(s);
    return (slot || 99) * 1000 + Object.keys(SPORTS).indexOf(s);
  };
  return [...sports].sort((a, b) => rank(a) - rank(b));
}

/** Sport badge: colored icon dot + label. */
export function SportBadge({ sport, className }: { sport: string; className?: string }) {
  const { lang } = useI18n();
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 ${className ?? ''}`}>
      <span
        className="grid size-5 place-items-center rounded-full text-white"
        style={{ background: sportColorVar(sport) }}
      >
        <SportIcon sport={sport} size={12} strokeWidth={2.5} />
      </span>
      {sportLabel(sport, lang)}
    </span>
  );
}
