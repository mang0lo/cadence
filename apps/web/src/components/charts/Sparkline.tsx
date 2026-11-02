/**
 * Tiny trend line for stat tiles: de-emphasis gray line, current (last) point in the accent.
 * Pure SVG (no chart library), scales to its container width.
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
  const pts = data.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 2) return <div style={{ height }} className={className} />;
  const w = 100;
  const min = Math.min(...pts.map((p) => p[1]));
  const max = Math.max(...pts.map((p) => p[1]));
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * w;
  const y = (v: number) => 3 + (1 - (v - min) / span) * (height - 6);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)}`).join(' ');
  const last = pts[pts.length - 1]!;
  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={className}
      style={{ width: '100%', height, overflow: 'visible' }}
      role="img"
      aria-label={ariaLabel}
    >
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r={3} fill={accent} stroke="var(--surface)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
