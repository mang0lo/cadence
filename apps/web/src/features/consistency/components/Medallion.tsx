import { useId } from 'react';
import { Award, Activity, CalendarCheck, CalendarRange, ChevronsUp, Flag, Flame, Lock, Medal, Moon, Mountain, PersonStanding, Shapes, Sparkles, Sunrise, Target, Timer, Trophy, type LucideIcon } from 'lucide-react';
import type { Achievement, AchievementKind, AchievementTier } from '@cadence/shared';
import { sportIcon } from '@/lib/sports';

/**
 * Metal tones of the medallions. Illustration colors, not data colors: there are no design tokens for
 * metals, so they live here (same in light and dark mode — the medal carries its own contrast).
 */
const METAL: Record<AchievementTier, { hi: string; mid: string; lo: string; ink: string }> = {
  bronze: { hi: '#f2b98a', mid: '#c27c3e', lo: '#86501f', ink: '#ffffff' },
  silver: { hi: '#f7f9fb', mid: '#b9c2cc', lo: '#78838f', ink: '#27303a' },
  gold: { hi: '#ffe9a3', mid: '#e2ad2b', lo: '#a17410', ink: '#432d00' },
};

const KIND_ICONS: Record<AchievementKind, LucideIcon> = {
  activities: Medal,
  sport_distance: Activity,
  longest: Flag,
  elevation: Mountain,
  daily_streak: Flame,
  weekly_streak: CalendarCheck,
  early_bird: Sunrise,
  night_owl: Moon,
  weekend_warrior: CalendarRange,
  variety: Shapes,
  move_streak: Target,
  exercise_streak: Timer,
  stand_streak: PersonStanding,
  perfect_week: Sparkles,
  double_move: ChevronsUp,
  challenges: Trophy,
  triathlon: Award,
};

export function achievementIcon(a: Pick<Achievement, 'kind' | 'sport'>): LucideIcon {
  if (a.kind === 'sport_distance' && a.sport) return sportIcon(a.sport);
  return KIND_ICONS[a.kind] ?? Medal;
}

/** Scalloped rim: 24 points alternating between two radii. */
function rimPath(c: number, r1: number, r2: number, points = 24): string {
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push(`${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join('L')}Z`;
}

/** Tiered medal (bronze / silver / gold); locked medals are drawn in neutral tones with a lock. */
export function Medallion({
  tier,
  icon: Icon,
  locked = false,
  size = 64,
  label,
}: {
  tier: AchievementTier;
  icon: LucideIcon;
  locked?: boolean;
  size?: number;
  label?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const m = METAL[tier];
  const c = 32;
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden className="absolute inset-0">
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={locked ? 'var(--surface-2)' : m.hi} />
            <stop offset="1" stopColor={locked ? 'var(--surface-3)' : m.mid} />
          </linearGradient>
        </defs>
        <path d={rimPath(c, 31, 28.6)} fill={locked ? 'var(--surface-3)' : m.lo} />
        <circle cx={c} cy={c} r={26} fill={`url(#g${id})`} />
        <circle cx={c} cy={c} r={21.5} fill="none" stroke={locked ? 'var(--border-strong)' : m.hi} strokeOpacity={locked ? 1 : 0.85} strokeWidth={1.2} />
        {!locked && <path d="M14 26 A19 19 0 0 1 38 13" fill="none" stroke="#fff" strokeOpacity={0.45} strokeWidth={2} strokeLinecap="round" />}
      </svg>
      <Icon size={size * 0.36} strokeWidth={2.2} className="relative" style={{ color: locked ? 'var(--fg-3)' : m.ink }} aria-hidden />
      {locked && (
        <span className="absolute -bottom-0.5 -right-0.5 grid size-5 place-items-center rounded-full border border-border bg-surface text-fg-3 shadow-card">
          <Lock size={11} aria-hidden />
        </span>
      )}
    </span>
  );
}
