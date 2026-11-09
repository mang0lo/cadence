/** Pure (no DOM): also used by the server's tests. */
/**
 * "homeserver.local:8787" → "http://homeserver.local:8787": the address of a Cadence server as the apps use it
 * (http or https with a host, no trailing slash); null when it is not one.
 */
export function normalizeServerUrl(text: string): string | null {
  const s = text.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}
