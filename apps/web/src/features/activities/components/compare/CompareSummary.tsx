import { Scale } from 'lucide-react';
import type { WorkoutDetail } from '@cadence/shared';
import { Card, CardHeader, Delta, Table, TD, TH } from '@/components/ui';
import { clock, useFormat, type Formatter } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { summaryRows, type SummaryRow } from '../../lib/compare';
import { isPaceSport, speedDiff } from '../../lib/display';
import { SIDE_VAR } from './CompareMap';

const sign = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±');

/** Value and A − B difference of one row in the user's units; `dir` is the direction of the shown difference. */
function cells(r: SummaryRow, sport: string, fmt: Formatter): { a: string; b: string; diff: string | null; dir: number } {
  const v = (x: number | null, f: (n: number) => string) => (x === null ? '–' : f(x));
  switch (r.key) {
    case 'distance':
      return { a: v(r.a, fmt.distance), b: v(r.b, fmt.distance), diff: r.diff === null ? null : `${sign(r.diff)}${fmt.distance(Math.abs(r.diff))}`, dir: r.diff ?? 0 };
    case 'commonTime':
    case 'moving':
    case 'elapsed': {
      const d = r.diff === null ? null : Math.round(r.diff);
      return { a: v(r.a, fmt.duration), b: v(r.b, fmt.duration), diff: d === null ? null : `${sign(d)}${clock(Math.abs(d))}`, dir: d ?? 0 };
    }
    case 'speed': {
      const a = v(r.a, (x) => fmt.pace(x, sport));
      const b = v(r.b, (x) => fmt.pace(x, sport));
      if (r.a === null || r.b === null) return { a, b, diff: null, dir: 0 };
      // the difference of the paces (seconds per km / mi / 100 m: negative = A faster) or of the speeds
      const d = speedDiff(r.a, r.b, sport, fmt);
      return { a, b, diff: d?.text ?? null, dir: d?.value ?? 0 };
    }
    case 'avgHr':
    case 'maxHr':
      return { a: v(r.a, fmt.hr), b: v(r.b, fmt.hr), diff: r.diff === null ? null : `${fmt.signed(r.diff)} bpm`, dir: Math.round(r.diff ?? 0) };
    case 'elevation':
      return {
        a: v(r.a, fmt.elevation),
        b: v(r.b, fmt.elevation),
        diff: r.diff === null ? null : `${sign(Math.round(r.diff))}${fmt.elevation(Math.abs(r.diff))}`,
        dir: Math.round(r.diff ?? 0),
      };
    case 'power':
      return { a: v(r.a, fmt.power), b: v(r.b, fmt.power), diff: r.diff === null ? null : `${fmt.signed(r.diff)} W`, dir: Math.round(r.diff ?? 0) };
    case 'cadence':
      return {
        a: v(r.a, (x) => fmt.cadence(x, sport)),
        b: v(r.b, (x) => fmt.cadence(x, sport)),
        diff: r.diff === null ? null : fmt.signed(r.diff),
        dir: Math.round(r.diff ?? 0),
      };
  }
}

/**
 * Both activities' totals next to each other with the difference A − B. Times and pace/speed/power show whether A was
 * better (arrow + color); heart rate, elevation and distance only differ, they are not better or worse.
 */
export function CompareSummary({
  a,
  b,
  sport,
  common,
}: {
  a: WorkoutDetail;
  b: WorkoutDetail;
  sport: string;
  /** Times over the common distance (when the distances differ). */
  common: { distM: number; a: number; b: number } | null;
}) {
  const { t } = useI18n();
  const fmt = useFormat();
  const rows = summaryRows(a, b, common);
  const pace = isPaceSport(sport);
  const label = (r: SummaryRow) =>
    r.key === 'commonTime'
      ? t('activities.compare.summary.commonTime', { distance: fmt.distance(common!.distM) })
      : r.key === 'speed'
        ? t(pace ? 'activities.compare.summary.pace' : 'activities.compare.summary.speed')
        : t(`activities.compare.summary.${r.key}`);
  return (
    <Card className="mb-4 min-w-0">
      <CardHeader title={t('activities.compare.summary.title')} icon={Scale} />
      <Table>
        <thead>
          <tr>
            <TH>{t('activities.compare.summary.metric')}</TH>
            {(['a', 'b'] as const).map((s) => (
              <TH key={s} numeric>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-sm" style={{ background: SIDE_VAR[s] }} aria-hidden />
                  {s.toUpperCase()}
                </span>
              </TH>
            ))}
            <TH numeric>{t('activities.compare.summary.difference')}</TH>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const c = cells(r, sport, fmt);
            // a time or pace difference: lower is better (shown value is the time / pace difference)
            const upIsGood = r.key === 'speed' ? !pace : r.better === 'higher';
            return (
              <tr key={r.key}>
                <TD className="text-fg">{label(r)}</TD>
                <TD numeric>{c.a}</TD>
                <TD numeric>{c.b}</TD>
                <TD numeric>
                  {c.diff === null ? (
                    '–'
                  ) : r.better && c.dir !== 0 ? (
                    <Delta value={c.dir} upIsGood={upIsGood} text={c.diff} className="justify-end" />
                  ) : (
                    c.diff
                  )}
                </TD>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
