import type { ReactNode } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui';

export const chipClass = (active: boolean) =>
  cn(
    'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors',
    active ? 'border-accent bg-accent-soft text-fg' : 'border-border-strong bg-surface text-fg-2 hover:bg-surface-2 hover:text-fg',
  );

/** On/off filter as a chip (pressed state = check mark + accent outline). */
export function ToggleChip({
  active,
  onChange,
  icon: Icon,
  children,
  size = 'md',
}: {
  active: boolean;
  onChange: (v: boolean) => void;
  icon: LucideIcon;
  children: ReactNode;
  size?: 'sm' | 'md';
}) {
  return (
    <button
      type="button"
      className={cn(chipClass(active), size === 'sm' && 'h-7 px-2.5 text-xs')}
      aria-pressed={active}
      onClick={() => onChange(!active)}
    >
      {active ? <Check size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
      {children}
    </button>
  );
}
