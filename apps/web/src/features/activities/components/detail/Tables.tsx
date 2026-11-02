import { useMemo, useState } from 'react';
import { Flag, ListOrdered, MapPin, Timer, Zap } from 'lucide-react';
import { M_PER_KM, M_PER_MI, type ActivityAnalysis, type ActivityLap, type WorkoutDetail } from '@cadence/shared';
import { Card, CardHeader, IconButton, SegmentedControl, Table, TD, TH, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { sportColorVar } from '@/lib/sports';
import { effortLabel, isPaceSport, shortDistanceParts } from '../../lib/display';
import { indexAtDist, indexAtTime, type Prepared } from '../../lib/streams';
import { MedalBadge } from '../MedalBadge';

type OnSelect = (s: [number, number] | null) => void;

/** Horizontal magnitude bar for table rows (square at the baseline, rounded data end). */
function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const f = max > 0 ? Math.max(0.04, Math.min(1, value / max)) : 0;
  return (
    <div className="h-2 min-w-12 flex-1 overflow-hidden rounded-r-[4px] bg-surface-2" aria-hidden>
      <div className="h-full rounded-r-[4px]" style={{ width: `${f * 100}%`, background: color }} />
    </div>
  );
}

/** "+12 m", "−3 m", "0 m" (sign of the rounded display value). */
function signedElevation(m: number, fmt: ReturnType<typeof useFormat>): string {
  const p = fmt.elevationParts(Math.abs(m));
  if (p.value === '0') return `0 ${p.unit}`;
  return `${m > 0 ? '+' : '−'}${p.value} ${p.unit}`;
}

const rowClass = (clickable: boolean, active = false) =>
  cn(clickable && 'cursor-pointer hover:bg-surface-2/70', active && 'bg-accent-soft');

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

