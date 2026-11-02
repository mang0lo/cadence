import { useMemo, useRef, useState } from 'react';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { cn } from '@/components/ui';

type Handle = 'start' | 'end';

/**
 * Elevation profile of a route with two draggable handles that select a part of it. Handles are keyboard operable
 * sliders (arrows move by 10 m, Shift by 100 m, Home/End jump to the limits). Hovering the profile reports the
 * distance under the pointer so a map marker can follow.
 */
export function RangeProfile({
  dist,
  ele,
  total,
  value,
  onChange,
  onHover,
  minGapM,
  className,
}: {
  dist: number[];
  ele: (number | null)[];
  total: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  onHover?: (m: number | null) => void;
  minGapM: number;
  className?: string;
}) {
  const t = useT();
  const fmt = useFormat();
  const box = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<Handle | null>(null);
  const [from, to] = value;

  const { area, line, lo, hi } = useMemo(() => {
    const pts: [number, number][] = [];
    for (let i = 0; i < dist.length; i++) {
      const e = ele[i];
      if (e != null) pts.push([dist[i]!, e]);
    }
    if (pts.length < 2 || total <= 0) return { area: null as string | null, line: null as string | null, lo: null, hi: null };
    const lo = Math.min(...pts.map((p) => p[1]));
    const hi = Math.max(...pts.map((p) => p[1]));
    const span = Math.max(hi - lo, 8); // flat routes stay flat instead of being stretched to full height
    const x = (d: number) => (d / total) * 1000;
    const y = (e: number) => 88 - ((e - lo) / span) * 72;
    const line = pts.map(([d, e], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(e).toFixed(1)}`).join('');
    const area = `${line}L${x(pts[pts.length - 1]![0]).toFixed(1)},100L${x(pts[0]![0]).toFixed(1)},100Z`;
    return { area, line, lo, hi };
  }, [dist, ele, total]);

  const meters = (clientX: number): number => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(total, Math.max(0, ((clientX - r.left) / r.width) * total));
  };
  const set = (which: Handle, m: number) => {
    if (which === 'start') onChange([Math.max(0, Math.min(m, to - minGapM)), to]);
    else onChange([from, Math.min(total, Math.max(m, from + minGapM))]);
  };
  const key = (which: Handle) => (e: React.KeyboardEvent) => {
    const cur = which === 'start' ? from : to;
    const step = e.shiftKey ? 100 : 10;
    let next: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step;
    else if (e.key === 'Home') next = which === 'start' ? 0 : from + minGapM;
    else if (e.key === 'End') next = which === 'start' ? to - minGapM : total;
    if (next === null) return;
    e.preventDefault();
    set(which, next);
  };

  const pct = (m: number) => `${(m / Math.max(1, total)) * 100}%`;
  const handle = (which: Handle, m: number) => (
    <div
      role="slider"
      tabIndex={0}
      aria-label={which === 'start' ? t('maps.segments.new.startHandle') : t('maps.segments.new.endHandle')}
      aria-orientation="horizontal"
      aria-valuemin={which === 'start' ? 0 : Math.round(from + minGapM)}
      aria-valuemax={which === 'start' ? Math.round(to - minGapM) : Math.round(total)}
      aria-valuenow={Math.round(m)}
      aria-valuetext={fmt.distance(m, 2)}
      onKeyDown={key(which)}
      className={cn(
        'absolute top-0 z-10 flex h-full w-6 -translate-x-1/2 cursor-ew-resize touch-none items-stretch justify-center outline-none',
        'focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-accent',
      )}
      style={{ left: pct(m) }}
    >
      <span className={cn('relative w-1 rounded-full bg-accent', active === which && 'w-1.5')}>
        <span className="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-card" />
      </span>
    </div>
  );

  return (
    <div className={className}>
      <div
        ref={box}
        className="relative h-28 touch-none select-none overflow-hidden rounded-control border border-border bg-surface-2"
        onPointerMove={(e) => {
          const m = meters(e.clientX);
          if (active) set(active, m);
          else onHover?.(m);
        }}
        onPointerLeave={() => !active && onHover?.(null)}
        onPointerDown={(e) => {
          // pressing anywhere grabs the nearer handle (or the one on that side) and moves it there; drag to adjust
          const m = meters(e.clientX);
          const which: Handle = m <= from ? 'start' : m >= to ? 'end' : Math.abs(m - from) <= Math.abs(m - to) ? 'start' : 'end';
          e.currentTarget.setPointerCapture(e.pointerId);
          setActive(which);
          set(which, m);
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          setActive(null);
        }}
        onPointerCancel={() => setActive(null)}
      >
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden>
          {area && <path d={area} fill="var(--accent)" opacity={0.14} />}
          {line && (
            <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          )}
        </svg>
        {/* what is not selected is dimmed */}
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-surface/70" style={{ width: pct(from) }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-surface/70" style={{ width: `calc(100% - ${pct(to)})` }} />
        {handle('start', from)}
        {handle('end', to)}
        {lo !== null && hi !== null && (
          <>
            <span className="pointer-events-none absolute left-1.5 top-1 text-[10px] font-medium text-fg-3 tabular">{fmt.elevation(hi)}</span>
            <span className="pointer-events-none absolute bottom-1 left-1.5 text-[10px] font-medium text-fg-3 tabular">{fmt.elevation(lo)}</span>
          </>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-fg-3 tabular">
        <span>0</span>
        <span>{fmt.distance(total, 1)}</span>
      </div>
    </div>
  );
}
