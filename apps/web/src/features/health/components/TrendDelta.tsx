import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { GoodDirection } from '@cadence/shared';
import { Delta, cn } from '@/components/ui';

/**
 * Signed change with arrow. Colored good/bad (always with the arrow icon and the signed text) when the metric has a
 * preferred direction; neutral gray when it depends on the person's goal (e.g. body weight).
 */
export function TrendDelta({
  value,
  text,
  good,
  className,
}: {
  /** Rounded signed change (decides direction). */
  value: number;
  text: string;
  good: GoodDirection;
  className?: string;
}) {
  if (good === null) {
    const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
    return (
      <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium text-fg-3', className)}>
        <Icon size={14} aria-hidden />
        {text}
      </span>
    );
  }
  return <Delta value={value} text={text} upIsGood={good === 'up'} className={className} />;
}
