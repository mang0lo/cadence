import { lazy, Suspense, useState } from 'react';
import { Link } from 'react-router';
import { Info, MapPin, Palette, Server, Settings as SettingsIcon, Watch } from 'lucide-react';
import type { AthleteSettings } from '@cadence/shared';
import { ErrorState, Field, KeyValues, Page, PageHeader, SegmentedControl, Select, Skeleton, Switch } from '@/components/ui';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { isNativeShell, shellInfo } from '@/lib/native';
import { useSettings } from '@/lib/settings';
import { BackupSection } from './BackupSection';
import { ServerConnection } from './ServerConnection';
import { Section } from './settings/controls';
import { HeartSection } from './settings/HeartSection';
import { ProfileSection } from './settings/ProfileSection';

// MapLibre is large: the rest of the page does not wait for it
const PrivacyZones = lazy(() => import('./settings/PrivacyZones'));

export default function SettingsPage() {
  const t = useT();
  const fmt = useFormat();
  const { settings, status, update } = useSettings();
  const shell = shellInfo();
  const [saveFailed, setSaveFailed] = useState(false);
  const set = (patch: Partial<AthleteSettings>) => {
    update(patch).then(
      () => setSaveFailed(false),
      () => setSaveFailed(true),
    );
  };

  return (
    <Page>
      <PageHeader title={t('platform.settings.title')} icon={SettingsIcon} />
      {saveFailed && <ErrorState className="mb-4" error={t('platform.settings.saveFailed')} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <ProfileSection set={set} />

        <Section title={t('platform.settings.watch.title')} icon={Watch} hint={t('platform.settings.watch.hint')}>
          <Field group label={t('platform.settings.watch.label')}>
            <SegmentedControl
              value={settings.watch}
              onChange={(v) => set({ watch: v })}
              items={(['apple', 'coros', 'other'] as const).map((v) => ({ value: v, label: t(`platform.settings.watch.kinds.${v}`) }))}
            />
          </Field>
          <p className="text-xs text-fg-3">{t(`platform.settings.watch.explain.${settings.watch}`)}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {(['workouts', 'heart'] as const).map((kind) => (
              <Field key={kind} label={t(`platform.settings.watch.types.${kind}`)}>
                <Select
                  value={settings.sources[kind]}
                  onChange={(v) => set({ sources: { ...settings.sources, [kind]: v } })}
                  options={(['auto', 'apple', 'device'] as const).map((v) => ({
                    value: v,
                    label: t(`platform.settings.watch.prefs.${v}`),
                  }))}
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-fg-3">{t('platform.settings.watch.sleepNote')}</p>
          {settings.watch === 'coros' && (
            <Link to="/connect" className="text-sm text-accent-fg underline-offset-2 hover:underline">
              {t('platform.settings.watch.toConnect')}
            </Link>
          )}
        </Section>

        <Section title={t('platform.settings.display')} icon={Palette}>
          <Field group label={t('platform.settings.units')}>
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
          <div>
            <Switch
              checked={settings.thumbnailMaps}
              onChange={(v) => set({ thumbnailMaps: v })}
              label={t('platform.settings.thumbnailMaps')}
            />
            <p className="mt-1 pl-11 text-xs text-fg-3">{t('platform.settings.thumbnailMapsHint')}</p>
          </div>
        </Section>

        <HeartSection set={set} />

        <Section title={t('platform.settings.server')} icon={Info}>
          <KeyValues
            items={[
              [t('platform.settings.mode'), status ? t(`platform.settings.modes.${status.mode}`) : '–'],
              ...(shell
                ? ([[t('platform.settings.appVersion'), `${t(`platform.settings.apps.${shell.app}`)} ${shell.version}`]] as [string, string][])
                : []),
              [shell ? t('platform.settings.serverVersion') : t('platform.settings.version'), status?.version ?? '–'],
              [t('platform.settings.records'), status ? fmt.int(status.counts.records) : '–'],
              [t('platform.settings.workouts'), status ? fmt.int(status.counts.workouts) : '–'],
              [
                t('platform.settings.lastImport'),
                status?.lastImportAt ? fmt.relative(status.lastImportAt) : t('platform.settings.never'),
              ],
            ]}
          />
        </Section>

        {isNativeShell() && (
          <Section title={t('platform.connection.title')} icon={Server} hint={t('platform.connection.hint')}>
            <ServerConnection />
          </Section>
        )}

        <div className="lg:col-span-2">
          <BackupSection />
        </div>

        <div className="lg:col-span-2">
          <Section title={t('platform.settings.privacy')} icon={MapPin} hint={t('platform.settings.privacyHint')}>
            <Suspense fallback={<Skeleton className="h-64" />}>
              <PrivacyZones zones={settings.privacyZones} onChange={(z) => set({ privacyZones: z })} />
            </Suspense>
          </Section>
        </div>
      </div>
    </Page>
  );
}
