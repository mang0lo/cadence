/**
 * HTTP layer shared by both COROS APIs (Training Hub, coros-client.ts, and the phone app's, coros-mobile.ts): request
 * timeout, spacing between API requests (COROS rate-limits aggressively), retries with backoff for HTTP 429 / 5xx /
 * network errors, and the response envelope {result: '0000' | error code, message, data}.
 */

const SUCCESS = '0000';
/** Result codes COROS answers when the access token expired or was replaced by another login. */
const AUTH_RESULTS = new Set(['1019']);
/** Error results Cadence makes up itself (never a sign of an expired token). */
const OWN_RESULTS = new Set(['no_token', 'no_file']);

/** The API answered with an error result (wrong password, invalid token …). */
export class CorosApiError extends Error {
  constructor(
    message: string,
    readonly result: string,
  ) {
    super(message);
    this.name = 'CorosApiError';
  }

  /** The token is no longer accepted (expired, or replaced by a login elsewhere): logging in again can help. */
  get isAuth(): boolean {
    if (OWN_RESULTS.has(this.result)) return false;
    return (
      AUTH_RESULTS.has(this.result) ||
      /token|not logged in|log ?in again|re-?login|unauthori[sz]ed|authenticat/i.test(this.message)
    );
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

export interface CorosTransportOptions {
  /** Minimum gap between two API requests (ms). */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Backoff delays for HTTP 429 / 5xx / network errors (ms); one retry per entry. */
  retryDelaysMs?: number[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class CorosTransport {
  private last = 0;
  private readonly minInterval: number;
  private readonly timeout: number;
  private readonly retries: number[];
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: CorosTransportOptions = {}) {
    this.minInterval = o.minIntervalMs ?? 400;
    this.timeout = o.timeoutMs ?? 60_000;
    this.retries = o.retryDelaysMs ?? [5_000, 15_000, 45_000];
    this.doFetch = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * One HTTP request with a timeout. `spaced` requests keep the minimum gap to the previous spaced one (API calls);
   * signed file downloads come from a storage host and skip it.
   */
  async fetch(url: string, init: RequestInit, spaced = true): Promise<Response> {
    if (spaced) {
      const wait = this.last + this.minInterval - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
    }
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

  /** Run `fn` again after the backoff delays while it fails with a rate limit, a server or a network error. */
  async retry<T>(fn: () => Promise<T>): Promise<T> {
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

  /** API call (spaced, retried): the envelope's data, or CorosApiError for an error result. */
  request<T>(url: string, init: RequestInit): Promise<T> {
    return this.retry(async () => {
      const res = await this.fetch(url, init);
      const text = await res.text();
      let env: { result?: unknown; message?: unknown; data?: T };
      try {
        env = JSON.parse(text);
      } catch {
        throw new CorosHttpError(
          res.status === 429 ? 'COROS rate limit reached' : `Unexpected answer from COROS (HTTP ${res.status})`,
          res.status,
        );
      }
      const result = typeof env?.result === 'number' ? String(env.result) : env?.result;
      if (typeof result !== 'string') {
        throw new CorosHttpError(`Unexpected answer from COROS (HTTP ${res.status})`, res.status);
      }
      if (result !== SUCCESS) {
        const msg = typeof env.message === 'string' && env.message ? env.message : `error ${result}`;
        throw new CorosApiError(`COROS: ${msg}`, result);
      }
      if (!res.ok) throw new CorosHttpError(`COROS answered HTTP ${res.status}`, res.status);
      return env.data as T;
    });
  }
}
