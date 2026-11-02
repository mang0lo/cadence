import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { addDays, diffDays, startOfWeek, weekday } from '@/lib/time';

export type CalendarRamp = 'orange' | 'blue';

/** Default thresholds: quartiles of the non-zero values → 5 sequential steps. */
function autoThresholds(values: number[]): number[] {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 4) return [0, 0, 0, 0].map((_, i) => (v[v.length - 1] ?? 1) * ((i + 1) / 5));
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!;
  return [q(0.2), q(0.4), q(0.6), q(0.8)];
}

/**
 * GitHub-style calendar heatmap (weeks as columns). Sequential one-hue ramp, empty days in the
 * neutral cell color. Hover shows a tooltip; pair it with a table view for accessibility.
 */
export function CalendarHeatmap({
  values,
  from,
  to,
  weekStart = 1,
  thresholds,
  ramp = 'orange',
  cell = 12,
  gap = 2,
  tooltip,
  onSelectDay,
  selectedDay,
  showLegend = true,
}: {
  /** day 'YYYY-MM-DD' → value (> 0 = active). */
  values: Record<string, number>;
  from: string;
  to: string;
  weekStart?: 0 | 1;
  thresholds?: number[];
  ramp?: CalendarRamp;
  cell?: number;
  gap?: number;
  tooltip?: (day: string, value: number | undefined) => ReactNode;
  onSelectDay?: (day: string) => void;
  selectedDay?: string | null;
  showLegend?: boolean;
}) {
  const fmt = useFormat();
  const t = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ day: string; x: number; y: number } | null>(null);

  const th = useMemo(() => thresholds ?? autoThresholds(Object.values(values)), [thresholds, values]);
  const prefix = ramp === 'blue' ? '--seqb-' : '--seq-';
  const colorFor = (v: number | undefined) => {
    if (!v || v <= 0) return 'var(--cell-empty)';
    let i = 0;
    while (i < 4 && v > th[i]!) i++;
    return `var(${prefix}${i + 1})`;
  };

  const gridStart = startOfWeek(from, weekStart);
  const cols = Math.floor(diffDays(gridStart, to) / 7) + 1;
  const step = cell + gap;
  const left = 28;
  const top = 16;
  const width = left + cols * step;
  const height = top + 7 * step;

  const days: { day: string; col: number; row: number }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push({ day: d, col: Math.floor(diffDays(gridStart, d) / 7), row: (weekday(d) - weekStart + 7) % 7 });
  }
  const months: { label: string; col: number }[] = [];
  const monthNames = fmt.monthNames('short');
  for (const d of days) {
    if (d.day.endsWith('-01') || d === days[0]) {
      const col = d.row === 0 || d.day.endsWith('-01') ? d.col : d.col + 1;
      if (!months.length || col - months[months.length - 1]!.col >= 3) {
        months.push({ label: monthNames[Number(d.day.slice(5, 7)) - 1]!, col });
      }
    }
  }
  const wdNames = fmt.weekdayNames(weekStart, 'short');

  return (
    <div ref={wrap} className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', maxWidth: width, height: 'auto' }}
        role="img"
        aria-label={t('common.calendar')}
        onMouseLeave={() => setHover(null)}
      >
        {months.map((m) => (
          <text key={`${m.label}-${m.col}`} x={left + m.col * step} y={10} fontSize={10} fill="var(--axis-text)">
            {m.label}
          </text>
        ))}
        {[1, 3, 5].map((r) => (
          <text key={r} x={0} y={top + r * step + cell - 2} fontSize={9} fill="var(--axis-text)">
            {wdNames[r]}
          </text>
        ))}
        {days.map((d) => (
          <rect
            key={d.day}
            x={left + d.col * step}
            y={top + d.row * step}
            width={cell}
            height={cell}
            rx={2.5}
            fill={colorFor(values[d.day])}
            stroke={selectedDay === d.day ? 'var(--fg)' : 'none'}
            strokeWidth={selectedDay === d.day ? 1.5 : 0}
            style={{ cursor: onSelectDay ? 'pointer' : 'default' }}
            onMouseEnter={(e) => {
              const box = wrap.current!.getBoundingClientRect();
              const r = (e.target as SVGRectElement).getBoundingClientRect();
              setHover({ day: d.day, x: r.left - box.left + r.width / 2, y: r.top - box.top });
            }}
            onClick={() => onSelectDay?.(d.day)}
          />
        ))}
      </svg>
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 w-max max-w-60 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-fg shadow-pop"
          style={{ left: hover.x, top: hover.y - 6 }}
        >
          {tooltip ? (
            tooltip(hover.day, values[hover.day])
          ) : (
            <>
              <div className="font-semibold">{values[hover.day] ? fmt.num(values[hover.day]!, 1) : '–'}</div>
              <div className="text-fg-3">{fmt.day(hover.day, 'weekdayShort')}</div>
            </>
          )}
        </div>
      )}
      {showLegend && (
        <div className="mt-2 flex items-center justify-end gap-1 text-[11px] text-fg-3">
          <span className="mr-1">{t('common.less')}</span>
          {[undefined, 1, 2, 3, 4, 5].map((i) => (
            <span
              key={i ?? 0}
              className="inline-block size-2.5 rounded-[2px]"
              style={{ background: i ? `var(${prefix}${i})` : 'var(--cell-empty)' }}
            />
          ))}
          <span className="ml-1">{t('common.more')}</span>
        </div>
      )}
    </div>
  );
}
