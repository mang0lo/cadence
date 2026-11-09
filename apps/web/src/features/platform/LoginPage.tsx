import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { Logo } from '@/components/layout/Logo';
import { Button, Card, ErrorState, Field, Input } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useT } from '@/lib/i18n';

/** Shown instead of the app when the server requires a password (CADENCE_PASSWORD). */
export function LoginPage() {
  const t = useT();
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="grid min-h-full place-items-center bg-bg p-6">
      <Card className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-3">
          <Logo size={36} />
          <div>
            <h1 className="text-lg font-semibold">{t('platform.login.title')}</h1>
            <p className="text-xs text-fg-3">{t('platform.login.subtitle')}</p>
          </div>
        </div>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.post('/auth/login', { password });
              await qc.invalidateQueries();
            } catch (e) {
              setError(
                e instanceof ApiError && e.code === 'too_many_attempts'
                  ? t('platform.login.tooMany')
                  : e instanceof ApiError && e.status === 401
                    ? t('platform.login.wrong')
                    : t('platform.login.unreachable'),
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t('platform.login.password')}>
            <Input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <ErrorState error={error} />}
          <Button type="submit" variant="primary" icon={LogIn} loading={busy} disabled={!password}>
            {t('platform.login.submit')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
