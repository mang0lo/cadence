import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, queryClient } from '@/lib/api';
import { describeError, ERROR_CODES } from '@/lib/errors';
import type { Messages, TFunction } from '@/lib/i18n';
import { commonMessages } from '@/lib/messages';

/** The app's `t` for the common namespace (lookup + {var} interpolation), without React. */
function tFor(lang: 'en' | 'de'): TFunction {
  return (key, vars) => {
    const [ns, ...path] = key.split('.');
    if (ns !== 'common') return key;
    let cur: string | Messages | undefined = commonMessages[lang];
    for (const p of path) cur = typeof cur === 'object' ? cur[p] : undefined;
    if (typeof cur !== 'string') return key;
    return cur.replace(/\{(\w+)\}/g, (_, n: string) => String(vars?.[n] ?? `{${n}}`));
  };
}

describe('error states in the user language', () => {
  const de = tFor('de');

  it('translates API errors by code and keeps the server message as a detail', () => {
    const busy = new ApiError(409, 'busy', 'A COROS sync is running');
    expect(describeError(busy, de)).toEqual({
      message: 'Gerade läuft ein Import oder eine Synchronisierung. Versuch es noch einmal, wenn sie fertig ist.',
      detail: 'A COROS sync is running',
    });
    const bad = new ApiError(400, 'invalid_request', 'Intraday view is only available for quantity types');
    expect(describeError(bad, de).message).toBe(
      'Diese Anfrage konnte nicht verarbeitet werden. Prüf deine Eingaben und versuch es noch einmal.',
    );
    expect(describeError(bad, de).detail).toBe('Intraday view is only available for quantity types');
  });

  it('falls back to a generic message with the status for unknown codes', () => {
    expect(describeError(new ApiError(502, 'http_error', '502 Bad Gateway'), de)).toEqual({
      message: 'Auf dem Server ist ein Problem aufgetreten (Fehler 502). Versuch es später noch einmal.',
      detail: '502 Bad Gateway',
    });
    expect(describeError(new ApiError(418, 'teapot', ''), de)).toEqual({
      message: 'Etwas ist schiefgegangen (Fehler 418).',
      detail: null,
    });
  });

  it('takes strings and plain errors as already translated', () => {
    expect(describeError('Falsches Passwort', de)).toEqual({ message: 'Falsches Passwort', detail: null });
    expect(describeError(new Error('Messwert nicht gefunden'), de)).toEqual({ message: 'Messwert nicht gefunden', detail: null });
    expect(describeError(undefined, de)).toEqual({ message: 'Etwas ist schiefgegangen.', detail: null });
  });

  it('shows the technical text of the error a translated one wraps (cause) as its detail', () => {
    const cause = new ApiError(409, 'busy', 'A COROS sync is running');
    expect(describeError(new Error('2 Dateien fehlgeschlagen', { cause }), de)).toEqual({
      message: '2 Dateien fehlgeschlagen',
      detail: 'A COROS sync is running',
    });
    expect(describeError(new Error('Nicht gespeichert', { cause: new Error('Speichern fehlgeschlagen') }), de).detail).toBeNull();
  });

  it('has an English and a German message for every code', () => {
    for (const lang of ['en', 'de'] as const) {
      const t = tFor(lang);
      for (const key of [...ERROR_CODES, 'server', 'default', 'unknown']) {
        expect(t(`common.errors.${key}`), `${lang} ${key}`).not.toBe(`common.errors.${key}`);
      }
    }
  });
});

describe('requests without an answer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fail with a coded network error that is shown translated and retried', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const err = await api.get('/workouts').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network', message: 'Failed to fetch' });
    expect(describeError(err, tFor('en'))).toEqual({
      message: 'No connection to the Cadence server. Check the connection and try again.',
      detail: 'Failed to fetch',
    });
    const retry = queryClient.getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;
    expect(retry(0, err)).toBe(true);
    expect(retry(0, new ApiError(404, 'not_found', 'gone'))).toBe(false);
    expect(retry(0, new ApiError(503, 'error', 'down'))).toBe(true);
    expect(retry(2, err)).toBe(false);
  });

  it('pass a cancellation through unchanged', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(api.get('/workouts')).rejects.toBe(abort);
  });
});
