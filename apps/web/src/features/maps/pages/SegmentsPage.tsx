import { useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Star, Waypoints } from 'lucide-react';
import type { MapsSegmentSummary, MapsSegmentsResponse } from '@cadence/shared';
import { RouteThumbnail } from '@/components/map/RouteThumbnail';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Page,
  PageHeader,
  Skeleton,
  Table,
  TD,
  TH,
  cn,
} from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { SportIcon, sportColorVar, useSportLabel } from '@/lib/sports';
import { dateHint } from '../lib/dates';

export default function SegmentsPage() {
  const t = useT();
  const fmt = useFormat();
  const sportLabel = useSportLabel();
  const qc = useQueryClient();
  const q = useApi<MapsSegmentsResponse>(['maps', 'segments'], '/maps/segments');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  const toggleStar = async (s: MapsSegmentSummary) => {
    setBusy(s.id);
    setError(null);
    try {
      await api.patch(`/maps/segments/${s.id}`, { starred: !s.starred });
      await qc.invalidateQueries({ queryKey: ['maps'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const items = q.data?.items ?? [];
  return (
    <Page>
      <PageHeader
        icon={Waypoints}
        title={t('maps.titles.SegmentsPage')}
        subtitle={t('maps.segments.subtitle')}
        actions={
          <Link to="/maps/segments/new">
            <Button variant="primary" icon={Plus}>
              {t('maps.segments.newSegment')}
            </Button>
          </Link>
        }
      />
      {q.isError && <ErrorState error={q.error} />}
      {error != null && <ErrorState error={error} className="mb-3" />}
      {!q.data && !q.isError && <Skeleton className="h-72 w-full rounded-card" />}

      {q.data && items.length === 0 && (
        <Card>
          <EmptyState
            icon={Waypoints}
            title={t('maps.segments.empty')}
            description={t('maps.segments.emptyHint')}
            action={
              <Link to="/maps/segments/new">
                <Button variant="primary" icon={Plus}>
                  {t('maps.segments.newSegment')}
                </Button>
              </Link>
            }
          />
        </Card>
      )}

      {items.length > 0 && (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <TH className="w-10">
                  <span className="sr-only">{t('maps.segments.starred')}</span>
                </TH>
                <TH>{t('maps.segments.segment')}</TH>
                <TH numeric>{t('common.distance')}</TH>
                <TH numeric>{t('maps.segments.avgGrade')}</TH>
                <TH numeric className="hidden xl:table-cell">
                  {t('common.elevationGain')}
                </TH>
                <TH numeric>{t('maps.segments.efforts')}</TH>
                <TH numeric>{t('maps.segments.pr')}</TH>
                <TH numeric className="hidden lg:table-cell">
                  {t('maps.segments.lastEffort')}
                </TH>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="group hover:bg-surface-2">
                  <TD className="w-10 !pr-0">
                    <button
                      type="button"
                      aria-pressed={s.starred}
                      aria-label={s.starred ? t('maps.segments.unstar') : t('maps.segments.star')}
                      title={s.starred ? t('maps.segments.unstar') : t('maps.segments.star')}
                      disabled={busy === s.id}
                      onClick={() => void toggleStar(s)}
                      className={cn(
                        'grid size-8 place-items-center rounded-control transition-colors hover:bg-surface-3',
                        s.starred ? 'text-accent-fg' : 'text-fg-3 hover:text-fg',
                      )}
                    >
                      <Star size={16} fill={s.starred ? 'currentColor' : 'none'} />
                    </button>
                  </TD>
                  <TD>
                    <Link to={`/maps/segments/${s.id}`} className="flex min-w-0 items-center gap-3">
                      <RouteThumbnail
                        polyline={s.polyline}
                        color={sportColorVar(s.sport)}
                        width={88}
                        height={56}
                        strokeWidth={2.5}
                        className="h-11 w-[68px] shrink-0"
                      />
                      <span className="min-w-0">
                        <span className="block max-w-56 truncate font-medium text-fg group-hover:text-accent-fg">
                          {s.name}
                        </span>
                        <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-fg-3">
                          <span style={{ color: sportColorVar(s.sport) }}>
                            <SportIcon sport={s.sport} size={12} strokeWidth={2.5} />
                          </span>
                          {sportLabel(s.sport)}
                        </span>
                      </span>
                    </Link>
                  </TD>
                  <TD numeric>{fmt.distance(s.distanceM, 2)}</TD>
                  <TD numeric>{s.avgGradePct === null ? '–' : `${fmt.signed(s.avgGradePct, 1)} %`}</TD>
                  <TD numeric className="hidden xl:table-cell">
                    {s.elevationGainM === null ? '–' : fmt.elevation(s.elevationGainM)}
                  </TD>
                  <TD numeric>{fmt.int(s.efforts)}</TD>
                  <TD numeric>
                    {s.prTimeS === null ? (
                      '–'
                    ) : (
                      <>
                        <span className="font-semibold text-fg">{fmt.duration(s.prTimeS)}</span>
                        {s.prTs !== null && s.prTzMin !== null && (
                          <span className="block text-xs text-fg-3">
                            {dateHint(fmt, s.prTs, s.prTzMin)}
                          </span>
                        )}
                      </>
                    )}
                  </TD>
                  <TD numeric className="hidden lg:table-cell">
                    {s.lastTs !== null && s.lastTzMin !== null ? fmt.date(s.lastTs, s.lastTzMin, 'day') : '–'}
                  </TD>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </Page>
  );
}
