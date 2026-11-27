import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/** A change of the URL's search params: a string sets its key, null or '' deletes it. */
export type ParamsPatch = Record<string, string | null>;

/** `prev` with `patch` applied (a new object; `prev` stays as it is). */
export function patchParams(prev: URLSearchParams, patch: ParamsPatch): URLSearchParams {
  const next = new URLSearchParams(prev);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') next.delete(k);
    else next.set(k, v);
  }
  return next;
}

/**
 * Filters kept in the URL (linkable, back button friendly): the page's search params, a patcher and `clear`. Changes
 * replace the history entry, so filter clicks do not pile up behind the back button. `apply` turns a patch into the
 * new params (default patchParams; a page adds its own rules, e.g. back to page 1); pass a module-level function.
 */
export function useUrlParams(apply: (prev: URLSearchParams, patch: ParamsPatch) => URLSearchParams = patchParams) {
  const [params, setParams] = useSearchParams();
  const patch = useCallback(
    (p: ParamsPatch) => setParams((prev) => apply(prev, p), { replace: true }),
    [setParams, apply],
  );
  const clear = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  return [params, patch, clear] as const;
}
