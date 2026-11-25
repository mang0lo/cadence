import { CorosApiError } from './coros-transport';

/** COROS no longer takes the stored login (password changed, account gone): the athlete has to connect again. */
export class CorosLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorosLoginError';
  }
}

export interface CorosSessionOptions {
  /** The token the client sends right now (null: log in before the first call). */
  token: () => string | null;
  /** Log in with the stored credentials and keep the new token (throws CorosLoginError when COROS refuses them). */
  login: () => Promise<void>;
  /** Logins allowed per session, i.e. per sync (each one can sign other COROS sessions out). Default 2. */
  maxLogins?: number;
}

/**
 * One sync's COROS login: runs API calls and logs in again when COROS rejects the token (`CorosApiError.isAuth`),
 * once per token – a call that failed with a token another call already replaced is just retried. Other API errors
 * (a missing file, …) never cost a login. After `maxLogins` the auth error is thrown: the caller stops the sync.
 */
export class CorosSession {
  private logins = 0;
  private readonly maxLogins: number;

  constructor(private readonly o: CorosSessionOptions) {
    this.maxLogins = o.maxLogins ?? 2;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.o.token()) await this.login();
    for (;;) {
      const used = this.o.token();
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof CorosApiError) || !e.isAuth) throw e;
        if (this.o.token() !== used) continue;
        if (this.logins >= this.maxLogins) throw e;
        await this.login();
      }
    }
  }

  private async login(): Promise<void> {
    this.logins++;
    await this.o.login();
  }
}

/** True when a sync cannot go on with this login: COROS keeps rejecting the token, or the credentials. */
export const isAuthFailure = (e: unknown): boolean =>
  e instanceof CorosLoginError || (e instanceof CorosApiError && e.isAuth);
