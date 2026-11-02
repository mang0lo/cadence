import { useMemo } from 'react';
import { cn } from '@/components/ui';
import { decodePolyline } from '@/lib/polyline';

/** Web Mercator projection (unit square). */
function project(lat: number, lon: number): [number, number] {
  const x = (lon + 180) / 360;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

/**
 * Lightweight route preview (SVG, no map tiles) for feeds and lists — hundreds can render at once,
 * unlike WebGL maps.
 */
export function RouteThumbnail({
  polyline,
  className,
  color = 'var(--accent)',
  width = 160,
  height = 100,
  strokeWidth = 2.5,
  ariaLabel,
}: {
  polyline: string | null | undefined;
  className?: string;
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  ariaLabel?: string;
}) {
  const path = useMemo(() => {
    if (!polyline) return null;
    const pts = decodePolyline(polyline).map(([la, lo]) => project(la, lo));
    if (pts.length < 2) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    const pad = 8;
    const span = Math.max(maxX - minX, maxY - minY) || 1e-9;
    const scale = Math.min((width - 2 * pad) / (maxX - minX || span), (height - 2 * pad) / (maxY - minY || span));
    const ox = (width - (maxX - minX) * scale) / 2;
    const oy = (height - (maxY - minY) * scale) / 2;
    const d = pts
      .map(([x, y], i) => `${i ? 'L' : 'M'}${(ox + (x - minX) * scale).toFixed(1)},${(oy + (y - minY) * scale).toFixed(1)}`)
      .join('');
    const [sx, sy] = pts[0]!;
    const [ex, ey] = pts[pts.length - 1]!;
    return {
      d,
      start: [ox + (sx - minX) * scale, oy + (sy - minY) * scale] as const,
      end: [ox + (ex - minX) * scale, oy + (ey - minY) * scale] as const,
    };
  }, [polyline, width, height]);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn('block rounded-control bg-surface-2', className)}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="xMidYMid meet"
    >
      {path && (
        <>
          <path d={path.d} fill="none" stroke="var(--surface)" strokeWidth={strokeWidth + 2.5} strokeLinecap="round" strokeLinejoin="round" />
          <path d={path.d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={path.end[0]} cy={path.end[1]} r={3.5} fill="var(--fg)" stroke="var(--surface)" strokeWidth={1.5} />
          <circle cx={path.start[0]} cy={path.start[1]} r={3.5} fill="var(--good)" stroke="var(--surface)" strokeWidth={1.5} />
        </>
      )}
    </svg>
  );
}
