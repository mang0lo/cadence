import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { CheckCircle2, FileArchive, HardDrive, Lock, RefreshCw, Smartphone, Trash2, Upload, XCircle } from 'lucide-react';
import type { ImportJob } from '@cadence/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Page,
  PageHeader,
  ProgressBar,
  Table,
  TD,
  TH,
  cn,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { isNativeShell, NATIVE_IMPORT_EVENT, postNative } from '@/lib/native';
import { useSettings } from '@/lib/settings';
import { isActive, useImportJobs } from './useImportJobs';

/** multipart upload with progress (fetch has no upload progress events). */
function uploadFile(file: File, onProgress: (f: number) => void): Promise<ImportJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/import/upload');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as ImportJob);
        else reject(new Error(body?.error?.message ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

function JobStatus({ job }: { job: ImportJob }) {
  const t = useT();
  const tone = job.status === 'done' ? 'good' : job.status === 'failed' ? 'critical' : job.status === 'cancelled' ? 'neutral' : 'accent';
  const Icon = job.status === 'done' ? CheckCircle2 : job.status === 'failed' ? XCircle : undefined;
  return (
    <Badge tone={tone} icon={Icon}>
      {t(`platform.import.status.${job.status}`)}
    </Badge>
  );
}

function ActiveJob({ job }: { job: ImportJob }) {
  const t = useT();
  const fmt = useFormat();
  const [cancelling, setCancelling] = useState(false);
  const s = job.stats;
  const elapsed = job.startedAt ? Date.now() / 1000 - job.startedAt : 0;
  const eta = job.progress > 0.03 && elapsed > 5 ? (elapsed / job.progress) * (1 - job.progress) : null;
  return (
    <Card>
      <CardHeader
        title={t('platform.import.current')}
        subtitle={job.sourceName ?? undefined}
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={XCircle}
            loading={cancelling}
            onClick={async () => {
              setCancelling(true);
              await api.post(`/import/jobs/${job.id}/cancel`).catch(() => undefined);
            }}
          >
            {t('platform.import.cancel')}
          </Button>
        }
      />
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="text-sm font-medium text-fg">
          {job.phase ? t(`platform.import.phases.${job.phase}`) : t('platform.import.status.queued')}
          {job.message && <span className="ml-2 font-normal text-fg-3">{job.message}</span>}
        </div>
        <div className="text-sm font-semibold text-fg">
          {fmt.pct(job.progress)}
          {eta != null && <span className="ml-2 text-xs font-normal text-fg-3">~{fmt.durationShort(eta)}</span>}
        </div>
      </div>
      <ProgressBar value={job.progress} />
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <MiniStat label={t('platform.import.stats.records')} value={fmt.int(s.recordsSeen)} />
        <MiniStat label={t('platform.import.stats.workouts')} value={fmt.int(s.workoutsSeen)} />
        <MiniStat label={t('platform.import.stats.routes')} value={fmt.int(s.routesParsed)} />
        <MiniStat label={t('platform.import.stats.types')} value={fmt.int(s.recordTypes)} />
      </div>
    </Card>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs text-fg-3">{label}</div>
      <div className="text-lg font-semibold text-fg">{value}</div>
      {hint && <div className="text-xs text-fg-3">{hint}</div>}
    </div>
  );
}

export default function ImportPage() {
  const t = useT();
  const fmt = useFormat();
  const qc = useQueryClient();
  const { status } = useSettings();
  const { jobs, active, refetch, error: jobsError } = useImportJobs();
  const [drag, setDrag] = useState(false);
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [resetText, setResetText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const native = isNativeShell();

  const started = useCallback(async () => {
    setError(null);
    await refetch();
  }, [refetch]);

  const startUpload = async (file: File) => {
    setError(null);
    setUpload({ name: file.name, progress: 0 });
    try {
      await uploadFile(file, (p) => setUpload({ name: file.name, progress: p }));
      await started();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUpload(null);
    }
  };

  const startLocal = useCallback(
    async (p: string) => {
      setError(null);
      try {
        await api.post<ImportJob>('/import/local', { path: p });
        await started();
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [started],
  );

  // The macOS shell's File → Import menu navigates here with ?nativePath=… when another page was open.
  const [params, setParams] = useSearchParams();
  const nativePath = params.get('nativePath');
  useEffect(() => {
    if (!nativePath) return;
    setParams({}, { replace: true });
    void startLocal(nativePath);
  }, [nativePath, setParams, startLocal]);

  // The macOS shell answers a native open panel with the picked path (no upload copy needed).
  useEffect(() => {
    const onNative = (e: Event) => {
      const p = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (p) void startLocal(p);
    };
    window.addEventListener(NATIVE_IMPORT_EVENT, onNative);
    return () => window.removeEventListener(NATIVE_IMPORT_EVENT, onNative);
  }, [startLocal]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void startUpload(file);
  };

  const choose = () => {
    if (native && postNative('pickImportFile')) return;
    fileInput.current?.click();
  };

  const busy = !!upload || !!active;
  const history = jobs.filter((j) => !isActive(j));

  return (
    <Page>
      <PageHeader title={t('platform.import.title')} subtitle={t('platform.import.subtitle')} icon={Upload} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-4">
          {active ? (
            <ActiveJob job={active} />
          ) : (
            <Card padded={false}>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}
                className={cn(
                  'm-2 flex flex-col items-center justify-center gap-3 rounded-[11px] border-2 border-dashed px-6 py-14 text-center transition-colors',
                  drag ? 'border-accent bg-accent-soft' : 'border-border-strong',
                )}
              >
                <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent-fg">
                  <FileArchive size={26} />
                </span>
                {upload ? (
                  <div className="w-full max-w-sm">
                    <div className="mb-2 text-sm font-medium">{t('platform.import.uploading', { name: upload.name })}</div>
                    <ProgressBar value={upload.progress} />
                  </div>
                ) : (
                  <>
                    <div>
                      <div className="text-base font-semibold">{t('platform.import.drop')}</div>
                      <div className="text-sm text-fg-3">{t('platform.import.dropHint')}</div>
                    </div>
                    <Button variant="primary" icon={Upload} onClick={choose} disabled={busy}>
                      {t('platform.import.choose')}
                    </Button>
                  </>
                )}
                <input
                  ref={fileInput}
                  type="file"
                  accept=".zip,.xml,application/zip,text/xml"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void startUpload(f);
                    e.target.value = '';
                  }}
                />
              </div>
              {status?.localImport && !native && (
                <div className="border-t border-border p-4">
                  <div className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                    <HardDrive size={15} className="text-fg-3" />
                    {t('platform.import.pathLabel')}
                  </div>
                  <div className="mb-2 text-xs text-fg-3">{t('platform.import.pathHint')}</div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (path.trim()) void startLocal(path.trim());
                    }}
                  >
                    <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={t('platform.import.pathPlaceholder')} />
                    <Button type="submit" disabled={!path.trim() || busy}>
                      {t('platform.import.start')}
                    </Button>
                  </form>
                </div>
              )}
            </Card>
          )}
          {(error || jobsError) && <ErrorState error={error ?? jobsError} />}

          <Card padded={false}>
            <div className="px-5 pt-4">
              <CardHeader title={t('platform.import.history')} subtitle={t('platform.import.reimportHint')} />
            </div>
            {history.length ? (
              <Table>
                <thead>
                  <tr>
                    <TH>{t('platform.import.columns.date')}</TH>
                    <TH>{t('platform.import.columns.source')}</TH>
                    <TH>{t('platform.import.columns.status')}</TH>
                    <TH numeric>{t('platform.import.columns.records')}</TH>
                    <TH numeric>{t('platform.import.columns.workouts')}</TH>
                    <TH numeric>{t('platform.import.columns.took')}</TH>
                  </tr>
                </thead>
                <tbody>
                  {history.map((j) => (
                    <tr key={j.id}>
                      <TD>{fmt.date(j.createdAt, -new Date().getTimezoneOffset(), 'dateTime')}</TD>
                      <TD className="max-w-48 truncate">{j.kind === 'rederive' ? t('platform.import.rederive') : j.sourceName}</TD>
                      <TD>
                        <JobStatus job={j} />
                        {j.error && <div className="mt-1 max-w-64 truncate text-xs text-critical-fg" title={j.error}>{j.error}</div>}
                      </TD>
                      <TD numeric>{fmt.int(j.stats.recordsInserted)}</TD>
                      <TD numeric>{fmt.int(j.stats.workoutsInserted)}</TD>
                      <TD numeric>{j.startedAt && j.finishedAt ? fmt.durationShort(j.finishedAt - j.startedAt) : '–'}</TD>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('platform.import.noHistory')} />
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('platform.import.howTitle')} icon={Smartphone} />
            <ol className="space-y-2.5 text-sm text-fg-2">
              {['how1', 'how2', 'how3'].map((k, i) => (
                <li key={k} className="flex gap-2.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-xs font-semibold text-fg">{i + 1}</span>
                  <span>{t(`platform.import.${k}`)}</span>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex items-start gap-2 rounded-control bg-surface-2 p-3 text-xs text-fg-2">
              <Lock size={14} className="mt-0.5 shrink-0 text-fg-3" />
              {t('platform.import.privacy')}
            </div>
          </Card>
          <Card>
            <CardHeader title={t('platform.import.maintenance')} />
            <div className="space-y-4 text-sm">
              <div>
                <Button
                  icon={RefreshCw}
                  disabled={busy}
                  onClick={async () => {
                    try {
                      await api.post('/import/rederive');
                      await started();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {t('platform.import.rederive')}
                </Button>
                <p className="mt-1.5 text-xs text-fg-3">{t('platform.import.rederiveHint')}</p>
              </div>
              <div>
                <Button variant="ghost" icon={Trash2} className="text-critical-fg" disabled={busy} onClick={() => setResetOpen(true)}>
                  {t('platform.import.reset')}
                </Button>
                <p className="mt-1.5 text-xs text-fg-3">{t('platform.import.resetHint')}</p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={t('platform.import.reset')}
        actions={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={resetText !== 'DELETE'}
              onClick={async () => {
                try {
                  await api.post('/import/reset', { confirm: 'DELETE' });
                  setResetOpen(false);
                  setResetText('');
                  await qc.invalidateQueries();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-sm text-fg-2">{t('platform.import.resetHint')}</p>
        <Input value={resetText} onChange={(e) => setResetText(e.target.value)} placeholder={t('platform.import.resetConfirm')} />
      </Dialog>
    </Page>
  );
}
