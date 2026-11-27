/**
 * What the desktop app lets the pages in its window do. The macOS shell follows the same rules
 * (apps/macos/Sources/Cadence/ShellPolicy.swift):
 *
 *  - The app's pages are those of the Cadence server it shows: the origin (scheme, host, port) of that server, and
 *    the origin the server sent the app's own load to (e.g. a redirect from http to https).
 *  - Only the main frame of an app page reaches the native bridge (import picker, saving files, Settings → Server).
 *  - The app's pages navigate within the window. Links and page navigations to other sites open in the default
 *    browser instead. Pages that a server redirect brings into the window still load there, but never reach the
 *    bridge.
 *  - Only http(s) and mailto URLs are handed to the operating system; file:, smb:, search-ms:, custom app schemes
 *    and the like never are.
 *  - Of the browser permissions, app pages get writing to the clipboard (share image) and fullscreen; everything
 *    else (camera, microphone, location, notifications, opening other apps …) is denied.
 *
 * No Electron imports here: the rules are tested on their own (apps/desktop/test/policy.test.ts).
 */

/** The origin of an http(s) URL ("http://127.0.0.1:28787"); null for other schemes and invalid URLs. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The URL is a page of the app: same origin as one of `appOrigins`. */
export function isAppUrl(url: string | null | undefined, appOrigins: readonly string[]): boolean {
  const origin = originOf(url);
  return origin !== null && appOrigins.includes(origin);
}

/** URLs the operating system may open (default browser, mail app). */
export function isExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Where a navigation the page started in the window goes: stays, opens in the browser, or nowhere. */
export function navigationTarget(url: string, appOrigins: readonly string[]): 'app' | 'external' | 'blocked' {
  if (isAppUrl(url, appOrigins)) return 'app';
  return isExternalUrl(url) ? 'external' : 'blocked';
}

/** The frame that sent a bridge message: the main frame (no parent) showing a page of the app. */
export function isAppFrame(
  frame: { url: string; parent: unknown } | null | undefined,
  appOrigins: readonly string[],
): boolean {
  return !!frame && frame.parent === null && isAppUrl(frame.url, appOrigins);
}

/** Browser permissions the app's own pages use: copying the share image, fullscreen. */
const APP_PERMISSIONS: readonly string[] = ['clipboard-sanitized-write', 'fullscreen'];

/** A permission request or check from `requestingUrl` (a URL or an origin). */
export function allowsPermission(
  permission: string,
  requestingUrl: string | null | undefined,
  appOrigins: readonly string[],
): boolean {
  return APP_PERMISSIONS.includes(permission) && isAppUrl(requestingUrl, appOrigins);
}
