import { createHash } from 'node:crypto';
import type { CorosRegion } from '@cadence/shared';
import { CorosApiError, CorosHttpError, CorosTransport, type CorosTransportOptions } from './coros-transport';

export { CorosApiError, CorosHttpError } from './coros-transport';

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
 * - The API rate-limits aggressively (HTTP 429): requests are spaced out and retried with backoff (coros-transport.ts).
 *   The file itself comes from a storage host: retried, but not spaced.
 */

export const COROS_BASE_URL: Record<CorosRegion, string> = {
  en: 'https://teamapi.coros.com',
  eu: 'https://teameuapi.coros.com',
  cn: 'https://teamcnapi.coros.com',
};

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

export const md5Hex = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

export interface CorosClientOptions extends CorosTransportOptions {
  region: CorosRegion;
  accessToken?: string | null;
}

export class CorosClient {
  readonly baseUrl: string;
  accessToken: string | null;
  private readonly http: CorosTransport;

  constructor(o: CorosClientOptions) {
    this.baseUrl = COROS_BASE_URL[o.region];
    this.accessToken = o.accessToken ?? null;
    this.http = new CorosTransport(o);
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
    return this.http.retry(async () => {
      const res = await this.http.fetch(data.fileUrl!, { method: 'GET' }, false);
      if (!res.ok) throw new CorosHttpError(`FIT download failed (HTTP ${res.status})`, res.status);
      return new Uint8Array(await res.arrayBuffer());
    });
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
    return this.http.request<T>(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
}
