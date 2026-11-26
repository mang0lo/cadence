import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Trophy } from 'lucide-react';
import { workoutTitle } from '@cadence/shared';
import { Badge, Button, Card, CardHeader, Table, TD, TH, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n, useT } from '@/lib/i18n';
import { SportIcon, sportColorVar, useSportLabel } from '@/lib/sports';
import {
  defaultSortDir,
  showsPace,
  sortEfforts,
  speedLabelKey,
  type EffortSort,
  type EffortSortCol,
} from '../lib/effortSort';

/** One effort on a route or a segment. */
export interface EffortRow {
  /** Unique per row (a workout can pass a segment more than once). */
  key: string;
  workoutId: number;
  name: string;
  sport: string;
  startTs: number;
  tzMin: number;
  timeS: number;
  /** Moving time, shown under the time when it differs noticeably (segments). */
  movingS?: number | null;
  avgSpeed: number | null;
  avgHr: number | null;
  rank: number;
  /** The best effort: badge in the rank column, highlighted row. */
  best: boolean;
  /** Was the best effort when it was done (segments). */
  pr?: boolean;
}

const PAGE = 15;

/**
 * Sortable efforts of a route or segment, the first 15 until "show all". The pace column sorts by the paces (or
 * speeds) it shows, fastest first, so the sort arrow always matches the numbers.
 */
export function EffortTable({
  title,
  subtitle,
  rows,
  sport,
  bestLabel,
  leaderboard = false,
  initialSort,
}: {
  title: string;
  subtitle?: string;
  rows: EffortRow[];
  /** Sport of the route or segment (pace or speed column). */
  sport: string;
  /** Text of the best effort's badge. */
  bestLabel: string;
  /** Leaderboard layout: rank first, times emphasized (segments). Otherwise date first, rank last (routes). */
  leaderboard?: boolean;
  initialSort: EffortSort;
}) {
  const t = useT();
  const fmt = useFormat();
  const { lang } = useI18n();
  const sportLabel = useSportLabel();
  const pace = showsPace(sport);
  const [sort, setSort] = useState<EffortSort>(initialSort);
  const [all, setAll] = useState(false);
  const mixed = useMemo(() => new Set(rows.map((r) => r.sport)).size > 1, [rows]);
  const sorted = useMemo(() => sortEfforts(rows, sort, pace), [rows, sort, pace]);
  const visible = all ? sorted : sorted.slice(0, PAGE);

  const th = (col: EffortSortCol, label: string, numeric = false, className?: string) => (
    <TH
      numeric={numeric}
      className={className}
      onClick={() =>
        setSort((s) =>
          s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: defaultSortDir(col, pace) },
        )
      }
      sorted={sort.col === col ? sort.dir : null}
    >
      {label}
    </TH>
  );
  const rankCell = (r: EffortRow): ReactNode => (
    <TD numeric>
      {r.best ? (
        <Badge tone="good" icon={Trophy}>
          {bestLabel}
        </Badge>
      ) : (
        <span className="tabular">{r.rank}</span>
      )}
    </TD>
  );

  return (
    <Card padded={false}>
      <div className="p-4 pb-0 sm:p-5 sm:pb-0">
        <CardHeader title={title} subtitle={subtitle} />
      </div>
      <Table>
        <thead>
          <tr>
            {leaderboard && th('rank', t('maps.routes.rank'), true, 'w-16')}
            {th('date', t('common.day'))}
            {th('time', t('maps.routes.time'), true)}
            {th('pace', t(speedLabelKey(sport)), true)}
            {th('hr', t('common.avgHr'), true)}
            {!leaderboard && th('rank', t('maps.routes.rank'), true)}
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.key} className={cn('hover:bg-surface-2', r.best && 'bg-good/5')}>
              {leaderboard && rankCell(r)}
              <TD>
                <Link to={`/activities/${r.workoutId}`} className="font-medium text-fg hover:text-accent-fg">
                  {fmt.date(r.startTs, r.tzMin, 'day')}
                </Link>
                <span className="ml-2 text-xs text-fg-3">
                  {fmt.time(r.startTs, r.tzMin)} · {workoutTitle(r, lang)}
                </span>
                {mixed && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-fg-3">
                    <span style={{ color: sportColorVar(r.sport) }}>
                      <SportIcon sport={r.sport} size={12} strokeWidth={2.5} />
                    </span>
                    {sportLabel(r.sport)}
                  </span>
                )}
                {r.pr && !r.best && (
                  <Badge tone="neutral" className="ml-2" icon={Trophy}>
                    {t('maps.segments.wasPr')}
                  </Badge>
                )}
              </TD>
              <TD numeric>
                <span className={cn(leaderboard && 'font-semibold text-fg')}>{fmt.duration(r.timeS)}</span>
                {r.movingS != null && Math.abs(r.movingS - r.timeS) >= 5 && (
                  <span className="block text-xs text-fg-3">
                    {t('common.movingTime')} {fmt.duration(r.movingS)}
                  </span>
                )}
              </TD>
              <TD numeric>{fmt.pace(r.avgSpeed, r.sport)}</TD>
              <TD numeric>{r.avgHr ? fmt.hr(r.avgHr) : '–'}</TD>
              {!leaderboard && rankCell(r)}
            </tr>
          ))}
        </tbody>
      </Table>
      {sorted.length > PAGE && (
        <div className="flex justify-center p-3">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? t('common.less') : t('maps.routes.showAllEfforts', { count: fmt.int(sorted.length) })}
          </Button>
        </div>
      )}
    </Card>
  );
}
