import { useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, CircleAlert, CircleHelp, Download, HeartPulse, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import type { EcgClass, EcgDetail, EcgSummary } from '@cadence/shared';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Page, PageHeader, SegmentedControl, Skeleton, Stat, StatRow, Switch, cn } from '@/components/ui';
import { useApi } from '@/lib/api';
import { saveFile } from '@/lib/download';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { EcgPaper } from '../components/ecg/EcgPaper';
import { ecgCsv } from '../lib/download';

/** Status colors only together with icon and label (the class name inside the badge). */
const CLASS_BADGE: Record<EcgClass, { tone: 'good' | 'warning' | 'critical' | 'neutral'; icon: LucideIcon }> = {
  sinus: { tone: 'good', icon: CheckCircle2 },
  afib: { tone: 'critical', icon: AlertTriangle },
  highHr: { tone: 'warning', icon: CircleAlert },
  lowHr: { tone: 'warning', icon: CircleAlert },
  inconclusive: { tone: 'neutral', icon: CircleHelp },
  poor: { tone: 'neutral', icon: CircleHelp },
  unrecognized: { tone: 'neutral', icon: CircleHelp },
  other: { tone: 'neutral', icon: CircleHelp },
};

function ClassBadge({ k }: { k: EcgClass }) {
  const t = useT();
  const c = CLASS_BADGE[k];
  return (
    <Badge tone={c.tone} icon={c.icon}>
      {t(`health.ecg.class.${k}`)}
    </Badge>
  );
}

const ZOOMS = [
  { value: '3', px: 3, key: 'small' },
  { value: '4', px: 4, key: 'medium' },
  { value: '6', px: 6, key: 'large' },
] as const;

