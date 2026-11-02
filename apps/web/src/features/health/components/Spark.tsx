import { cn } from '@/components/ui';

/**
 * Tiny trend line (pure SVG): de-emphasis gray line, the latest point as an accent dot with a surface ring.
 * Own implementation instead of components/charts/Sparkline because the shared one draws its end dot inside an SVG
 * with preserveAspectRatio="none", which squashes it into an ellipse; here the dot is an HTML overlay.
 * Gaps (null) are bridged so sparse metrics (weight, VO₂ max) still read as a line.
 */
export function Spark({
  data,
  height = 30,
  className,
  ariaLabel,
  dot = true,
}: {
  data: (number | null)[];
  height?: number;
  className?: string;
  ariaLabel?: string;
  dot?: boolean;
}) {
  const pts: { i: number; v: number }[] = [];
  data.forEach((v, i) => {
    if (v !== null && v !== undefined && Number.isFinite(v)) pts.push({ i, v });
  });
  if (pts.length < 2) return <div style={{ height }} className={className} aria-hidden />;
  const w = 100;
  const pad = 4;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  const span = max - min || 1;
  const x = (i: number) => (data.length > 1 ? (i / (data.length - 1)) * w : 0);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(2)},${y(p.v).toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <div className={cn('relative', className)} style={{ height }} role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
        <path
          d={d}
          fill="none"
          stroke="var(--axis-text)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      {dot && (
        <span
          aria-hidden
          className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
          style={{ left: `${x(last.i)}%`, top: y(last.v), boxShadow: '0 0 0 2px var(--surface)' }}
        />
      )}
    </div>
  );
}
