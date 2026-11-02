import type { ReactNode } from 'react';
import {
  Activity,
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
};

const GROUPS: { key: string; keys: string[] }[] = [
  { key: 'heart', keys: ['restingHr', 'hrv', 'walkingHr', 'vo2max'] },
  { key: 'sleepVitals', keys: ['sleep', 'respiratoryRate', 'spo2', 'wristTemp'] },
  { key: 'body', keys: ['weight', 'bodyFat'] },
  { key: 'activity', keys: ['steps', 'activeEnergy', 'exercise', 'daylight', 'mindful'] },
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

  const links: { to: string; label: string; icon: LucideIcon }[] = [
    { to: '/health/sleep', label: t('health.nav.sleep'), icon: Moon },
    { to: '/health/heart', label: t('health.nav.heart'), icon: Heart },
    { to: '/health/body', label: t('health.nav.body'), icon: Scale },
    { to: '/health/ecg', label: t('health.nav.ecg'), icon: Activity },
    { to: '/health/explorer', label: t('health.nav.explorer'), icon: Database },
  ];

  return (
    <Page>
      <PageHeader
        title={t('health.titles.HealthPage')}
        icon={HeartPulse}
        subtitle={q.data?.asOf ? t('health.common.asOf', { date: fmt.day(q.data.asOf, 'day') }) : t('health.overview.subtitle')}
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
