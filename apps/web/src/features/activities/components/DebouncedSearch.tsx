import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Input, cn } from '@/components/ui';

/**
 * Search box that commits its text `delay` ms after the last keystroke. The commit always goes through the latest
 * `onChange` (a callback captured at the keystroke could write an outdated URL over a filter changed meanwhile). A
 * new `value` from outside (back button, reset) replaces the text; remount it (`key`) to drop a pending commit.
 */
export function DebouncedSearch({
  value,
  onChange,
  label,
  placeholder,
  delay = 300,
  className,
}: {
  /** The committed search text. */
  value: string;
  onChange: (q: string) => void;
  label: string;
  placeholder?: string;
  delay?: number;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const commit = useRef(onChange);
  useLayoutEffect(() => {
    commit.current = onChange;
  });
  // keep what is typed when it only differs by surrounding spaces (the commit is trimmed)
  useEffect(() => setText((cur) => (cur.trim() === value ? cur : value)), [value]);
  const committed = useRef(value);
  committed.current = value;
  useEffect(() => {
    if (text.trim() === committed.current) return;
    const id = window.setTimeout(() => commit.current(text.trim()), delay);
    return () => window.clearTimeout(id);
  }, [text, delay]);
  return (
    <div className={cn('relative', className)}>
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3" aria-hidden />
      <Input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-8"
      />
    </div>
  );
}
