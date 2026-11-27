import { QueryClient, useQuery, type UseQueryOptions } from '@tanstack/react-query';

/** Error thrown for non-2xx responses; carries the server's `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fired on any 401 so the app can show the login screen (server deployments with a password). */
export const UNAUTHORIZED_EVENT = 'cadence:unauthorized';

export type QueryParams = Record<string, string | number | boolean | null | undefined | (string | number)[]>;

/** Build `/api/...?a=1&b=2`, skipping null/undefined/'' values; arrays are comma-joined. */
export function apiUrl(path: string, params?: QueryParams): string {
  const url = path.startsWith('/api') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  if (!params) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = qs.toString();
  return s ? `${url}?${s}` : url;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  params?: QueryParams,
  signal?: AbortSignal,
): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {}, signal };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(apiUrl(path, params), init);
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') throw e;
    // no answer at all (offline, server stopped …): a coded error like the server's, so it can be shown translated
    throw new ApiError(0, 'network', e instanceof Error ? e.message : String(e));
  }
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (!res.ok) {
    let code = 'http_error';
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: { code?: string; message?: string } };
      code = data.error?.code ?? code;
      message = data.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  /** `signal` cancels the request (useApi passes the query's: a superseded or unused query stops loading). */
  get: <T>(path: string, params?: QueryParams, signal?: AbortSignal) => request<T>('GET', path, undefined, params, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // client errors (4xx) are final; server errors and no answer at all (status 0) are tried again
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      // Keep showing the previous data while a new key loads (no skeleton flash on filter changes).
      placeholderData: (prev: unknown) => prev,
    },
  },
});

export type ApiQueryOptions<T> = Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>;

/**
 * The query options behind useApi. The fetch gets the query's AbortSignal: when the key changes (filters, ranges,
 * tabs) or the page is left while it loads, TanStack cancels the request instead of letting the server finish it.
 * Without a path the query never runs, whatever `options.enabled` says.
 */
export function apiQuery<T>(
  key: readonly unknown[],
  path: string | null,
  params?: QueryParams,
  options?: ApiQueryOptions<T>,
): UseQueryOptions<T, ApiError> {
  return {
    ...options,
    queryKey: [...key, params ?? null],
    queryFn: ({ signal }) => api.get<T>(path!, params, signal),
    enabled: path !== null && (options?.enabled ?? true),
  };
}

/**
 * GET helper: `useApi<WorkoutSummary[]>(['activities', 'list', filters], '/workouts', filters)`.
 * Query keys start with the feature name so a finished import can invalidate everything.
 */
export function useApi<T>(key: readonly unknown[], path: string | null, params?: QueryParams, options?: ApiQueryOptions<T>) {
  return useQuery<T, ApiError>(apiQuery<T>(key, path, params, options));
}
