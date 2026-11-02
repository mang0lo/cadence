import { useId, type ReactNode } from 'react';
import { cn } from '@/components/ui';

/**
 * Labelled group for controls that are not a single form element (e.g. SegmentedControl). The shared
 * <Field> wraps its children in a <label>, which would hand the whole label text to the first radio button.
 */
export function FieldGroup({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={cn('flex flex-col gap-1.5', className)}>
      <span id={id} className="text-xs font-medium text-fg-2">
        {label}
      </span>
      {children}
    </div>
  );
}
