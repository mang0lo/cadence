import { useId } from 'react';

/**
 * Tiny trend line (value up = better) with the latest point marked. Like the shared Sparkline, but the end marker is
 * an HTML dot: inside a non-uniformly scaled SVG a <circle> turns into an ellipse.
 */
export function TrendSparkline({
  data,
  height = 30,
  ariaLabel,
  className,
}: {
  data: number[];
  height?: number;
  ariaLabel?: string;
  className?: string;
}) {
  const id = useId();
  if (data.length < 2) return <div style={{ height }} className={className} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 4;
  const x = (i: number) => (i / (data.length - 1)) * 100;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - 2 * pad);
  const d = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const last = data[data.length - 1]!;
  return (
    <div className={className} style={{ position: 'relative', height }}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby={ariaLabel ? id : undefined}
        aria-hidden={ariaLabel ? undefined : true}
        style={{ width: '100%', height, overflow: 'visible', display: 'block' }}
      >
        {ariaLabel && <title id={id}>{ariaLabel}</title>}
        <path d={d} fill="none" stroke="var(--axis-text)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: '100%',
          top: y(last),
          width: 8,
          height: 8,
          transform: 'translate(-50%, -50%)',
          borderRadius: 9999,
          background: 'var(--accent)',
          boxShadow: '0 0 0 2px var(--surface)',
        }}
      />
    </div>
  );
}
