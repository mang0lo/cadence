import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { useT } from '@/lib/i18n';

/** ‹ 2026 › — steps through the years that have data. */
export function YearSwitcher({
  year,
  years,
  onChange,
  size = 'md',
}: {
  year: number;
  years: number[];
  onChange: (y: number) => void;
  size?: 'md' | 'lg';
}) {
  const t = useT();
  const first = years[0] ?? year;
  const last = years[years.length - 1] ?? year;
  // step to the nearest year that has data
  const prev = [...years].reverse().find((y) => y < year);
  const next = years.find((y) => y > year);
  return (
    <div className="inline-flex items-center gap-1 rounded-control border border-border bg-surface px-1 py-0.5 shadow-card">
      <IconButton
        icon={ChevronLeft}
        label={t('consistency.common.prevYear')}
        disabled={prev === undefined || year <= first}
        className="disabled:opacity-30"
        onClick={() => prev !== undefined && onChange(prev)}
      />
      <select
        aria-label={t('common.year')}
        value={year}
        onChange={(e) => onChange(Number(e.target.value))}
        className={
          size === 'lg'
            ? 'cursor-pointer appearance-none bg-transparent px-1 text-center text-lg font-semibold text-fg focus:outline-none'
            : 'cursor-pointer appearance-none bg-transparent px-1 text-center text-sm font-semibold text-fg focus:outline-none'
        }
      >
        {(years.includes(year) ? years : [...years, year].sort()).map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <IconButton
        icon={ChevronRight}
        label={t('consistency.common.nextYear')}
        disabled={next === undefined || year >= last}
        className="disabled:opacity-30"
        onClick={() => next !== undefined && onChange(next)}
      />
    </div>
  );
}
