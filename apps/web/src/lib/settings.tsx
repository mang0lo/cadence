import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
  /** PATCH /api/settings and refresh everything that depends on it. */
  update: (patch: Partial<AthleteSettings>) => Promise<void>;
}

const SettingsContext = createContext<SettingsValue | null>(null);

/** Cached so the very first paint already uses the right language / units. */
const cached = storage.getJSON<Partial<AthleteSettings>>('cadence.settings', {});

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

  const update = useCallback(
    async (patch: Partial<AthleteSettings>) => {
      const next = await api.patch<AthleteSettings>('/settings', patch);
      qc.setQueryData(['core', 'settings', null], next);
      storage.setJSON('cadence.settings', next);
      // HR settings change zones/effort; units change nothing server-side but refetch is cheap.
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'core' || q.queryKey[1] === 'athlete' });
    },
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
