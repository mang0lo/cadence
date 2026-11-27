import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Gauge, HeartPulse, Mountain, MountainSnow, TrendingDown, Zap } from 'lucide-react';
import type { ActivityAnalysis, ActivityClimb, ActivitySimilar, WorkoutDetail } from '@cadence/shared';
import { Badge, Card, CardHeader, Delta, KeyValues, Table, TD, TH, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { isCycling, isPaceSport } from '../../lib/display';
import { indexAtDist, type Prepared } from '../../lib/streams';

type OnSelect = (s: [number, number] | null) => void;

function InsightCard({ title, icon, children, hint }: { title: string; icon: typeof Gauge; children: ReactNode; hint?: string }) {
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader title={title} icon={icon} />
      <div className="flex-1">{children}</div>
      {hint && <p className="mt-3 border-t border-border pt-2 text-xs text-fg-3">{hint}</p>}
    </Card>
  );
}

function BigValue({ value, unit }: { value: string; unit?: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-3xl font-semibold tracking-tight text-fg">{value}</span>
      {unit && <span className="text-sm font-medium text-fg-3">{unit}</span>}
    </div>
  );
}

function Decoupling({ a, sport }: { a: NonNullable<ActivityAnalysis['decoupling']>; sport: string }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const pct = a.pct;
  const status =
    pct < 5
      ? { tone: 'good' as const, icon: CheckCircle2, label: t('activities.analysis.coupled') }
      : pct < 10
        ? { tone: 'warning' as const, icon: AlertTriangle, label: t('activities.analysis.drift') }
        : { tone: 'critical' as const, icon: TrendingDown, label: t('activities.analysis.strongDrift') };
  const out = (v: number) => (a.basis === 'power' ? fmt.power(v) : isPaceSport(sport) ? fmt.pace(v, sport) : fmt.speed(v));
  return (
    <InsightCard title={t('activities.analysis.decoupling')} icon={HeartPulse} hint={t('activities.analysis.decouplingHint')}>
      <div className="flex flex-wrap items-center gap-3">
        <BigValue value={fmt.signed(pct, 1)} unit="%" />
        <Badge tone={status.tone} icon={status.icon}>
          {status.label}
        </Badge>
      </div>
      <KeyValues
        className="mt-3"
        items={[
          [t('activities.analysis.firstHalf'), `${out(a.first.output)} · ${fmt.hr(a.first.hr)}`],
          [t('activities.analysis.secondHalf'), `${out(a.second.output)} · ${fmt.hr(a.second.hr)}`],
        ]}
      />
    </InsightCard>
  );
}

function Efficiency({ a, similar }: { a: NonNullable<ActivityAnalysis['efficiency']>; similar: ActivitySimilar | undefined }) {
  const { t } = useI18n();
  const fmt = useFormat();
  // the similar activities' values are on similar.efficiencyBasis (the most common one while this activity's analysis
  // is outdated): compare only like with like, never W per bpm with m/min per bpm
  const sameBasis = similar?.efficiencyBasis === undefined || similar.efficiencyBasis === a.basis;
  const others = sameBasis
    ? (similar?.items ?? []).filter((x) => !x.current && x.efficiency !== null).map((x) => x.efficiency!)
    : [];
  const mean = others.length >= 3 ? others.reduce((s, v) => s + v, 0) / others.length : null;
  const unit =
    a.basis === 'power'
      ? t('activities.analysis.efficiencyUnitPower')
      : a.basis === 'gap'
        ? t('activities.analysis.efficiencyUnitGap')
        : t('activities.analysis.efficiencyUnitSpeed');
  return (
    <InsightCard title={t('activities.analysis.efficiency')} icon={Gauge} hint={t('activities.analysis.efficiencyHint')}>
      <BigValue value={fmt.num(a.value, 2)} />
      <div className="mt-0.5 text-xs text-fg-3">{unit}</div>
      {mean !== null && (
        <div className="mt-3">
          <Delta
            value={a.value - mean}
            text={t('activities.analysis.vsSimilar', { value: `${fmt.signed(((a.value - mean) / mean) * 100, 1)} %` })}
          />
        </div>
      )}
    </InsightCard>
  );
}

function Gap({ gap, actual, sport }: { gap: number; actual: number | null; sport: string }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const p = fmt.paceParts(gap, sport);
  return (
    <InsightCard title={t('activities.analysis.gap')} icon={Mountain} hint={t('activities.analysis.gapHint')}>
      <BigValue value={p.value} unit={p.unit} />
      {actual && (
        <KeyValues className="mt-3" items={[[t('activities.analysis.actual'), fmt.pace(actual, sport)]]} />
      )}
    </InsightCard>
  );
}

