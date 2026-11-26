import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { addDays, diffDays, startOfWeek, weekday } from '@/lib/time';
import { monthColumns } from './calendar';

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
 * With `onSelectDay` the days are keyboard reachable: one tab stop, arrow keys move by day (↑/↓) and
 * week (←/→), Home/End jump to the first/last day, Enter or Space selects.
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
  const cells = useRef(new Map<string, SVGRectElement>());
  const [hover, setHover] = useState<{ day: string; x: number; y: number } | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const interactive = !!onSelectDay;

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
  const monthNames = fmt.monthNames('short');
  const months = monthColumns(from, to, weekStart).map((m) => ({ label: monthNames[m.month]!, col: m.col }));
  const wdNames = fmt.weekdayNames(weekStart, 'short');

  const clampDay = (d: string) => (d < from ? from : d > to ? to : d);
  // the single tab stop: the focused day, else the selected one, else the last day
  const tabDay = clampDay(focusDay ?? selectedDay ?? to);
  const showTip = (day: string, el: SVGRectElement) => {
    const w = wrap.current!;
    const box = w.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // rectangles are in zoomed screen units, the tooltip is placed in the wrapper's CSS pixels
    const sx = w.offsetWidth ? box.width / w.offsetWidth : 1;
    const sy = w.offsetHeight ? box.height / w.offsetHeight : 1;
    setHover({ day, x: (r.left - box.left + r.width / 2) / (sx || 1), y: (r.top - box.top) / (sy || 1) });
  };
  const onKey = (e: KeyboardEvent<SVGRectElement>, day: string) => {
    const moves: Record<string, () => string> = {
      ArrowUp: () => addDays(day, -1),
      ArrowDown: () => addDays(day, 1),
      ArrowLeft: () => addDays(day, -7),
      ArrowRight: () => addDays(day, 7),
      Home: () => from,
      End: () => to,
    };
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectDay?.(day);
      return;
    }
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const next = clampDay(move());
    setFocusDay(next);
    cells.current.get(next)?.focus();
  };

  return (
    <div ref={wrap} className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', maxWidth: width, height: 'auto' }}
        role={interactive ? 'group' : 'img'}
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
        {days.map((d) => {
          const marked = selectedDay === d.day || (interactive && focusDay === d.day);
          return (
            <rect
              key={d.day}
              ref={(el) => {
                if (el) cells.current.set(d.day, el);
                else cells.current.delete(d.day);
              }}
              x={left + d.col * step}
              y={top + d.row * step}
              width={cell}
              height={cell}
              rx={2.5}
              fill={colorFor(values[d.day])}
              stroke={marked ? 'var(--fg)' : 'none'}
              strokeWidth={marked ? 1.5 : 0}
              style={{ cursor: interactive ? 'pointer' : 'default', outline: 'none' }}
              {...(interactive && {
                tabIndex: d.day === tabDay ? 0 : -1,
                role: 'button',
                'aria-label': `${fmt.day(d.day, 'weekdayShort')}: ${values[d.day] ? fmt.num(values[d.day]!, 1) : '–'}`,
                'aria-pressed': selectedDay === d.day,
                onKeyDown: (e: KeyboardEvent<SVGRectElement>) => onKey(e, d.day),
                onFocus: (e: FocusEvent<SVGRectElement>) => {
                  setFocusDay(d.day);
                  showTip(d.day, e.currentTarget);
                },
                onBlur: () => {
                  setFocusDay(null);
                  setHover(null);
                },
              })}
              onMouseEnter={(e) => showTip(d.day, e.currentTarget)}
              onClick={() => onSelectDay?.(d.day)}
            />
          );
        })}
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