function RecordingList({ items, selected, onSelect }: { items: EcgSummary[]; selected: number; onSelect: (id: number) => void }) {
  const t = useT();
  const fmt = useFormat();
  const m = fmt;
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-baseline justify-between px-4 pb-2 pt-4">
        <h2 className="text-sm font-semibold text-fg">{t('health.ecg.recordings')}</h2>
        <span className="text-xs text-fg-3 tabular">{t('health.ecg.count', { count: items.length })}</span>
      </div>
      <ul className="max-h-[360px] divide-y divide-border overflow-y-auto border-t border-border scrollbar-thin xl:max-h-[720px]">
        {items.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              onClick={() => onSelect(e.id)}
              aria-current={e.id === selected}
              aria-label={t('health.ecg.select', { date: fmt.date(e.recordedTs, e.tzMin, 'dateTime') })}
              className={cn(
                'flex w-full flex-col items-start gap-1.5 px-4 py-3 text-left transition-colors hover:bg-surface-2',
                e.id === selected && 'bg-accent-soft',
              )}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium text-fg">{fmt.date(e.recordedTs, e.tzMin, 'dateTime')}</span>
                <span className="tabular text-sm text-fg-2">{e.avgHr !== null ? m.hr(e.avgHr) : '–'}</span>
              </span>
              <ClassBadge k={e.classKey} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Recording({ id, summary }: { id: number; summary: EcgSummary }) {
  const t = useT();
  const fmt = useFormat();
  const q = useApi<EcgDetail>(['health', 'ecg', 'detail', id], `/health/ecg/${id}`);
  const d = q.data && q.data.id === id ? q.data : null;
  const [zoom, setZoom] = useState<string>('4');
  const [peaks, setPeaks] = useState(false);
  const px = ZOOMS.find((z) => z.value === zoom)?.px ?? 4;
  const leadLabel = (raw: string | null) => {
    // the phone writes the lead in its own language ("Lead I", "Ableitung I")
    const match = raw ? /^(?:lead|ableitung)\s+(\S+)$/i.exec(raw.trim()) : null;
    return match ? t('health.ecg.stats.leadName', { name: match[1]! }) : (raw ?? '–');
  };
  const when = fmt.date(summary.recordedTs, summary.tzMin, 'dateTime');
  const hrText = summary.avgHr !== null ? fmt.hr(summary.avgHr) : '–';
  const aria = useMemo(
    () => t('health.ecg.paper.aria', { date: when, seconds: Math.round(summary.durationS ?? 0), hr: hrText }),
    [t, when, summary.durationS, hrText],
  );

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader
          title={fmt.date(summary.recordedTs, summary.tzMin, 'weekday')}
          subtitle={fmt.time(summary.recordedTs, summary.tzMin)}
          icon={Activity}
          actions={<ClassBadge k={summary.classKey} />}
        />
        <StatRow>
          <Stat label={t('health.ecg.stats.avgHr')} value={summary.avgHr !== null ? fmt.int(summary.avgHr) : '–'} unit={summary.avgHr !== null ? 'bpm' : undefined} />
          <Stat
            label={t('health.ecg.stats.duration')}
            value={summary.durationS !== null ? t('health.ecg.stats.seconds', { s: fmt.int(summary.durationS) }) : '–'}
          />
          <Stat label={t('health.ecg.stats.sampleRate')} value={summary.sampleRateHz !== null ? t('health.ecg.stats.hz', { hz: fmt.int(summary.sampleRateHz) }) : '–'} />
          <Stat label={t('health.ecg.stats.lead')} value={leadLabel(summary.lead)} size="sm" />
          <Stat label={t('health.ecg.stats.device')} value={summary.device ?? '–'} size="sm" />
          <Stat label={t('health.ecg.stats.software')} value={summary.softwareVersion ?? '–'} size="sm" />
          {summary.symptoms && <Stat label={t('health.ecg.stats.symptoms')} value={summary.symptoms} size="sm" />}
        </StatRow>
      </Card>

      <Card>
        <CardHeader
          title={t('health.ecg.paper.title')}
          subtitle={t('health.ecg.paper.subtitle')}
          icon={HeartPulse}
          actions={
            <>
              <Switch checked={peaks} onChange={setPeaks} label={<span className="text-xs">{t('health.ecg.paper.peaks')}</span>} />
              <SegmentedControl
                size="sm"
                label={t('health.ecg.paper.scale')}
                value={zoom}
                onChange={setZoom}
                items={ZOOMS.map((z) => ({ value: z.value, label: t(`health.ecg.paper.${z.key}`) }))}
              />
              <Button
                size="sm"
                icon={Download}
                disabled={!d}
                onClick={() => d && void saveFile(`ecg-${new Date((summary.recordedTs + summary.tzMin * 60) * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '')}.csv`, ecgCsv(d), 'text/csv')}
              >
                {t('health.ecg.paper.download')}
              </Button>
            </>
          }
        />
        {q.error ? (
          <ErrorState error={q.error} />
        ) : !d ? (
          <Skeleton className="h-[320px] w-full" />
        ) : d.samples.length === 0 || !d.sampleRateHz ? (
          <p className="py-10 text-center text-sm text-fg-3">{t('health.ecg.paper.noWaveform')}</p>
        ) : (
          <EcgPaper key={d.id} samples={d.samples} rateHz={d.sampleRateHz} rPeaks={d.rPeaks} showPeaks={peaks} pxPerMm={px} ariaLabel={aria} />
        )}
        <p className="mt-3 text-xs text-fg-3">{t('health.ecg.paper.note')}</p>
      </Card>
    </div>
  );
}

export default function EcgPage() {
  const t = useT();
  const q = useApi<EcgSummary[]>(['health', 'ecg', 'list'], '/health/ecg');
  const [selected, setSelected] = useState<number | null>(null);
  const items = q.data ?? [];
  const current = items.find((e) => e.id === selected) ?? items[0] ?? null;

  return (
    <Page>
      <PageHeader title={t('health.titles.EcgPage')} subtitle={t('health.ecg.subtitle')} icon={Activity} />
      {q.error && <ErrorState error={q.error} className="mb-4" />}
      {q.isLoading && <Skeleton className="h-[420px] w-full" />}
      {q.data && items.length === 0 && (
        <Card>
          <EmptyState
            icon={Activity}
            title={t('health.ecg.empty.title')}
            description={t('health.ecg.empty.description')}
            action={
              <Link to="/import">
                <Button>{t('common.importNow')}</Button>
              </Link>
            }
          />
        </Card>
      )}
      {current && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
          <RecordingList items={items} selected={current.id} onSelect={setSelected} />
          <Recording key={current.id} id={current.id} summary={current} />
        </div>
      )}
    </Page>
  );
}
