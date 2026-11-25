import { ChevronLeft, ChevronRight } from 'lucide-react';
import { IconButton, Select } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SIZES } from '../../lib/listParams';

/** "Showing 26–50 of 312", the page size and the previous / next page. */
export function Pagination({
  page,
  size,
  total,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  onSize: (s: string) => void;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const pages = Math.max(1, Math.ceil(total / size));
  const from = total ? (page - 1) * size + 1 : 0;
  const to = Math.min(total, page * size);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-fg-2">
      <span className="tabular">{t('activities.list.showing', { from: fmt.int(from), to: fmt.int(to), total: fmt.int(total) })}</span>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-fg-3">
          {t('activities.list.perPage')}
          <span className="w-20">
            <Select value={String(size)} onChange={onSize} options={SIZES.map((s) => ({ value: s, label: s }))} className="h-8" />
          </span>
        </label>
        <IconButton icon={ChevronLeft} label={t('activities.list.prev')} disabled={page <= 1} onClick={() => onPage(page - 1)} />
        <span className="tabular">
          {fmt.int(page)} / {fmt.int(pages)}
        </span>
        <IconButton icon={ChevronRight} label={t('activities.list.next')} disabled={page >= pages} onClick={() => onPage(page + 1)} />
      </div>
    </div>
  );
}
