import { ApiError } from './api';
import type { TFunction } from './i18n';

/**
 * Error codes with a message of their own under `common.errors`: the API's `{ error: { code } }` and 'network' for
 * a request that got no answer. Any other code gets the generic message with the HTTP status.
 */
export const ERROR_CODES = [
  'network',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'too_many_attempts',
  'too_large',
  'busy',
] as const;

const KNOWN = new Set<string>(ERROR_CODES);

export interface ErrorText {
  /** In the user's language. */
  message: string;
  /** The technical text the error came with (the server's English message, the browser's network error), if any. */
  detail: string | null;
}

/**
 * What an error state shows. API errors are translated by their code; the server's message (English by design) is
 * kept as a detail. Strings and other errors are taken as already translated (callers pass `t(...)` texts); an error
 * that wraps another one (`new Error(t(...), { cause })`) shows the technical text of its cause as the detail.
 */
export function describeError(error: unknown, t: TFunction): ErrorText {
  if (typeof error === 'string') return { message: error, detail: null };
  if (error instanceof ApiError) {
    const message = KNOWN.has(error.code)
      ? t(`common.errors.${error.code}`)
      : t(error.status >= 500 ? 'common.errors.server' : 'common.errors.default', { status: error.status });
    const raw = error.message.trim();
    return { message, detail: raw && raw !== message ? raw : null };
  }
  if (error instanceof Error && error.message)
    return { message: error.message, detail: error.cause === undefined ? null : describeError(error.cause, t).detail };
  return { message: t('common.errors.unknown'), detail: error == null || typeof error === 'object' ? null : String(error) };
}
