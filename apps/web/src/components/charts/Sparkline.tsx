/**
 * Tiny trend line for stat tiles: de-emphasis gray line, current (last) point in the accent.
 * Pure SVG (no chart library), scales to its container width. The end dot is an HTML element so it stays
 * round however wide the line is stretched (a circle inside a preserveAspectRatio="none" SVG becomes an ellipse).
 */
export function Sparkline({
  data,
  height = 28,
  color = 'var(--axis-text)',
  accent = 'var(--accent)',
  className,
  ariaLabel,
}: {
  data: (number | null)[];
  height?: number;
  color?: string;
  accent?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const pts = data
    .map((v, i) => [i, v] as const)
    .filter((p): p is readonly [number, number] => p[1] != null && Number.isFinite(p[1]));
  if (pts.length < 2) return <div style={{ height }} className={className} />;
  const min = Math.min(...pts.map((p) => p[1]));
  const max = Math.max(...pts.map((p) => p[1]));
  const span = max - min || 1;
  const xPct = (i: number) => (i / (data.length - 1)) * 100;
  const y = (v: number) => 3 + (1 - (v - min) / span) * (height - 6);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xPct(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <div
      className={`relative ${className ?? ''}`}
      style={{ height }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        aria-hidden
      >
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <span
        aria-hidden
        className="absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-[1.5px] ring-surface"
        style={{ left: `${xPct(last[0])}%`, top: y(last[1]), background: accent }}
      />
    </div>
  );
}
