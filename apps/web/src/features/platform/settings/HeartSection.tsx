import { AlertTriangle, Heart } from 'lucide-react';
import type { AthleteSettings } from '@cadence/shared';
import { Field, SegmentedControl } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { NumberSetting, Section, ZoneBoundsSetting } from './controls';
import { zoneBoundsProblem } from './validate';

/** Settings → heart rate & zones: max / resting HR, FTP, the zone model and what is used right now. */
export function HeartSection({ set }: { set: (patch: Partial<AthleteSettings>) => void }) {
  const t = useT();
  const { settings, athlete } = useSettings();
  const hr = athlete?.hr;
  // the server uses % of max HR instead of custom limits that do not ascend (saved before they were checked here).
  // The saved limits decide too: right after a switch to Custom the athlete (hr) still reports the old method.
  const customIgnored =
    settings.hrZoneMethod === 'custom' &&
    !!hr &&
    hr.method !== 'custom' &&
    (!settings.hrZones || zoneBoundsProblem(settings.hrZones) !== null);
  return (
    <Section title={t('platform.settings.heart')} icon={Heart} hint={t('platform.settings.heartHint')}>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-4">
        <Field label={t('platform.settings.maxHr')}>
          <NumberSetting value={settings.maxHr} placeholder={hr ? `${hr.maxHr} (${t('platform.settings.auto')})` : ''} min={100} max={240} onSave={(v) => set({ maxHr: v })} />
        </Field>
        <Field label={t('platform.settings.restingHr')}>
          <NumberSetting value={settings.restingHr} placeholder={hr ? `${hr.restingHr} (${t('platform.settings.auto')})` : ''} min={25} max={120} onSave={(v) => set({ restingHr: v })} />
        </Field>
        <Field label={t('platform.settings.ftp')}>
          <NumberSetting value={settings.ftp} placeholder="–" min={50} max={600} onSave={(v) => set({ ftp: v })} />
        </Field>
      </div>
      <Field group label={t('platform.settings.zoneMethod')}>
        <SegmentedControl
          value={settings.hrZoneMethod}
          onChange={(v) =>
            set({ hrZoneMethod: v, ...(v === 'custom' && !settings.hrZones && hr ? { hrZones: hr.zoneBounds } : {}) })
          }
          items={(['maxhr', 'hrr', 'custom'] as const).map((v) => ({ value: v, label: t(`platform.settings.zoneMethods.${v}`) }))}
        />
      </Field>
      {settings.hrZoneMethod === 'custom' && (
        <Field group label={t('platform.settings.zoneBounds')}>
          <ZoneBoundsSetting value={settings.hrZones ?? hr?.zoneBounds ?? [114, 133, 152, 171]} onSave={(v) => set({ hrZones: v })} />
        </Field>
      )}
      {customIgnored && (
        <div className="flex items-start gap-2 rounded-control bg-warning/18 p-3 text-xs text-fg">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          {t('platform.settings.zoneFallback')}
        </div>
      )}
      {hr && (
        <div className="rounded-control bg-surface-2 p-3">
          <div className="mb-2 text-xs font-medium text-fg-3">{t('platform.settings.effective')}</div>
          <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              {t('platform.settings.maxHr')}: <b>{hr.maxHr}</b> <span className="text-xs text-fg-3">({t(`platform.settings.sources.${hr.maxHrSource}`)})</span>
            </div>
            <div>
              {t('platform.settings.restingHr')}: <b>{hr.restingHr}</b>{' '}
              <span className="text-xs text-fg-3">({t(`platform.settings.sources.${hr.restingHrSource}`)})</span>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-0.5 text-[11px]">
            {[0, 1, 2, 3, 4].map((z) => {
              const lo = z === 0 ? null : hr.zoneBounds[z - 1]!;
              const hi = hr.zoneBounds[z] ?? null;
              return (
                <div key={z} className="min-w-0">
                  <div
                    className={`h-2 ${z === 0 ? 'rounded-l-full' : ''} ${z === 4 ? 'rounded-r-full' : ''}`}
                    style={{ background: `var(--zone-${z + 1})` }}
                  />
                  <div className="mt-1 font-medium text-fg">Z{z + 1}</div>
                  <div className="truncate tabular text-fg-3">
                    {lo === null ? `< ${hi}` : hi === null ? `≥ ${lo}` : `${lo}–${hi - 1}`}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Section>
  );
}
