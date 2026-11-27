import type { ReactNode } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui';

/** Classes of a filter chip; exactly one height, padding and text size per size (cn does not merge conflicts). */
export const chipClass = (active: boolean, size: 'sm' | 'md' = 'md') =>
  cn(
    'inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
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
    <button type="button" className={chipClass(active, size)} aria-pressed={active} onClick={() => onChange(!active)}>
      {active ? <Check size={14} aria-hidden /> : <Icon size={14} aria-hidden />}
      {children}
    </button>
  );
}
