/**
 * Tiny trend line for stat tiles (same look as components/charts/Sparkline: de-emphasis gray line, current
 * point in the accent). The end dot is an HTML element, so it stays round however wide the line is stretched
 * (an SVG circle inside a preserveAspectRatio="none" viewBox turns into an ellipse).
 */
export function Spark({
  data,
  height = 32,
  ariaLabel,
  className,
}: {
  data: (number | null)[];
  height?: number;
  ariaLabel?: string;
  className?: string;
}) {
  const pts = data.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null && Number.isFinite(p[1]));
  if (pts.length < 2) return <div style={{ height }} className={className} />;
  const min = Math.min(...pts.map((p) => p[1]));
  const max = Math.max(...pts.map((p) => p[1]));
  const span = max - min || 1;
  const xPct = (i: number) => (i / (data.length - 1)) * 100;
  const y = (v: number) => 4 + (1 - (v - min) / span) * (height - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xPct(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <div className={`relative ${className ?? ''}`} style={{ height }} role="img" aria-label={ariaLabel}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
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
      <span
        aria-hidden
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-[1.5px] ring-surface"
        style={{ left: `${xPct(last[0])}%`, top: y(last[1]) }}
      />
    </div>
  );
}