function Power({ p, ride }: { p: NonNullable<ActivityAnalysis['power']>; ride: boolean }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const { settings } = useSettings();
  const peakLabel = (s: number) => fmt.durationShort(s);
  return (
    <InsightCard
      title={t('activities.analysis.power')}
      icon={Zap}
      hint={ride && !settings.ftp ? t('activities.analysis.ftpHint') : undefined}
    >
      <div className="flex items-baseline gap-4">
        <BigValue value={fmt.int(p.normalizedW ?? p.avgW)} unit="W" />
        <span className="text-xs text-fg-3">{p.normalizedW ? t('activities.analysis.np') : t('activities.stats.avgPower')}</span>
      </div>
      <KeyValues
        className="mt-3"
        items={[
          [t('activities.stats.avgPower'), fmt.power(p.avgW)],
          [t('activities.stats.maxPower'), fmt.power(p.maxW)],
          ...(p.variabilityIndex ? [[t('activities.analysis.vi'), fmt.num(p.variabilityIndex, 2)] as [string, string]] : []),
          ...(p.intensityFactor ? [[t('activities.analysis.if'), fmt.num(p.intensityFactor, 2)] as [string, string]] : []),
          ...(p.tss ? [[t('activities.analysis.tss'), fmt.int(p.tss)] as [string, string]] : []),
          ...p.peaks.map((x) => [`${t('activities.analysis.peaks')} ${peakLabel(x.durationS)}`, fmt.power(x.watts)] as [string, string]),
        ]}
      />
    </InsightCard>
  );
}

/** Decoupling, efficiency factor, grade adjusted pace and power, when the streams support them. */
export function Insights({ w, analysis, similar }: { w: WorkoutDetail; analysis: ActivityAnalysis | undefined; similar: ActivitySimilar | undefined }) {
  if (!analysis?.hasStreams) return null;
  const cards: ReactNode[] = [];
  if (analysis.decoupling) cards.push(<Decoupling key="dec" a={analysis.decoupling} sport={w.sport} />);
  if (analysis.efficiency) cards.push(<Efficiency key="ef" a={analysis.efficiency} similar={similar} />);
  if (analysis.gapSpeed && isPaceSport(w.sport))
    cards.push(<Gap key="gap" gap={analysis.gapSpeed} actual={analysis.avgSpeed ?? w.avgSpeed} sport={w.sport} />);
  if (analysis.power) cards.push(<Power key="pw" p={analysis.power} ride={isCycling(w.sport)} />);
  if (!cards.length) return null;
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{cards}</div>;
}

// ---------------------------------------------------------------------------
// Climbs
// ---------------------------------------------------------------------------

function CategoryBadge({ c }: { c: ActivityClimb['category'] }) {
  const { t } = useI18n();
  if (!c) return <span className="text-fg-3">–</span>;
  return (
    <Badge tone={c === 'hc' || c === '1' ? 'accent' : 'neutral'} icon={MountainSnow}>
      {c === 'hc' ? t('activities.climbs.hc') : t('activities.climbs.cat', { cat: c })}
    </Badge>
  );
}

export function Climbs({ analysis, P, onSelect }: { analysis: ActivityAnalysis | undefined; P: Prepared | null; onSelect: OnSelect }) {
  const { t } = useI18n();
  const fmt = useFormat();
  const [active, setActive] = useState<number | null>(null);
  const climbs = analysis?.climbs ?? [];
  if (!climbs.length) return null;
  const gain = climbs.reduce((s, c) => s + c.gainM, 0);
  const pct = (g: number) => `${fmt.num(g * 100, 1)} %`;
  return (
    <Card className="min-w-0">
      <CardHeader
        title={t('activities.climbs.title')}
        subtitle={t('activities.climbs.subtitle', { count: climbs.length, gain: fmt.elevation(gain) })}
        icon={Mountain}
      />
      <Table>
        <thead>
          <tr>
            <TH>{t('activities.climbs.climb')}</TH>
            <TH>{t('activities.climbs.category')}</TH>
            <TH numeric>{t('activities.climbs.length')}</TH>
            <TH numeric>{t('activities.climbs.gain')}</TH>
            <TH numeric>{t('activities.climbs.avgGrade')}</TH>
            <TH numeric>{t('activities.climbs.maxGrade')}</TH>
            <TH numeric>
              <span title={t('activities.climbs.vamHint')}>{t('activities.climbs.vam')}</span>
            </TH>
            <TH numeric>{t('activities.climbs.time')}</TH>
            <TH numeric>{t('activities.climbs.hr')}</TH>
          </tr>
        </thead>
        <tbody>
          {climbs.map((c, i) => (
            <tr
              key={i}
              className={cn(P?.dist && 'cursor-pointer hover:bg-surface-2/70', active === i && 'bg-accent-soft')}
              onClick={() => {
                if (!P?.dist) return;
                setActive(i);
                onSelect([indexAtDist(P, c.startDistM), indexAtDist(P, c.endDistM)]);
              }}
            >
              <TD className="whitespace-nowrap">
                <span className="font-medium text-fg">{i + 1}</span>
                <span className="ml-1.5 text-xs text-fg-3">{t('activities.climbs.at', { distance: fmt.distance(c.startDistM, 1) })}</span>
              </TD>
              <TD>
                <CategoryBadge c={c.category} />
              </TD>
              <TD numeric>{fmt.distance(c.lengthM, 2)}</TD>
              <TD numeric>{fmt.elevation(c.gainM)}</TD>
              <TD numeric>{pct(c.avgGrade)}</TD>
              <TD numeric>{pct(c.maxGrade)}</TD>
              <TD numeric>{fmt.int(c.vam)}</TD>
              <TD numeric>{fmt.duration(c.durationS)}</TD>
              <TD numeric>{c.avgHr ? fmt.int(c.avgHr) : '–'}</TD>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