export function Splits({ w, P, onSelect }: { w: WorkoutDetail; P: Prepared | null; onSelect: OnSelect }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const imperial = fmt.units === 'imperial';
  const splits = imperial ? w.splitsImperial : w.splitsMetric;
  const [active, setActive] = useState<number | null>(null);
  if (!splits.length) return null;
  const unit = imperial ? M_PER_MI : M_PER_KM;
  const pace = isPaceSport(w.sport);
  const full = splits.filter((s) => s.distanceM >= unit * 0.95);
  const maxSpeed = Math.max(...splits.map((s) => s.avgSpeed));
  const fastest = full.length > 1 ? full.reduce((a, b) => (b.avgSpeed > a.avgSpeed ? b : a)).idx : null;
  const starts = splits.map((_, i) => splits.slice(0, i).reduce((a, s) => a + s.distanceM, 0));
  const select = (i: number) => {
    if (!P?.dist) return;
    setActive(i);
    onSelect([indexAtDist(P, starts[i]!), indexAtDist(P, starts[i]! + splits[i]!.distanceM)]);
  };
  return (
    <Card className="min-w-0">
      <CardHeader title={t('activities.splits.title')} icon={ListOrdered} />
      <Table className="max-h-[28rem]">
        <thead>
          <tr>
            <TH>{imperial ? t('activities.splits.mi') : t('activities.splits.km')}</TH>
            <TH className="w-1/2">
              {pace ? t('activities.splits.pace') : t('activities.splits.speed')} ({fmt.paceParts(1, w.sport).unit})
            </TH>
            <TH numeric>{t('activities.splits.elev')}</TH>
            <TH numeric>{t('activities.splits.hr')}</TH>
          </tr>
        </thead>
        <tbody>
          {splits.map((s, i) => {
            const partial = s.distanceM < unit * 0.95;
            return (
              <tr
                key={s.idx}
                className={rowClass(!!P?.dist, active === i)}
                onClick={() => select(i)}
                title={P?.dist ? t('activities.splits.select', { n: i + 1 }) : undefined}
              >
                <TD className="whitespace-nowrap tabular">
                  {partial ? fmt.distance(s.distanceM, 2) : i + 1}
                  {s.idx === fastest && (
                    <Zap size={12} className="ml-1 inline text-accent-fg" aria-label={t('activities.splits.fastest')} />
                  )}
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-right font-medium tabular text-fg">{fmt.paceParts(s.avgSpeed, w.sport).value}</span>
                    <Bar value={s.avgSpeed} max={maxSpeed} color={sportColorVar(w.sport)} />
                  </div>
                </TD>
                <TD numeric>{s.elevDiffM !== null ? signedElevation(s.elevDiffM, fmt) : '–'}</TD>
                <TD numeric>{s.avgHr ? fmt.int(s.avgHr) : '–'}</TD>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Laps / segments (swims: sets / lengths)
// ---------------------------------------------------------------------------

function LapTable({ laps, w, P, onSelect, kind }: { laps: ActivityLap[]; w: WorkoutDetail; P: Prepared | null; onSelect: OnSelect; kind: string }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [active, setActive] = useState<number | null>(null);
  const swim = w.sport === 'swim';
  const hasHr = laps.some((l) => l.avgHr !== null);
  const hasPower = laps.some((l) => l.avgPower !== null);
  const hasStroke = laps.some((l) => l.strokeStyle);
  const maxSpeed = Math.max(0, ...laps.map((l) => l.avgSpeed ?? 0));
  const dist = (m: number | null) => {
    if (m === null) return '–';
    if (swim) {
      const p = shortDistanceParts(m, fmt);
      return `${p.value} ${p.unit}`;
    }
    return fmt.distance(m, 2);
  };
  return (
    <Table className="max-h-[28rem]">
      <thead>
        <tr>
          <TH>{kind}</TH>
          <TH numeric>{t('activities.laps.time')}</TH>
          <TH numeric>{t('activities.laps.distance')}</TH>
          <TH className="w-1/3">
            {isPaceSport(w.sport) ? t('common.pace') : t('common.speed')} ({fmt.paceParts(1, w.sport).unit})
          </TH>
          {hasStroke && <TH>{t('activities.laps.stroke')}</TH>}
          {hasHr && <TH numeric>{t('activities.splits.hr')}</TH>}
          {hasPower && <TH numeric>{t('common.power')}</TH>}
        </tr>
      </thead>
      <tbody>
        {laps.map((l, i) => (
          <tr
            key={l.idx}
            className={rowClass(!!P, active === i)}
            onClick={() => {
              if (!P) return;
              setActive(i);
              onSelect([indexAtTime(P, l.startT), indexAtTime(P, l.endT)]);
            }}
          >
            <TD className="tabular">{i + 1}</TD>
            <TD numeric>{fmt.duration(l.durationS)}</TD>
            <TD numeric>{dist(l.distanceM)}</TD>
            <TD>
              {l.avgSpeed ? (
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-right font-medium tabular text-fg">{fmt.paceParts(l.avgSpeed, w.sport).value}</span>
                  <Bar value={l.avgSpeed} max={maxSpeed} color={sportColorVar(w.sport)} />
                </div>
              ) : (
                '–'
              )}
            </TD>
            {hasStroke && <TD>{l.strokeStyle ? t(`activities.laps.strokes.${l.strokeStyle}`) : '–'}</TD>}
            {hasHr && <TD numeric>{l.avgHr ? fmt.int(l.avgHr) : '–'}</TD>}
            {hasPower && <TD numeric>{l.avgPower ? fmt.int(l.avgPower) : '–'}</TD>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function Laps({ w, P, analysis, onSelect }: { w: WorkoutDetail; P: Prepared | null; analysis: ActivityAnalysis | undefined; onSelect: OnSelect }) {
  const { t } = useI18n();
  const swim = w.sport === 'swim';
  const laps = analysis?.laps ?? [];
  const segments = analysis?.segments ?? [];
  const tabs = (
    swim
      ? [
          { value: 'segment', label: t('activities.laps.setsTab'), rows: segments, kind: t('activities.laps.set') },
          { value: 'lap', label: t('activities.laps.lengthsTab'), rows: laps, kind: t('activities.laps.length') },
        ]
      : [
          { value: 'lap', label: t('activities.laps.lapsTab'), rows: laps, kind: t('activities.laps.lap') },
          { value: 'segment', label: t('activities.laps.segmentsTab'), rows: segments, kind: '#' },
        ]
  ).filter((x) => x.rows.length > 0);
  const [tab, setTab] = useState<string | null>(null);
  if (!tabs.length) return null;
  const current = tabs.find((x) => x.value === tab) ?? tabs[0]!;
  return (
    <Card className="min-w-0">
      <CardHeader
        title={t('activities.laps.title')}
        icon={Flag}
        actions={
          tabs.length > 1 ? (
            <SegmentedControl
              size="sm"
              value={current.value}
              onChange={setTab}
              items={tabs.map((x) => ({ value: x.value, label: x.label }))}
              label={t('activities.laps.title')}
            />
          ) : undefined
        }
      />
      <LapTable key={current.value} laps={current.rows} w={w} P={P} onSelect={onSelect} kind={current.kind} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Best efforts
// ---------------------------------------------------------------------------

export function BestEfforts({ w, P, onSelect }: { w: WorkoutDetail; P: Prepared | null; onSelect: OnSelect }) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const [active, setActive] = useState<string | null>(null);
  const efforts = useMemo(() => [...w.bestEfforts].sort((a, b) => a.distanceM - b.distanceM), [w.bestEfforts]);
  if (!efforts.length) return null;
  return (
    <Card className="min-w-0">
      <CardHeader title={t('activities.efforts.title')} subtitle={t('activities.efforts.subtitle')} icon={Timer} />
      <Table className="max-h-[28rem]">
        <thead>
          <tr>
            <TH>{t('activities.efforts.effort')}</TH>
            <TH numeric>{t('activities.efforts.time')}</TH>
            <TH numeric>{isPaceSport(w.sport) ? t('activities.efforts.pace') : t('common.speed')}</TH>
            <TH>{t('activities.efforts.rank')}</TH>
            <TH numeric>
              <span className="sr-only">{t('activities.efforts.select')}</span>
            </TH>
          </tr>
        </thead>
        <tbody>
          {efforts.map((e) => {
            const select = () => {
              if (!P) return;
              setActive(e.effort);
              onSelect([indexAtTime(P, e.startOffsetS), indexAtTime(P, e.startOffsetS + e.elapsedS)]);
            };
            return (
              <tr key={e.effort} className={rowClass(!!P, active === e.effort)} onClick={select}>
                <TD className="font-medium text-fg">{effortLabel(w.sport, e.effort, lang)}</TD>
                <TD numeric>{fmt.duration(e.elapsedS)}</TD>
                <TD numeric>{fmt.pace(e.distanceM / e.elapsedS, w.sport)}</TD>
                <TD>{e.rank ? <MedalBadge rank={e.rank} sport={w.sport} showEffort={false} /> : <span className="text-fg-3">–</span>}</TD>
                <TD numeric>
                  {P && (
                    <IconButton
                      icon={MapPin}
                      label={t('activities.efforts.select')}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        select();
                      }}
                    />
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
