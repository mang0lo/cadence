import { useResolvedTheme } from '@/lib/theme';
import { RING_COLORS, RINGS, type Ring } from '../lib';

/**
 * Apple-style activity rings (Move outside, Exercise, Stand inside). Each ring fills value / goal;
 * a second lap (> 100 %) is drawn over the full ring with a surface-colored seam at its start.
 * Apple's red/green/blue are used only here (see lib.ts).
 */
export function RingGlyph({
  move,
  exercise,
  stand,
  size = 40,
  label,
  className,
}: {
  move: number | null;
  exercise: number | null;
  stand: number | null;
  size?: number;
  label?: string;
  className?: string;
}) {
  const theme = useResolvedTheme();
  const colors = RING_COLORS[theme];
  const values: Record<Ring, number | null> = { move, exercise, stand };
  const w = Math.max(2.5, size * 0.13);
  const gap = Math.max(0.6, size * 0.025);
  const c = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
    >
      {RINGS.map((ring, i) => {
        const r = c - w / 2 - i * (w + gap);
        if (r <= w / 2) return null;
        const circ = 2 * Math.PI * r;
        const v = Math.max(0, values[ring] ?? 0);
        const lap1 = Math.min(1, v);
        const lap2 = Math.min(1, Math.max(0, v - 1));
        const color = colors[ring];
        const arc = (f: number, key: string, seam = false) => (
          <circle
            key={key}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={seam ? 'var(--surface)' : color}
            strokeWidth={seam ? w + 1 : w}
            strokeLinecap="round"
            strokeDasharray={`${Math.max(0.001, f * circ)} ${circ}`}
            transform={`rotate(-90 ${c} ${c})`}
          />
        );
        return (
          <g key={ring}>
            <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeOpacity={0.2} strokeWidth={w} />
            {lap1 > 0 && arc(lap1, 'a')}
            {lap2 > 0.02 && (
              <>
                {arc(Math.min(lap2, 0.97), 'seam', true)}
                {arc(lap2, 'b')}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Small legend for the ring glyphs (Apple colors as swatches; text stays in text tokens). */
export function RingLegend({ labels }: { labels: Record<Ring, string> }) {
  const theme = useResolvedTheme();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
      {RINGS.map((r) => (
        <span key={r} className="inline-flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full" style={{ background: RING_COLORS[theme][r] }} />
          {labels[r]}
        </span>
      ))}
    </div>
  );
}
