import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2 } from 'lucide-react';
import type { ReadinessBand, ReadinessDay } from '@cadence/shared';
import { Badge, cn } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { BAND_STYLE, reasonSign, useReadinessFormat } from '../../lib/readiness';

/**
 * Score ring (a circular meter): the fill carries the band's status color, the track is a lighter step of the same
 * color; the number sits in the middle. Light module (no charts) – used by the dashboard widget too.
 */
export function ReadinessRing({ score, band, size = 140 }: { score: number; band: ReadinessBand; size?: number }) {
  const t = useT();
  const stroke = Math.max(6, Math.round(size / 12));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, score / 100));
  const color = BAND_STYLE[band].color;
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={t('health.readiness.ringLabel', { score, band: t(`health.readiness.bands.${band}`) })}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          style={{ stroke: `color-mix(in srgb, ${color} 18%, transparent)` }}
        />
        {frac > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${c * frac} ${c}`}
            style={{ stroke: color, transition: 'stroke-dasharray 500ms ease' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="font-semibold leading-none tracking-tight text-fg" style={{ fontSize: Math.round(size * 0.34) }}>
          {score}
        </span>
        {size >= 100 && <span className="mt-1.5 text-[11px] font-medium text-fg-3">{t('health.readiness.outOf')}</span>}
      </div>
    </div>
  );
}

/** Band as a status badge: icon + label, never color alone. */
export function ReadinessBandBadge({ band, className }: { band: ReadinessBand; className?: string }) {
  const t = useT();
  const s = BAND_STYLE[band];
  return (
    <Badge tone={s.tone} icon={s.icon} className={className}>
      {t(`health.readiness.bands.${band}`)}
    </Badge>
  );
}

/** The day's notable reasons, most important first, each with a direction icon. */
export function ReasonList({ day, max = 4, className }: { day: ReadinessDay; max?: number; className?: string }) {
  const rf = useReadinessFormat();
  const items = day.reasons.slice(0, max);
  if (!items.length) return null;
  return (
    <ul className={cn('space-y-1', className)}>
      {items.map((code) => {
        const sign = reasonSign(day, code);
        const Icon = code === 'capped' ? AlertTriangle : code === 'allNormal' ? CheckCircle2 : sign > 0 ? ArrowUpRight : ArrowDownRight;
        return (
          <li key={code} className="flex items-start gap-1.5 text-xs text-fg-2">
            <Icon
              size={14}
              aria-hidden
              className={cn(
                'mt-px shrink-0',
                code === 'allNormal' ? 'text-good-fg' : sign > 0 ? 'text-good-fg' : sign < 0 ? 'text-critical-fg' : 'text-fg-3',
              )}
            />
            <span>{rf.reason(code)}</span>
          </li>
        );
      })}
    </ul>
  );
}
