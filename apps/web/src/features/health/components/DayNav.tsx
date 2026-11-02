import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton, Input } from '@/components/ui';
import { addDays } from '@/lib/time';

/**
 * Previous / next buttons + native date picker. With `days` (sorted list of days that have data) the buttons jump to
 * the adjacent day with data, otherwise ±1 calendar day.
 */
export function DayNav({
  day,
  onChange,
  min,
  max,
  days,
  prevLabel,
  nextLabel,
  pickLabel,
}: {
  day: string;
  onChange: (day: string) => void;
  min?: string;
  max?: string;
  days?: string[];
  prevLabel: string;
  nextLabel: string;
  pickLabel: string;
}) {
  let prev: string | null;
  let next: string | null;
  if (days) {
    const i = days.indexOf(day);
    if (i >= 0) {
      prev = days[i - 1] ?? null;
      next = days[i + 1] ?? null;
    } else {
      prev = [...days].reverse().find((d) => d < day) ?? null;
      next = days.find((d) => d > day) ?? null;
    }
  } else {
    prev = !min || day > min ? addDays(day, -1) : null;
    next = !max || day < max ? addDays(day, 1) : null;
  }
  return (
    <div className="flex items-center gap-1">
      <IconButton icon={ChevronLeft} label={prevLabel} disabled={!prev} onClick={() => prev && onChange(prev)} className="disabled:opacity-40" />
      <Input
        type="date"
        aria-label={pickLabel}
        value={day}
        min={min}
        max={max}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="w-[9.5rem]"
      />
      <IconButton icon={ChevronRight} label={nextLabel} disabled={!next} onClick={() => next && onChange(next)} className="disabled:opacity-40" />
    </div>
  );
}
