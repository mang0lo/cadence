import { useEffect, type ReactNode } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createBrowserRouter, Link, RouterProvider, useRouteError } from 'react-router';
import { Compass } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, EmptyState, ErrorState, Page, Spinner } from '@/components/ui';
import { featureModules, namespaces } from '@/features/registry';
import { LoginPage } from '@/features/platform/LoginPage';
import { queryClient, UNAUTHORIZED_EVENT } from '@/lib/api';
import { I18nProvider, useT } from '@/lib/i18n';
import { SettingsProvider, useSettings } from '@/lib/settings';

function NotFound() {
  const t = useT();
  return (
    <Page>
      <EmptyState
        icon={Compass}
        title={t('common.notFound')}
        action={
          <Link to="/">
            <Button>{t('common.backHome')}</Button>
          </Link>
        }
      />
    </Page>
  );
}

function RouteError() {
  const error = useRouteError();
  return (
    <Page>
      <ErrorState error={error instanceof Error ? error : new Error(String((error as { statusText?: string })?.statusText ?? error))} />
    </Page>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    // shown while the first lazy page loads (React Router warns without one)
    HydrateFallback: () => (
      <div className="grid h-dvh place-items-center bg-bg">
        <Spinner size={28} />
      </div>
    ),
    children: [
      ...featureModules.flatMap((f) => f.routes).map((r) => ({ ...r, errorElement: <RouteError /> })),
      { path: '*', element: <NotFound /> },
    ],
  },
]);

/** Shows the login screen when a password-protected server says we are not authenticated. */
function AuthGate({ children }: { children: ReactNode }) {
  const { status, loading } = useSettings();
  const qc = useQueryClient();
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ['core', 'status'] });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);
  if (loading && !status) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner size={24} />
      </div>
    );
  }
  if (status?.authRequired && !status.authenticated) return <LoginPage />;
  return <>{children}</>;
}

function Localized() {
  const { lang } = useSettings();
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return (
    <I18nProvider lang={lang} namespaces={namespaces}>
      <AuthGate>
        <RouterProvider router={router} />
      </AuthGate>
    </I18nProvider>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SettingsProvider>
        <Localized />
      </SettingsProvider>
    </QueryClientProvider>
  );
}
