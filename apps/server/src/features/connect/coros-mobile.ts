import { createCipheriv, randomInt } from 'node:crypto';
import type { CorosRegion } from '@cadence/shared';
import { CorosApiError, CorosHttpError } from './coros-client';

/**
 * The COROS phone app's API (apieu.coros.com …): the only place with sleep, steps, calories and all-day heart rate.
 * Unofficial, like the Training Hub client; login and request format as documented by github.com/cygnusb/coros-mcp
 * (MIT): the app encrypts e-mail and password hash with AES-128-CBC (key = a random 16-digit appKey sent along,
 * fixed IV from the app) after XOR-ing them with the appKey.
 *
 * A mobile login can sign the athlete's phone app out, so the token is kept and reused; Cadence only logs in again
 * when COROS rejects it.
 */
export const COROS_MOBILE_URL: Record<CorosRegion, string> = {
  en: 'https://api.coros.com',
  eu: 'https://apieu.coros.com',
  cn: 'https://apicn.coros.com',
};

const IV = Buffer.from('weloop3_2015_03#', 'ascii');
/** Device fingerprint of the Android app the format was captured from (COROS rejects unknown clients). */
const YF_HEADER = JSON.stringify({
  appVersion: 1125917087236096,
  clientType: 1,
  language: 'en-US',
  mobileName: 'sdk_gphone64_arm64,google,Google',
  releaseType: 1,
  systemVersion: '13',
  timezone: 4,
  versionCode: '404080400',
});

export function mobileEncrypt(plain: string, appKey: string): string {
  const key = Buffer.from(appKey, 'ascii');
  const data = Buffer.from(plain, 'utf8');
  const xored = Buffer.from(data.map((b, i) => b ^ key[i % key.length]!));
  const c = createCipheriv('aes-128-cbc', key, IV); // PKCS#7 padding
  return Buffer.concat([c.update(xored), c.final()]).toString('base64') + '\n';
}

/** dataType values of coros/data/statistic/daily (others answer nothing). */
export const MOBILE_DATA = {
  calories: 1,
  activeTime: 2,
  steps: 3,
  heartRate: 4,
  sleep: 5,
  restingHr: 6,
  /** Day summary with the progress towards the daily goals (the COROS app's rings). */
  calendar: 12,
} as const;

export interface MobileDay {
  happenDay: number;
  /** cal (not kcal) */
  calorie?: number;
  /** seconds */
  motionTime?: number;
  step?: number;
  heartRateData?: { avgHeartRate?: number; maxHeartRate?: number; minHeartRate?: number; testRhr?: number };
  /** minutes */
  sleepData?: {
    totalSleepTime?: number;
    deepTime?: number;
    lightTime?: number;
    eyeTime?: number;
    wakeTime?: number;
    shortSleepTime?: number;
    avgHeartRate?: number;
    minHeartRate?: number;
    maxHeartRate?: number;
  };
  rhr?: number;
  /** Day summary: calories (cal) and active time (s) with the share of the daily goal in % (capped at 100). */
  calendarData?: { calorie?: number; calorieStandardRate?: number; motionTime?: number; motionTimeStandardRate?: number };
  [key: string]: unknown;
}

export interface CorosMobileOptions {
  region: CorosRegion;
  token?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class CorosMobileClient {
  readonly baseUrl: string;
  token: string | null;
  private readonly doFetch: typeof fetch;
  private readonly timeout: number;

  constructor(o: CorosMobileOptions) {
    this.baseUrl = COROS_MOBILE_URL[o.region];
    this.token = o.token ?? null;
    this.doFetch = o.fetch ?? fetch;
    this.timeout = o.timeoutMs ?? 60_000;
  }

  private async post<T>(path: string, body: unknown, headers: Record<string, string>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    let res: Response;
    try {
      res = await this.doFetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new CorosHttpError(
        ctrl.signal.aborted ? 'COROS did not answer in time' : `Could not reach COROS: ${(e as Error).message}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let env: { result?: string; message?: string; data?: T };
    try {
      env = JSON.parse(text);
    } catch {
      throw new CorosHttpError(
        res.status === 429 ? 'COROS rate limit reached' : `Unexpected answer from COROS (HTTP ${res.status})`,
        res.status,
      );
    }
    if (env.result !== '0000') throw new CorosApiError(`COROS: ${env.message || `error ${env.result}`}`, String(env.result));
    return env.data as T;
  }

  /** Log in like the phone app. `pwdMd5` = md5(password). */
  async login(email: string, pwdMd5: string): Promise<string> {
    const appKey = String(randomInt(1_000_000_000, 10_000_000_000)) + String(randomInt(100_000, 1_000_000));
    const data = await this.post<{ accessToken?: string }>(
      '/coros/user/login',
      {
        account: mobileEncrypt(email, appKey),
        accountType: 2,
        appKey,
        clientType: 1,
        hasHrCalibrated: 0,
        kbValidity: 0,
        pwd: mobileEncrypt(pwdMd5, appKey),
        region: '310|Europe/Berlin|US',
        skipValidation: false,
      },
      { 'user-agent': 'okhttp/4.12.0', 'request-time': String(Date.now()), yfheader: YF_HEADER },
    );
    if (!data?.accessToken) throw new CorosApiError('COROS did not return an access token', 'no_token');
    this.token = data.accessToken;
    return data.accessToken;
  }

  /** Daily values of one data type between two days ('YYYYMMDD' numbers, inclusive). */
  async daily(dataType: number, startDay: number, endDay: number): Promise<MobileDay[]> {
    if (!this.token) throw new CorosApiError('Not logged in to the COROS app API', '1019');
    const data = await this.post<{ statisticData?: { dayDataList?: MobileDay[] } }>(
      `/coros/data/statistic/daily?accessToken=${encodeURIComponent(this.token)}`,
      { allDeviceSleep: 1, dataType: [dataType], dataVersion: 0, startTime: startDay, endTime: endDay, statisticType: 1 },
      { accesstoken: this.token },
    );
    return data?.statisticData?.dayDataList ?? [];
  }
}
