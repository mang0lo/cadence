import type { ReactNode } from 'react';
import { Layers } from 'lucide-react';
import { sportInfo, type ActivityAnalysis, type WorkoutDetail } from '@cadence/shared';
import { Card, CardHeader, ErrorState, Skeleton, Table, TD, TH } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { SportBadge } from '@/lib/sports';
import { useSimilar } from '../../api';
import type { Prepared } from '../../lib/streams';
import { HrHistogram, HrZones, PaceHistogram } from './Distributions';
import { Climbs, Insights } from './Insights';
import { Similar } from './Similar';
import { BestEfforts, Laps, Splits } from './Tables';

export interface SectionProps {
  w: WorkoutDetail;
  P: Prepared | null;
  analysis: ActivityAnalysis | undefined;
  /** The analysis request is still running / failed. */
  analysisLoading?: boolean;
  analysisError?: unknown;
  zoneBounds: number[];
  onSelect: (s: [number, number] | null) => void;
}

/** Multisport legs (iOS 16+ WorkoutActivity). */
function Legs({ w }: { w: WorkoutDetail }) {
  const { t } = useI18n();
  const fmt = useFormat();
  if (w.activities.length < 2) return null;
  const distance = (stats: WorkoutDetail['stats']) =>
    stats.find((s) => s.type.startsWith('HKQuantityTypeIdentifierDistance') && s.sum)?.sum ?? null;
  return (
    <Card className="min-w-0">
      <CardHeader title={t('activities.detail.multisport')} icon={Layers} />
      <Table>
        <thead>
          <tr>
            <TH>{t('activities.detail.leg')}</TH>
            <TH>{t('common.sport')}</TH>
            <TH numeric>{t('activities.stats.duration')}</TH>
            <TH numeric>{t('common.distance')}</TH>
          </tr>
        </thead>
        <tbody>
          {w.activities.map((a) => (
            <tr key={a.idx}>
              <TD>{a.idx + 1}</TD>
              <TD>
                <SportBadge sport={a.sport} />
              </TD>
              <TD numeric>{fmt.duration(a.durationS ?? a.endTs - a.startTs)}</TD>
              <TD numeric>{distance(a.stats) !== null ? fmt.distance(distance(a.stats)) : '–'}</TD>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/** Two-column grid that collapses empty cells (each child may render null). */
function Pair({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid items-start gap-4 empty:hidden xl:grid-cols-2">{children}</div>;
}

/** Splits, laps, zones, best efforts, analysis cards, climbs, histograms and the comparison with similar efforts. */
export function AnalysisSections({ w, P, analysis, analysisLoading, analysisError, zoneBounds, onSelect }: SectionProps) {
  const similar = useSimilar(w.id);
  const hasSpeed = !!P?.speed && !!P.dist && sportInfo(w.sport).speedMode !== 'none';
  return (
    <>
      <Pair>
        <Legs w={w} />
        <Splits w={w} P={P} onSelect={onSelect} />
        <Laps w={w} P={P} analysis={analysis} onSelect={onSelect} />
        <HrZones w={w} zoneBounds={zoneBounds} />
        <BestEfforts w={w} P={P} onSelect={onSelect} />
      </Pair>
      {analysisError ? <ErrorState error={analysisError} className="mb-4" /> : null}
      <div className="mb-4 empty:hidden">
        {analysisLoading && !analysis && P ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-44" />
            ))}
          </div>
        ) : (
          <Insights w={w} analysis={analysis} similar={similar.data} />
        )}
      </div>
      <div className="mb-4 empty:hidden">
        <Climbs analysis={analysis} P={P} onSelect={onSelect} />
      </div>
      {P && (
        <Pair>
          {hasSpeed && <PaceHistogram P={P} sport={w.sport} />}
          {P.hr && <HrHistogram P={P} zoneBounds={zoneBounds} />}
        </Pair>
      )}
      <Similar w={w} similar={similar.data} loading={similar.isLoading} error={similar.error} />
    </>
  );
}
