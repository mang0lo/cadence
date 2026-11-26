import { useRef, useState } from 'react';
import { DatabaseBackup, Download, FolderOpen, Upload } from 'lucide-react';
import { Button, Card, CardHeader, ErrorState, ProgressBar } from '@/components/ui';
import { ApiError, UNAUTHORIZED_EVENT } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { isNativeShell, postNative } from '@/lib/native';

/** Fails with an ApiError like the api helpers; `failed` is the message when the server gave none. */
function uploadBackup(file: File, onProgress: (f: number) => void, failed: string): Promise<{ restarting: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backup/restore');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { restarting?: boolean; error?: { code?: string; message?: string } } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve({ restarting: !!body.restarting });
      else
        reject(new ApiError(xhr.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `${failed} (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', failed));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** Wait until the restarted server answers again, then reload (the macOS shell reloads by itself). */
async function waitForRestart() {
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.ok) {
        window.location.reload();
        return;
      }
    } catch {
      /* still restarting */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Settings → backup download / restore (moving between the Mac app and a server). */
export function BackupSection() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const restore = async (file: File) => {
    if (!window.confirm(t('platform.settings.restoreConfirm'))) return;
    setError(null);
    setProgress(0);
    try {
      const res = await uploadBackup(file, setProgress, t('platform.settings.restoreFailed'));
      if (res.restarting) {
        setMessage(t('platform.settings.restarting'));
        void waitForRestart();
      } else {
        setMessage(t('platform.settings.restoredDev'));
      }
    } catch (e) {
      setError(e);
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card>
      <CardHeader title={t('platform.settings.backup')} icon={DatabaseBackup} />
      <p className="mb-4 text-sm text-fg-3">{t('platform.settings.backupHint')}</p>
      <div className="flex flex-wrap gap-2">
        <a href="/api/backup" download>
          <Button icon={Download}>{t('platform.settings.download')}</Button>
        </a>
        <Button icon={Upload} onClick={() => input.current?.click()} disabled={progress !== null}>
          {t('platform.settings.restore')}
        </Button>
        {isNativeShell() && (
          <Button variant="ghost" icon={FolderOpen} onClick={() => postNative('openDataFolder')}>
            {t('platform.settings.openFolder')}
          </Button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept=".db,.sqlite,application/vnd.sqlite3,application/x-sqlite3"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void restore(f);
          e.target.value = '';
        }}
      />
      {progress !== null && <ProgressBar className="mt-4" value={progress} />}
      {message && <div className="mt-4 rounded-control bg-surface-2 px-3 py-2 text-sm text-fg-2">{message}</div>}
      {error ? <ErrorState className="mt-4" error={error} /> : null}
    </Card>
  );
}
