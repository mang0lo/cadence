import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Heart, Info, MapPin, Palette, Settings as SettingsIcon, Trash2, User } from 'lucide-react';
import type { Map } from 'maplibre-gl';
import type { AthleteSettings, PrivacyZone } from '@cadence/shared';
import { BaseMap } from '@/components/map/BaseMap';
import { featureCollection, pointFeature, setGeoJSON } from '@/components/map/layers';
import { Button, Card, CardHeader, Field, IconButton, Input, KeyValues, Page, PageHeader, SegmentedControl, Select, Slider } from '@/components/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { BackupSection } from './BackupSection';

function Section({ title, icon, children, hint }: { title: string; icon: typeof User; children: ReactNode; hint?: string }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={hint} icon={icon} />
      <div className="grid gap-4">{children}</div>
    </Card>
  );
}

/** Number input that saves on blur/enter; empty = automatic (null). */
function NumberSetting({
  value,
  placeholder,
  onSave,
  min,
  max,
}: {
  value: number | null;
  placeholder: string;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
}) {
  const [text, setText] = useState(value?.toString() ?? '');
  useEffect(() => setText(value?.toString() ?? ''), [value]);
  const commit = () => {
    const n = text.trim() === '' ? null : Math.round(Number(text));
    if (n === null || (Number.isFinite(n) && n >= min && n <= max)) {
      if (n !== value) onSave(n);
    } else setText(value?.toString() ?? '');
  };
  return (
    <Input
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="max-w-40"
    />
  );
}

