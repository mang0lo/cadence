import { useEffect, type ReactNode } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createBrowserRouter, Link, RouterProvider, useRouteError, type RouteObject } from 'react-router';
import { Compass, RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { Button, EmptyState, ErrorState, Page, Spinner } from '@/components/ui';
import { featureModules, namespaces, withDashboardWidgets } from '@/features/registry';
import { LoginPage } from '@/features/platform/LoginPage';
import { queryClient, UNAUTHORIZED_EVENT } from '@/lib/api';
import { fromRouteError } from '@/lib/errors';
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
      <ErrorState error={fromRouteError(error)} />
    </Page>
  );
}

/**
 * Shown instead of a page whose code could not be loaded: after an update of the server the old page files are gone,
 * or the connection dropped. Only a reload helps (it fetches the new index.html with the new file names).
 */
function ChunkError() {
  const t = useT();
  return (
    <Page>
      <EmptyState
        icon={RefreshCw}
        title={t('common.chunkError.title')}
        description={t('common.chunkError.hint')}
        action={<Button onClick={() => window.location.reload()}>{t('common.chunkError.reload')}</Button>}
      />
    </Page>
  );
}

/**
 * A rejected `lazy()` makes React Router render the shell with an empty outlet (the route's errorElement is never
 * shown) and caches the rejection, so the page stays blank until a reload. Resolve to ChunkError instead.
 */
function withChunkFallback(routes: RouteObject[]): RouteObject[] {
  return routes.map((r) => {
    const out = { ...r, errorElement: <RouteError /> } as RouteObject;
    const lazy = r.lazy;
    if (typeof lazy === 'function') {
      out.lazy = async () => {
        try {
          return await lazy();
        } catch (e) {
          console.warn('[cadence] page failed to load', e);
          return { Component: ChunkError };
        }
      };
    }
    if (r.children) (out as { children?: RouteObject[] }).children = withChunkFallback(r.children);
    return out;
  });
}

// Vite fires this when a preloaded dependency of a page cannot be fetched (typically an update deployed while the app
// was open). Reload once to get the new files; the guard avoids a reload loop when the server is really unreachable.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'cadence.chunkReloadAt';
  try {
    if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 30_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

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
      ...withChunkFallback(featureModules.flatMap((f) => f.routes).map(withDashboardWidgets)),
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
