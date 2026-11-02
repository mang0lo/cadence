import { Link } from 'react-router';
import { CalendarClock, Upload } from 'lucide-react';
import { Button, EmptyState } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';

/** Shown when the imported data ends before today: numbers are "as of" the last data day. */
export function AsOfNote({ asOf, today }: { asOf: string; today: string }) {
  const t = useT();
  const fmt = useFormat();
  if (asOf >= today) return null;
  return (
    <div className="flex items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-2 text-sm text-fg-2">
      <CalendarClock size={16} className="shrink-0 text-fg-3" aria-hidden />
      <span className="min-w-0">{t('consistency.common.dataUntil', { date: fmt.day(asOf, 'day') })}</span>
      <Link to="/import" className="ml-auto shrink-0 text-xs font-medium text-accent-fg hover:underline">
        {t('common.importNow')}
      </Link>
    </div>
  );
}

/** Empty state for pages without any activity yet. */
export function NoActivities({ className }: { className?: string }) {
  const t = useT();
  return (
    <EmptyState
      className={className}
      icon={Upload}
      title={t('consistency.common.noData')}
      description={t('consistency.common.noDataHint')}
      action={
        <Link to="/import">
          <Button variant="primary" icon={Upload}>
            {t('common.importNow')}
          </Button>
        </Link>
      }
    />
  );
}
