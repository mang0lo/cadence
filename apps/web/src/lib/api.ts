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

async function request<T>(method: string, path: string, body?: unknown, params?: QueryParams): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path, params), init);
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
  get: <T>(path: string, params?: QueryParams) => request<T>('GET', path, undefined, params),
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
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      // Keep showing the previous data while a new key loads (no skeleton flash on filter changes).
      placeholderData: (prev: unknown) => prev,
    },
  },
});

/**
 * GET helper: `useApi<WorkoutSummary[]>(['activities', 'list', filters], '/workouts', filters)`.
 * Query keys start with the feature name so a finished import can invalidate everything.
 */
export function useApi<T>(
  key: readonly unknown[],
  path: string | null,
  params?: QueryParams,
  options?: Omit<UseQueryOptions<T, ApiError>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T, ApiError>({
    queryKey: [...key, params ?? null],
    queryFn: () => api.get<T>(path!, params),
    enabled: path !== null && (options?.enabled ?? true),
    ...options,
  });
}
