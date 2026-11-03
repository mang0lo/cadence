import type { ReactNode } from 'react';
import {
  Activity,
  BatteryCharging,
  BatteryLow,
  Dumbbell,
  Scale3d,
  TrendingUp,
  Zap,
  Brain,
  Database,
  Droplets,
  Flame,
  Footprints,
  Gauge,
  Heart,
  HeartPulse,
  Moon,
  Percent,
  Scale,
  Sun,
  Thermometer,
  Timer,
  Wind,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import type { HealthMetricCard, HealthOverview } from '@cadence/shared';
import { Button, Card, EmptyState, ErrorState, Page, PageHeader } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { MetricCard, MetricCardSkeleton } from '../components/MetricCard';
import { useMetricFormat } from '../lib/metrics';
import { hasBodyData, useDataSources } from '@/lib/sources';
import { ReadinessCard } from '../widgets';

interface CardDef {
  icon: LucideIcon;
  /** Route of the detail page */
  to: (metric: string) => string;
  /** Catalogue identifier for names / formatting (sleep → SleepAnalysis). */
  catalogue: (metric: string) => string;
}

const explorer = (metric: string) => `/health/explorer/${encodeURIComponent(metric.split(':')[0]!)}`;
const same = (metric: string) => metric;

const CARDS: Record<string, CardDef> = {
  restingHr: { icon: HeartPulse, to: () => '/health/heart', catalogue: same },
  hrv: { icon: Activity, to: () => '/health/heart', catalogue: same },
  walkingHr: { icon: Footprints, to: () => '/health/heart', catalogue: same },
  vo2max: { icon: Gauge, to: () => '/health/heart', catalogue: same },
  sleep: { icon: Moon, to: () => '/health/sleep', catalogue: () => 'HKCategoryTypeIdentifierSleepAnalysis' },
  respiratoryRate: { icon: Wind, to: explorer, catalogue: same },
  spo2: { icon: Droplets, to: explorer, catalogue: same },
  wristTemp: { icon: Thermometer, to: explorer, catalogue: same },
  weight: { icon: Scale, to: () => '/health/body', catalogue: same },
  bodyFat: { icon: Percent, to: () => '/health/body', catalogue: same },
  steps: { icon: Footprints, to: explorer, catalogue: same },
  activeEnergy: { icon: Flame, to: explorer, catalogue: same },
  exercise: { icon: Timer, to: explorer, catalogue: same },
  daylight: { icon: Sun, to: explorer, catalogue: same },
  mindful: { icon: Brain, to: explorer, catalogue: same },
  corosBaseFitness: { icon: TrendingUp, to: explorer, catalogue: same },
  corosAcuteLoad: { icon: Dumbbell, to: explorer, catalogue: same },
  corosLoadRatio: { icon: Scale3d, to: explorer, catalogue: same },
  corosFatigue: { icon: BatteryLow, to: explorer, catalogue: same },
  corosStamina: { icon: Zap, to: explorer, catalogue: same },
  corosCalories: { icon: Flame, to: explorer, catalogue: same },
  corosActiveTime: { icon: Timer, to: explorer, catalogue: same },
};

const GROUPS: { key: string; keys: string[] }[] = [
  { key: 'heart', keys: ['restingHr', 'hrv', 'walkingHr', 'vo2max'] },
  { key: 'sleepVitals', keys: ['sleep', 'respiratoryRate', 'spo2', 'wristTemp'] },
  { key: 'body', keys: ['weight', 'bodyFat'] },
  {
    key: 'training',
    keys: ['corosBaseFitness', 'corosAcuteLoad', 'corosLoadRatio', 'corosFatigue', 'corosStamina'],
  },
  {
    key: 'activity',
    keys: ['steps', 'activeEnergy', 'corosCalories', 'exercise', 'corosActiveTime', 'daylight', 'mindful'],
  },
];

const GRID = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))]';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-fg-3">{title}</h2>
      <div className={GRID}>{children}</div>
    </section>
  );
}

export default function HealthPage() {
  const t = useT();
  const fmt = useFormat();
  const m = useMetricFormat();
  const q = useApi<HealthOverview>(['health', 'overview'], '/health/overview');
  const byKey = new Map<string, HealthMetricCard>((q.data?.cards ?? []).map((c) => [c.key, c]));

  const sources = useDataSources().data;
  const links: { to: string; label: string; icon: LucideIcon; show?: boolean }[] = [
    { to: '/health/readiness', label: t('health.nav.readiness'), icon: BatteryCharging },
    { to: '/health/sleep', label: t('health.nav.sleep'), icon: Moon },
    { to: '/health/heart', label: t('health.nav.heart'), icon: Heart },
    // pages without any data for this athlete are not offered (same rules as the navigation)
    { to: '/health/body', label: t('health.nav.body'), icon: Scale, show: !sources || hasBodyData(sources) },
    { to: '/health/ecg', label: t('health.nav.ecg'), icon: Activity, show: !sources || sources.ecgCount > 0 },
    { to: '/health/explorer', label: t('health.nav.explorer'), icon: Database },
  ].filter((l) => l.show !== false);

  return (
    <Page>
      <PageHeader
        title={t('health.titles.HealthPage')}
        icon={HeartPulse}
        subtitle={
          q.data?.asOf
            ? t('health.common.asOf', { date: fmt.day(q.data.asOf, 'day') })
            : t('health.overview.subtitle')
        }
        actions={links.map((l) => (
          <Link key={l.to} to={l.to}>
            <Button size="sm" icon={l.icon}>
              {l.label}
            </Button>
          </Link>
        ))}
      />

      {q.error && <ErrorState error={q.error} />}

      {q.isLoading && (
        <div className={GRID}>
          {Array.from({ length: 8 }, (_, i) => (
            <MetricCardSkeleton key={i} />
          ))}
        </div>
      )}

      {q.data && q.data.cards.length === 0 && (
        <Card>
          <EmptyState
            icon={HeartPulse}
            title={t('health.noData.title')}
            description={t('health.overview.emptyDescription')}
            action={
              <Link to="/health/explorer">
                <Button icon={Database}>{t('health.nav.explorer')}</Button>
              </Link>
            }
          />
        </Card>
      )}

      {q.data && q.data.cards.length > 0 && (
        <section className="mb-7 empty:hidden">
          <ReadinessCard variant="overview" />
        </section>
      )}

      {q.data &&
        GROUPS.map((g) => {
          const cards = g.keys.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
          if (!cards.length) return null;
          return (
            <Section key={g.key} title={t(`health.overview.groups.${g.key}`)}>
              {cards.map((c) => {
                const def = CARDS[c.key]!;
                const catalogue = def.catalogue(c.metric);
                return (
                  <MetricCard
                    key={c.key}
                    card={c}
                    icon={def.icon}
                    to={def.to(c.metric)}
                    metric={catalogue}
                    title={c.key === 'sleep' ? t('health.overview.sleepName') : m.name(catalogue)}
                  />
                );
              })}
            </Section>
          );
        })}
    </Page>
  );
}
