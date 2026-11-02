import { cn } from '@/components/ui';
import type { StatItem } from '../lib/display';

/** Compact inline stats (label above value) for cards and list rows. */
export function StatList({ items, className, size = 'md' }: { items: StatItem[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <dl className={cn('flex flex-wrap gap-x-6 gap-y-2', className)}>
      {items.map((s) => (
        <div key={s.key} className="min-w-0">
          <dt className="truncate text-xs text-fg-3">{s.label}</dt>
          <dd className={cn('whitespace-nowrap font-semibold text-fg', size === 'md' ? 'text-lg' : 'text-sm')}>
            {s.value}
            {s.unit && <span className="ml-0.5 text-xs font-medium text-fg-3">{s.unit}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
