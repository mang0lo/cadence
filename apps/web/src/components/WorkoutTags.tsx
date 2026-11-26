import { Activity, Feather, Gauge, HeartPulse, Repeat, Route, Thermometer, type LucideIcon } from 'lucide-react';
import type { TrainingKind, WorkoutSummary } from '@cadence/shared';
import { Badge, cn } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

const KIND_ICON: Record<TrainingKind, LucideIcon> = {
  intervals: Repeat,
  long: Route,
  tempo: Gauge,
  easy: Feather,
  recovery: HeartPulse,
};

/** "DE" → 🇩🇪 (regional indicator letters). */
const flag = (code: string) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

/** Country names per language, built once (a tag row renders for every activity in lists and the feed). */
const regionNames = new Map<string, Intl.DisplayNames | null>();
function countryNames(lang: string): Intl.DisplayNames | null {
  let names = regionNames.get(lang);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([lang], { type: 'region' });
    } catch {
      names = null;
    }
    regionNames.set(lang, names);
  }
  return names;
}

/**
 * Small automatic tags of an activity — kind of training, countries, weather. Each one is only shown when the
 * activity has the data for it; nothing is rendered without any.
 */
export function WorkoutTags({
  w,
  className,
}: {
  w: Pick<WorkoutSummary, 'trainingKind' | 'countries' | 'weather'>;
  className?: string;
}) {
  const { t, lang } = useI18n();
  const fmt = useFormat();
  const countries = w.countries ?? [];
  if (!w.trainingKind && !countries.length && !w.weather) return null;
  const names = countries.length ? countryNames(lang) : null;
  const countryName = (c: string) => names?.of(c) ?? c;
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {w.trainingKind && (
        <span title={t(`common.tags.kindHint.${w.trainingKind}`)} className="inline-flex">
          <Badge icon={KIND_ICON[w.trainingKind] ?? Activity}>{t(`common.tags.kind.${w.trainingKind}`)}</Badge>
        </span>
      )}
      {countries.length > 0 && (
        <span title={countries.map(countryName).join(' → ')} className="inline-flex">
          <Badge>
            <span aria-hidden>{countries.slice(0, 4).map(flag).join(' ')}</span>
            {countries.length === 1 ? countryName(countries[0]!) : <span className="sr-only">{countries.map(countryName).join(', ')}</span>}
          </Badge>
        </span>
      )}
      {w.weather && (
        <span
          title={
            w.weather.humidityPct !== null
              ? t('common.tags.weatherHint', { humidity: fmt.int(w.weather.humidityPct) })
              : t('common.tags.weather')
          }
          className="inline-flex"
        >
          <Badge icon={Thermometer}>{fmt.temperature(w.weather.temperatureC)}</Badge>
        </span>
      )}
    </div>
  );
}