function PrivacyZones({ zones, onChange }: { zones: PrivacyZone[]; onChange: (z: PrivacyZone[]) => void }) {
  const t = useT();
  const fmt = useFormat();
  const mapRef = useRef<Map | null>(null);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  const draw = (map: Map) => {
    setGeoJSON(
      map,
      'privacy-zones',
      featureCollection(zonesRef.current.map((z) => pointFeature([z.lon, z.lat], { r: z.radiusM }))),
    );
    if (!map.getLayer('privacy-zones')) {
      map.addLayer({
        id: 'privacy-zones',
        type: 'circle',
        source: 'privacy-zones',
        paint: {
          // radius in pixels approximated from meters at the current zoom/latitude
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 10, ['/', ['get', 'r'], 120], 16, ['/', ['get', 'r'], 1.9]],
          'circle-color': '#e8590c',
          'circle-opacity': 0.18,
          'circle-stroke-color': '#e8590c',
          'circle-stroke-width': 2,
        },
      });
    }
  };
  useEffect(() => {
    if (mapRef.current?.isStyleLoaded()) draw(mapRef.current);
  }, [zones]);

  return (
    <div className="grid gap-3">
      <BaseMap
        className="h-64"
        zoom={11}
        switcher={false}
        onReady={(map) => {
          mapRef.current = map;
          map.on('click', (e) => onChange([...zonesRef.current, { lat: e.lngLat.lat, lon: e.lngLat.lng, radiusM: 300 }]));
          map.getCanvas().style.cursor = 'crosshair';
        }}
        onStyleLoad={draw}
      >
        <div className="pointer-events-none absolute left-2 top-2 rounded-lg bg-surface/90 px-2 py-1 text-xs text-fg-2 shadow-card">
          {t('platform.settings.addZone')}
        </div>
      </BaseMap>
      {zones.map((z, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <MapPin size={15} className="shrink-0 text-accent-fg" />
          <span className="w-40 shrink-0 tabular text-fg-2">
            {z.lat.toFixed(4)}, {z.lon.toFixed(4)}
          </span>
          <span className="shrink-0 text-xs text-fg-3">{t('platform.settings.radius')}</span>
          <Slider
            value={z.radiusM}
            min={100}
            max={2000}
            step={50}
            label={t('platform.settings.radius')}
            onChange={(v) => onChange(zones.map((x, j) => (j === i ? { ...x, radiusM: v } : x)))}
          />
          <span className="w-16 shrink-0 text-right tabular text-fg-2">{fmt.shortDistance(z.radiusM)}</span>
          <IconButton icon={Trash2} label={t('common.delete')} onClick={() => onChange(zones.filter((_, j) => j !== i))} />
        </div>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const { settings, athlete, status, update } = useSettings();
  const [name, setName] = useState(athlete?.name ?? '');
  useEffect(() => setName(athlete?.name ?? ''), [athlete?.name]);
  const set = (patch: Partial<AthleteSettings>) => void update(patch);
  const hr = athlete?.hr;

  return (
    <Page>
      <PageHeader title={t('platform.settings.title')} icon={SettingsIcon} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={t('platform.settings.profile')} icon={User}>
          <Field label={t('platform.settings.name')}>
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-72" />
              <Button
                disabled={!name.trim() || name === athlete?.name}
                onClick={async () => {
                  await api.patch('/athlete', { name: name.trim() });
                  await qc.invalidateQueries({ queryKey: ['core', 'athlete'] });
                }}
              >
                {t('common.save')}
              </Button>
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('platform.settings.birthDate')}>
              <Input
                type="date"
                value={settings.birthDate ?? athlete?.birthDate ?? ''}
                onChange={(e) => set({ birthDate: e.target.value || null })}
              />
            </Field>
            <Field label={t('platform.settings.sex')}>
              <Select
                value={settings.sex ?? 'auto'}
                onChange={(v) => set({ sex: v === 'auto' ? null : v })}
                options={(['auto', 'male', 'female', 'other'] as const).map((v) => ({ value: v, label: t(`platform.settings.sexes.${v}`) }))}
              />
            </Field>
          </div>
        </Section>

        <Section title={t('platform.settings.display')} icon={Palette}>
          <Field label={t('platform.settings.units')}>
            <SegmentedControl
              value={settings.units}
              onChange={(v) => set({ units: v })}
              items={[
                { value: 'metric', label: t('platform.settings.metric') },
                { value: 'imperial', label: t('platform.settings.imperial') },
              ]}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('platform.settings.language')}>
              <Select
                value={settings.language}
                onChange={(v) => set({ language: v })}
                options={(['auto', 'de', 'en'] as const).map((v) => ({ value: v, label: t(`platform.settings.languages.${v}`) }))}
              />
            </Field>
            <Field label={t('platform.settings.theme')}>
              <Select
                value={settings.theme}
                onChange={(v) => set({ theme: v })}
                options={(['system', 'light', 'dark'] as const).map((v) => ({ value: v, label: t(`platform.settings.themes.${v}`) }))}
              />
            </Field>
            <Field label={t('platform.settings.weekStart')}>
              <Select
                value={String(settings.weekStart) as '0' | '1'}
                onChange={(v) => set({ weekStart: v === '0' ? 0 : 1 })}
                options={[
                  { value: '1', label: t('platform.settings.monday') },
                  { value: '0', label: t('platform.settings.sunday') },
                ]}
              />
            </Field>
            <Field label={t('platform.settings.mapStyle')}>
              <Select
                value={settings.mapStyle}
                onChange={(v) => set({ mapStyle: v })}
                options={(['streets', 'outdoor', 'satellite', 'dark'] as const).map((v) => ({ value: v, label: t(`common.map.styles.${v}`) }))}
              />
            </Field>
          </div>
        </Section>

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
          <Field label={t('platform.settings.zoneMethod')}>
            <SegmentedControl
              value={settings.hrZoneMethod}
              onChange={(v) =>
                set({ hrZoneMethod: v, ...(v === 'custom' && !settings.hrZones && hr ? { hrZones: hr.zoneBounds } : {}) })
              }
              items={(['maxhr', 'hrr', 'custom'] as const).map((v) => ({ value: v, label: t(`platform.settings.zoneMethods.${v}`) }))}
            />
          </Field>
          {settings.hrZoneMethod === 'custom' && (
            <Field label={t('platform.settings.zoneBounds')}>
              <div className="flex flex-wrap gap-2">
                {(settings.hrZones ?? hr?.zoneBounds ?? [114, 133, 152, 171]).map((b, i, arr) => (
                  <NumberSetting
                    key={i}
                    value={b}
                    placeholder=""
                    min={40}
                    max={240}
                    onSave={(v) => v !== null && set({ hrZones: arr.map((x, j) => (j === i ? v : x)) })}
                  />
                ))}
              </div>
            </Field>
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

        <Section title={t('platform.settings.server')} icon={Info}>
          <KeyValues
            items={[
              [t('platform.settings.mode'), status ? t(`platform.settings.modes.${status.mode}`) : '–'],
              [t('platform.settings.version'), status?.version ?? '–'],
              [t('platform.settings.records'), status ? fmt.int(status.counts.records) : '–'],
              [t('platform.settings.workouts'), status ? fmt.int(status.counts.workouts) : '–'],
              [
                t('platform.settings.lastImport'),
                status?.lastImportAt ? fmt.relative(status.lastImportAt) : t('platform.settings.never'),
              ],
            ]}
          />
        </Section>

        <div className="lg:col-span-2">
          <BackupSection />
        </div>

        <div className="lg:col-span-2">
          <Section title={t('platform.settings.privacy')} icon={MapPin} hint={t('platform.settings.privacyHint')}>
            <PrivacyZones zones={settings.privacyZones} onChange={(z) => set({ privacyZones: z })} />
          </Section>
        </div>
      </div>
    </Page>
  );
}
