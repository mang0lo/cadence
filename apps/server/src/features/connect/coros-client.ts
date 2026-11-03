import { createHash } from 'node:crypto';
import type { CorosRegion } from '@cadence/shared';

/**
 * Minimal client for the private API behind COROS Training Hub (https://training.coros.com), the same calls the
 * web app makes. Unofficial: COROS can change it at any time. Endpoints, envelope and quirks as documented by
 * the community clients (github.com/Pinta365/coros, MIT; pypi corosexport).
 *
 * - Login: POST account/login {account, accountType: 2, pwd: md5(password)} → data.accessToken.
 *   Logging in elsewhere (Training Hub in a browser, sometimes the app) can invalidate the token.
 * - Every response is an envelope {result: '0000' | error code, message, data}.
 * - activity/query?pageNumber&size (≤ 200), newest first. Values are unscaled (m, s, epoch seconds).
 * - activity/detail/download?labelId&sportType&fileType=4 (FIT) → data.fileUrl, a signed storage URL.
 * - The API rate-limits aggressively (HTTP 429): requests are spaced out and retried with backoff.
 */

export const COROS_BASE_URL: Record<CorosRegion, string> = {
  en: 'https://teamapi.coros.com',
  eu: 'https://teameuapi.coros.com',
  cn: 'https://teamcnapi.coros.com',
};

const SUCCESS = '0000';
const FILE_TYPE_FIT = '4';
export const COROS_MAX_PAGE_SIZE = 200;

export interface CorosActivity {
  labelId: string;
  name?: string | null;
  sportType: number;
  /** YYYYMMDD */
  date?: number;
  /** Epoch seconds. */
  startTime?: number;
  endTime?: number;
  /** Device model, e.g. "COROS PACE 3". */
  device?: string;
  /** Metres. */
  distance?: number;
  /** Seconds. */
  totalTime?: number;
  [key: string]: unknown;
}

export interface CorosActivityPage {
  count: number;
  totalPage?: number;
  pageNumber?: number;
  dataList?: CorosActivity[];
}

export interface CorosLogin {
  accessToken: string;
  userId: string | null;
  nickname: string | null;
}

/** The API answered with an error result (wrong password, invalid token …). */
export class CorosApiError extends Error {
  constructor(
    message: string,
    readonly result: string,
  ) {
    super(message);
    this.name = 'CorosApiError';
  }
}

/** Transport failure: network error, timeout, rate limit, non-JSON body. */
export class CorosHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CorosHttpError';
  }
  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export const md5Hex = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

export interface CorosClientOptions {
  region: CorosRegion;
  accessToken?: string | null;
  /** Minimum gap between two requests (ms). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Backoff delays for HTTP 429 / 5xx (ms); one retry per entry. */
  retryDelaysMs?: number[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class CorosClient {
  readonly baseUrl: string;
  accessToken: string | null;
  private last = 0;
  private readonly minInterval: number;
  private readonly timeout: number;
  private readonly retries: number[];
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: CorosClientOptions) {
    this.baseUrl = COROS_BASE_URL[o.region];
    this.accessToken = o.accessToken ?? null;
    this.minInterval = o.minIntervalMs ?? 400;
    this.timeout = o.timeoutMs ?? 60_000;
    this.retries = o.retryDelaysMs ?? [5_000, 15_000, 45_000];
    this.doFetch = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** `pwdMd5` = md5Hex(password): Cadence only ever keeps the hash. */
  async login(email: string, pwdMd5: string): Promise<CorosLogin> {
    const data = await this.request<Record<string, unknown>>('POST', 'account/login', undefined, {
      account: email,
      accountType: 2,
      pwd: pwdMd5,
    });
    const token = typeof data?.accessToken === 'string' ? data.accessToken : null;
    if (!token) throw new CorosApiError('COROS did not return an access token', 'no_token');
    this.accessToken = token;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
    return { accessToken: token, userId: str(data.userId), nickname: str(data.nickname) };
  }

  /** One page of the activity list (1-based), newest first. */
  listActivities(page: number, size = COROS_MAX_PAGE_SIZE): Promise<CorosActivityPage> {
    return this.request<CorosActivityPage>('GET', 'activity/query', { pageNumber: page, size });
  }

  /** Any API call (envelope unwrapped): used by the probe script and the health sync. */
  call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string | number>,
    body?: unknown,
  ): Promise<T> {
    return this.request<T>(method, path, query, body);
  }

  /** The activity's FIT file as recorded by the watch. */
  async downloadFit(labelId: string, sportType: number): Promise<Uint8Array> {
    const data = await this.request<{ fileUrl?: string }>(
      'POST',
      'activity/detail/download',
      { labelId, sportType, fileType: FILE_TYPE_FIT },
      {},
    );
    if (!data?.fileUrl) throw new CorosApiError('COROS did not return a download link', 'no_file');
    return this.withRetry(async () => {
      const res = await this.timed(data.fileUrl!, { method: 'GET' });
      if (!res.ok) throw new CorosHttpError(`FIT download failed (HTTP ${res.status})`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    });
  }

  private async timed(url: string, init: RequestInit): Promise<Response> {
    const wait = this.last + this.minInterval - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      return await this.doFetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new CorosHttpError('COROS did not answer in time', 0);
      throw new CorosHttpError(`Could not reach COROS: ${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const retryable = e instanceof CorosHttpError && (e.rateLimited || e.status >= 500 || e.status === 0);
        if (!retryable || attempt >= this.retries.length) throw e;
        await this.sleep(this.retries[attempt]!);
      }
    }
  }

  private request<T>(
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string | number>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, this.baseUrl + '/');
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.accessToken) headers.accessToken = this.accessToken;
    return this.withRetry(async () => {
      const res = await this.timed(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let env: { result?: unknown; message?: unknown; data?: T };
      try {
        env = JSON.parse(text);
      } catch {
        throw new CorosHttpError(
          res.status === 429
            ? 'COROS rate limit reached'
            : `Unexpected answer from COROS (HTTP ${res.status})`,
          res.status,
        );
      }
      if (typeof env?.result !== 'string') {
        throw new CorosHttpError(`Unexpected answer from COROS (HTTP ${res.status})`, res.status);
      }
      if (env.result !== SUCCESS) {
        const msg = typeof env.message === 'string' && env.message ? env.message : `error ${env.result}`;
        throw new CorosApiError(`COROS: ${msg}`, env.result);
      }
      if (!res.ok) throw new CorosHttpError(`COROS answered HTTP ${res.status}`, res.status);
      return env.data as T;
    });
  }
}
