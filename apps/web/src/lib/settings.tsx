import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { DEFAULT_SETTINGS, type Athlete, type AthleteSettings, type ServerStatus } from '@cadence/shared';
import { api, useApi } from './api';
import { resolveLang, type Lang } from './i18n';
import { storage } from './storage';
import { useApplyTheme } from './theme';

export type StatusResponse = ServerStatus & { authenticated: boolean };

interface SettingsValue {
  settings: AthleteSettings;
  athlete: Athlete | null;
  status: StatusResponse | null;
  lang: Lang;
  loading: boolean;
  /**
   * PATCH /api/settings. The change shows at once; requests go out one after the other, and only data that depends
   * on the changed settings is loaded again (see `refreshScope`). Rejects when the server refused the change (the
   * settings are then loaded again). `refetch: false` loads nothing again whatever changed.
   */
  update: (patch: Partial<AthleteSettings>, opts?: { refetch?: boolean }) => Promise<void>;
}

const SettingsContext = createContext<SettingsValue | null>(null);

/** Cached so the very first paint already uses the right language / units. */
const cached = storage.getJSON<Partial<AthleteSettings>>('cadence.settings', {});

const SETTINGS_KEY = ['core', 'settings', null] as const;

/**
 * Settings the server reads to compute its results (zones, effort, age norms, weeks, power, preferred sources …).
 * Every other setting (theme, units, language, map style, route previews, the order of the sidebar) only changes
 * the interface: saving it loads nothing again. Keep in sync with the server when it starts reading another key.
 */
const DATA_KEYS: readonly (keyof AthleteSettings)[] = [
  'weekStart',
  'maxHr',
  'restingHr',
  'hrZoneMethod',
  'hrZones',
  'ftp',
  'sex',
  'birthDate',
  'watch',
  'sources',
];
/** Read by the maps feature only (heatmap). */
const MAP_KEYS: readonly (keyof AthleteSettings)[] = ['privacyZones'];

export type RefreshScope = 'none' | 'maps' | 'data';

/** What a settings change makes stale. */
export function refreshScope(patch: Partial<AthleteSettings>): RefreshScope {
  const keys = Object.keys(patch) as (keyof AthleteSettings)[];
  if (keys.some((k) => DATA_KEYS.includes(k))) return 'data';
  if (keys.some((k) => MAP_KEYS.includes(k))) return 'maps';
  return 'none';
}

/**
 * Whether a query must load again after a change of `scope`: every feature query, plus the core ones the settings
 * feed into (athlete: HR zones and age, sources: the watch, import jobs: the server queues a rebuild for HR and
 * source changes).
 */
export function isStaleAfter(scope: RefreshScope, key: readonly unknown[]): boolean {
  if (scope === 'none') return false;
  if (scope === 'maps') return key[0] === 'maps';
  return key[0] !== 'core' || key[1] === 'athlete' || key[1] === 'sources' || key[1] === 'import-jobs';
}

/** Saved settings with the changes still on their way to the server on top (they are shown at once). */
export function withPending(saved: AthleteSettings, pending: readonly Partial<AthleteSettings>[]): AthleteSettings {
  return pending.reduce<AthleteSettings>((s, p) => ({ ...s, ...p }), saved);
}

/**
 * The `update` of the settings context, without React: shows a change at once in the settings query, sends the
 * PATCHes one after the other (a late response can no longer overwrite a newer change), puts the server's answer
 * into the cache and invalidates what the change affects.
 */
export function createSettingsUpdater(
  client: QueryClient,
  send: (patch: Partial<AthleteSettings>) => Promise<AthleteSettings>,
  onSaved?: (settings: AthleteSettings) => void,
): SettingsValue['update'] {
  let queue: Promise<unknown> = Promise.resolve();
  let pending: Partial<AthleteSettings>[] = [];
  return (patch, opts) => {
    const entry = { ...patch };
    pending = [...pending, entry];
    const shown = (async () => {
      // a refetch in flight would put the old values back
      await client.cancelQueries({ queryKey: SETTINGS_KEY });
      client.setQueryData<AthleteSettings>(SETTINGS_KEY, (old) => (old ? withPending(old, [entry]) : old));
    })();
    const run = queue
      .then(() => shown)
      .then(async () => {
        let saved: AthleteSettings;
        try {
          saved = await send(patch);
        } catch (e) {
          pending = pending.filter((p) => p !== entry);
          // refused (or no answer): show what the server has
          void client.invalidateQueries({ queryKey: ['core', 'settings'] });
          throw e;
        }
        pending = pending.filter((p) => p !== entry);
        client.setQueryData(SETTINGS_KEY, withPending(saved, pending));
        onSaved?.(saved);
        const scope = opts?.refetch === false ? 'none' : refreshScope(patch);
        if (scope !== 'none') void client.invalidateQueries({ predicate: (q) => isStaleAfter(scope, q.queryKey) });
      });
    queue = run.catch(() => undefined);
    return run;
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const status = useApi<StatusResponse>(['core', 'status'], '/status', undefined, { staleTime: 15_000 });
  const authed = !!status.data && (!status.data.authRequired || status.data.authenticated);
  const settingsQ = useApi<AthleteSettings>(['core', 'settings'], authed ? '/settings' : null);
  const athleteQ = useApi<Athlete>(['core', 'athlete'], authed ? '/athlete' : null);

  const settings = useMemo<AthleteSettings>(
    () => ({ ...DEFAULT_SETTINGS, ...cached, ...(settingsQ.data ?? {}) }),
    [settingsQ.data],
  );
  useEffect(() => {
    if (settingsQ.data) storage.setJSON('cadence.settings', settingsQ.data);
  }, [settingsQ.data]);
  useApplyTheme(settings.theme);

  const update = useMemo(
    () =>
      createSettingsUpdater(
        qc,
        (patch) => api.patch<AthleteSettings>('/settings', patch),
        (saved) => storage.setJSON('cadence.settings', saved),
      ),
    [qc],
  );

  const value = useMemo<SettingsValue>(
    () => ({
      settings,
      athlete: athleteQ.data ?? null,
      status: status.data ?? null,
      lang: resolveLang(settings.language),
      loading: status.isLoading || (authed && settingsQ.isLoading),
      update,
    }),
    [settings, athleteQ.data, status.data, status.isLoading, authed, settingsQ.isLoading, update],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsValue {
  const v = useContext(SettingsContext);
  if (!v) throw new Error('useSettings outside SettingsProvider');
  return v;
}
