/**
 * Dashboard widgets of the "maps" feature, placed on the home page by the activities feature.
 * Each widget renders its own <Card> and fetches its own data; return null when there is nothing to show.
 */
import { Link } from 'react-router';
import { ArrowRight, Grid3x3 } from 'lucide-react';
import type { MapsExplorerSummary } from '@cadence/shared';
import { Card, CardHeader, Delta, ErrorState, Skeleton, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';

/** Explorer tiles at a glance: visited tiles, max square and the tiles that are new this month. */
export function ExplorerWidget() {
  const t = useT();
  const fmt = useFormat();
  const q = useApi<MapsExplorerSummary>(['maps', 'explorer-summary'], '/maps/explorer/summary');

  if (q.isError) {
    return (
      <Card>
        <CardHeader icon={Grid3x3} title={t('maps.widget.title')} />
        <ErrorState error={q.error} />
      </Card>
    );
  }
  if (!q.data) {
    // same height as the loaded card so the dashboard does not jump
    return (
      <Card>
        <CardHeader icon={Grid3x3} title={t('maps.widget.title')} />
        <Skeleton className="h-[4.25rem] w-full" />
      </Card>
    );
  }
  const d = q.data;
  if (d.tiles === 0) return null;
  const change = d.newThisMonth - d.newLastMonth;
  return (
    <Card className="@container">
      <CardHeader
        icon={Grid3x3}
        title={t('maps.widget.title')}
        actions={
          <Link
            to="/maps/explorer"
            className="inline-flex items-center gap-1 rounded-control px-2 py-1 text-xs font-medium text-accent-fg hover:bg-accent-soft"
          >
            {t('maps.widget.open')}
            <ArrowRight size={13} aria-hidden />
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-4 @sm:grid-cols-3">
        <Stat label={t('maps.explorer.stats.tiles')} value={fmt.int(d.tiles)} size="md" />
        <Stat
          label={t('maps.explorer.stats.maxSquare')}
          value={d.maxSquare ? `${d.maxSquare} × ${d.maxSquare}` : '–'}
          hint={d.maxSquare ? t('maps.explorer.stats.maxSquareHint', { count: d.maxSquare ** 2 }) : undefined}
          size="md"
        />
        <Stat
          label={t('maps.widget.newThisMonth')}
          value={fmt.int(d.newThisMonth)}
          delta={change !== 0 ? <Delta value={change} text={fmt.signed(change)} /> : undefined}
          hint={t('maps.explorer.stats.vsLastMonth')}
          size="md"
        />
      </div>
      <p className="mt-3 text-xs text-fg-3">{t('maps.widget.subtitle')}</p>
    </Card>
  );
}
