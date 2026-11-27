import { useEffect, useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { normalizeServerUrl, onNativeCancelled, postNative, shellInfo } from '@/lib/native';

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Does anything answer at the address? (no-cors: the answer itself cannot be read, only that there is one) */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/api/status`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(6000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Settings → Server (Mac and desktop apps only): show a Cadence server, e.g. Docker on a home server, instead of the
 * one built into the app — or go back to it. The app reloads with the other server.
 */
export function ServerConnection() {
  const t = useT();
  const info = shellInfo();
  const remote = info?.remote ?? null;
  const [text, setText] = useState(remote ?? '');
  const [problem, setProblem] = useState<'invalid' | 'unreachable' | null>(null);
  const [busy, setBusy] = useState(false);
  // the app asks before it shows another server: Cancel there ends the wait here
  useEffect(() => onNativeCancelled('connectServer', () => setBusy(false)), []);

  const connect = async (force = false) => {
    const url = normalizeServerUrl(text);
    if (!url) {
      setProblem('invalid');
      return;
    }
    setBusy(true);
    setProblem(null);
    if (!force && !(await reachable(url))) {
      setBusy(false);
      setProblem('unreachable');
      return;
    }
    // the app reloads with the other server once the user confirmed it, or tells this page Cancel
    if (!postNative('connectServer', { url })) setBusy(false);
  };

  return (
    <div className="grid gap-4">
      <div className="text-sm">
        <span className="text-fg-3">{t('platform.connection.current')}: </span>
        <span className="font-medium text-fg">
          {remote ? t('platform.connection.remote', { host: hostOf(remote) }) : t('platform.connection.builtIn')}
        </span>
      </div>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect();
        }}
      >
        <Field label={t('platform.connection.address')}>
          <div className="flex gap-2">
            <Input
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setProblem(null);
              }}
              placeholder="http://homeserver.local:8787"
              inputMode="url"
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button type="submit" variant="primary" loading={busy} disabled={!text.trim()}>
              {t('platform.connection.connect')}
            </Button>
          </div>
        </Field>
        {problem === 'invalid' && <p className="text-xs text-critical-fg">{t('platform.connection.invalid')}</p>}
        {problem === 'unreachable' && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-critical-fg">
            <span>{t('platform.connection.unreachable', { host: hostOf(normalizeServerUrl(text) ?? text) })}</span>
            <Button size="sm" variant="ghost" onClick={() => void connect(true)}>
              {t('platform.connection.connectAnyway')}
            </Button>
          </div>
        )}
      </form>
      {remote && (
        <div>
          <Button onClick={() => postNative('connectServer', { url: '' })}>{t('platform.connection.useBuiltIn')}</Button>
        </div>
      )}
      <p className="text-xs text-fg-3">{t('platform.connection.note')}</p>
    </div>
  );
}
