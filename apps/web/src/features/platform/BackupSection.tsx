import { useRef, useState } from 'react';
import { DatabaseBackup, Download, FolderOpen, Upload } from 'lucide-react';
import { Button, Card, CardHeader, ErrorState, ProgressBar } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { isNativeShell, postNative } from '@/lib/native';

function uploadBackup(file: File, onProgress: (f: number) => void): Promise<{ restarting: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backup/restore');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body?.error?.message ?? `Restore failed (${xhr.status})`));
      } catch {
        reject(new Error(`Restore failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Restore failed'));
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
  const [error, setError] = useState<string | null>(null);

  const restore = async (file: File) => {
    if (!window.confirm(t('platform.settings.restoreConfirm'))) return;
    setError(null);
    setProgress(0);
    try {
      const res = await uploadBackup(file, setProgress);
      if (res.restarting) {
        setMessage(t('platform.settings.restarting'));
        void waitForRestart();
      } else {
        setMessage(t('platform.settings.restoredDev'));
      }
    } catch (e) {
      setError((e as Error).message);
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
      {error && <ErrorState className="mt-4" error={error} />}
    </Card>
  );
}
