import { useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, FileArchive, LogOut, RefreshCw, Upload, Watch } from 'lucide-react';
import { COROS_REGIONS, type CorosLoginRequest, type CorosRegion, type CorosStatus } from '@cadence/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Field,
  Input,
  KeyValues,
  Page,
  PageHeader,
  ProgressBar,
  Select,
  Skeleton,
  Switch,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useSettings } from '@/lib/settings';
import { corosErrorText, syncRunning as running, useCorosMutations, useCorosStatus } from './api';

function LoginForm({ login }: { login: (body: CorosLoginRequest) => Promise<void> }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<CorosRegion>('eu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await login({ email, password, region });
          setPassword('');
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('connect.coros.email')}>
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </Field>
        <Field label={t('connect.coros.password')}>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
      </div>
      <Field label={t('connect.coros.region')} className="sm:max-w-xs">
        <Select
          value={region}
          onChange={setRegion}
          options={COROS_REGIONS.map((r) => ({ value: r, label: t(`connect.coros.regions.${r}`) }))}
        />
      </Field>
      <p className="text-xs text-fg-3">{t('connect.coros.passwordHint')}</p>
      {error ? (
        <ErrorState
          error={
            error instanceof ApiError && error.code === 'coros_login_failed'
              ? t('connect.coros.errors.login')
              : error instanceof ApiError && error.code === 'coros_unreachable'
                ? t('connect.coros.errors.unreachable')
                : error
          }
        />
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={busy} disabled={!email || !password}>
          {t('connect.coros.connect')}
        </Button>
      </div>
    </form>
  );
}

function SyncProgress({ status }: { status: CorosStatus }) {
  const t = useT();
  const s = status.sync;
  if (!s) return null;
  const active = running(status);
  const fraction =
    s.state === 'downloading' && s.toDownload ? (s.downloaded + s.failed) / s.toDownload : active ? 0.05 : 1;
  return (
    <div className="flex flex-col gap-2 rounded-control bg-surface-2 p-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-fg">
          {t(`connect.coros.states.${s.state}`, { done: s.downloaded + s.failed, total: s.toDownload })}
        </span>
        {s.state === 'done' && <Badge tone="good">{t('connect.coros.states.done')}</Badge>}
        {s.state === 'failed' && <Badge tone="critical">{t('connect.coros.states.failed')}</Badge>}
      </div>
      {active && <ProgressBar value={fraction} />}
      {s.state === 'failed' && s.error && <div className="text-xs text-critical-fg">{corosErrorText(t, s.error)}</div>}
      {!active && s.state === 'done' && (
        <div className="flex flex-wrap items-center gap-3 text-fg-2">
          {s.downloaded
            ? t('connect.coros.result.some', { count: s.downloaded })
            : t('connect.coros.result.none')}
          {s.healthDays > 0 && <span>{t('connect.coros.healthSynced', { count: s.healthDays })}</span>}
          {s.sleepNights > 0 && <span>{t('connect.coros.sleepSynced', { count: s.sleepNights })}</span>}
          {s.jobId && (
            <Link to="/import" className="text-accent-fg underline-offset-2 hover:underline">
              {t('connect.coros.showImport')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function CorosCard() {
  const t = useT();
  const fmt = useFormat();
  // the status reacts to the sync itself (its import job, its end); the mutations to what they change elsewhere
  const q = useCorosStatus();
  const m = useCorosMutations();
  const [error, setError] = useState<unknown>(null);
  const status = q.data;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
      void q.refetch();
    }
  };
  const syncing = running(status);
  const { settings } = useSettings();

  return (
    <Card>
      <CardHeader
        title={t('connect.coros.title')}
        subtitle={t('connect.coros.subtitle')}
        icon={Watch}
        actions={
          status?.connected ? (
            <Badge tone="good">
              {t('connect.coros.connected', { name: status.nickname ?? status.email ?? '' })}
            </Badge>
          ) : undefined
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-control bg-surface-2 p-3 text-xs text-fg-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-fg-3" />
        {t('connect.coros.unofficial')}
      </div>
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : !status?.connected ? (
        <LoginForm login={m.login} />
      ) : (
        <div className="flex flex-col gap-4">
          <KeyValues
            items={[
              [t('connect.coros.email'), status.email],
              [t('connect.coros.region'), t(`connect.coros.regions.${status.region}`)],
              [
                t('connect.coros.lastSync'),
                status.lastSyncAt ? fmt.browserDate(status.lastSyncAt, 'dateTime') : t('connect.coros.never'),
              ],
              [t('connect.coros.fetched'), fmt.int(status.activities.fetched)],
              ...(status.activities.failed
                ? ([[t('connect.coros.failed'), fmt.int(status.activities.failed)]] as [string, string][])
                : []),
              ...(status.health.days && status.health.firstDay && status.health.lastDay
                ? ([
                    [
                      t('connect.coros.healthDays'),
                      t('connect.coros.healthRange', {
                        count: status.health.days,
                        from: fmt.day(status.health.firstDay, 'day'),
                        to: fmt.day(status.health.lastDay, 'day'),
                      }),
                    ],
                  ] as [string, string][])
                : []),
              ...(status.activities.lastStartTs
                ? ([
                    [t('connect.coros.newest'), fmt.browserDate(status.activities.lastStartTs, 'dateTime')],
                  ] as [string, string][])
                : []),
            ]}
          />
          {settings.watch !== 'coros' && (
            <div className="flex flex-wrap items-center gap-2 rounded-control bg-surface-2 p-3 text-xs text-fg-2">
              {t('connect.coros.notMyWatch', { watch: t(`platform.settings.watch.kinds.${settings.watch}`) })}
              <Link to="/settings" className="text-accent-fg underline-offset-2 hover:underline">
                {t('connect.coros.toSettings')}
              </Link>
            </div>
          )}
          {status.lastError && !syncing && <ErrorState error={corosErrorText(t, status.lastError)} />}
          <SyncProgress status={status} />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              icon={RefreshCw}
              loading={syncing}
              onClick={() => act(() => m.sync(false))}
            >
              {t('connect.coros.syncNow')}
            </Button>
            <Button
              icon={RefreshCw}
              disabled={syncing}
              title={t('connect.coros.fullSyncHint')}
              onClick={() => act(() => m.sync(true))}
            >
              {t('connect.coros.fullSync')}
            </Button>
            <Button
              variant="ghost"
              icon={LogOut}
              disabled={syncing}
              className="text-critical-fg"
              onClick={() => {
                if (window.confirm(t('connect.coros.disconnectConfirm')))
                  void act(m.disconnect);
              }}
            >
              {t('connect.coros.disconnect')}
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <Switch
              checked={status.mobileData}
              onChange={(v) => act(() => m.prefs({ mobileData: v }))}
              label={t('connect.coros.mobileData')}
            />
            <span className="mb-2 text-xs text-fg-3">{t('connect.coros.mobileDataHint')}</span>
            <Switch
              checked={status.autoSync}
              onChange={(v) => act(() => m.prefs({ autoSync: v }))}
              label={t('connect.coros.autoSync')}
            />
            <span className="text-xs text-fg-3">{t('connect.coros.autoSyncHint')}</span>
          </div>
          {error ? <ErrorState error={error} /> : null}
        </div>
      )}
    </Card>
  );
}

export default function ConnectPage() {
  const t = useT();
  return (
    <Page>
      <PageHeader title={t('connect.page.title')} subtitle={t('connect.page.subtitle')} icon={Watch} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <CorosCard />
        <Card className="self-start">
          <CardHeader title={t('connect.page.fitTitle')} icon={FileArchive} />
          <p className="mb-4 text-sm text-fg-2">{t('connect.page.fitHint')}</p>
          <Link to="/import">
            <Button icon={Upload}>{t('connect.page.toImport')}</Button>
          </Link>
        </Card>
      </div>
    </Page>
  );
}
