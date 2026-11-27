import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/db';
import { getSetting, setSetting } from './settings';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route answers without a login (status, login, logout). Every other route under /api needs one. */
    public?: boolean;
  }
  interface FastifyInstance {
    /** Logged-in browsers of a password-protected server (null without CADENCE_PASSWORD). */
    sessions: Sessions | null;
  }
}

/**
 * Optional single-password protection for server deployments (CADENCE_PASSWORD).
 * Desktop/dev mode has no password and binds to 127.0.0.1 only.
 *
 * Clients authenticate either with the `cadence_auth` cookie (set by POST /api/auth/login)
 * or with `Authorization: Bearer <password>` (scripts and other API clients; the apps use the cookie).
 */
const COOKIE = 'cadence_auth';

/** Compares digests: neither the content nor the length of a secret shows in the time it takes. */
function safeEqual(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== name) continue;
    try {
      return decodeURIComponent(v.join('='));
    } catch {
      return v.join('='); // malformed escapes: no session, not a server error
    }
  }
  return null;
}

const SESSIONS_KEY = 'core.sessions';
const SESSION_S = 30 * 24 * 3600;
const MAX_SESSIONS = 100;

/**
 * Login sessions: every login gets a random cookie, so logging out ends exactly that session and a stolen cookie
 * tells nothing about the password. Stored (settings 'core.sessions' of athlete 1, left out of backups) only as
 * HMAC(cookie, password) with an expiry: the database holds no usable cookie, and a new password ends every session.
 */
export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly password: string,
    private readonly now: () => number = Date.now,
  ) {}

  private key(token: string): string {
    return createHmac('sha256', token).update(this.password).digest('hex');
  }

  private live(): { key: string; exp: number }[] {
    const t = Math.floor(this.now() / 1000);
    const list = getSetting<unknown>(this.db, 1, SESSIONS_KEY, []);
    return (Array.isArray(list) ? (list as { key: string; exp: number }[]) : []).filter(
      (s) => typeof s?.key === 'string' && typeof s.exp === 'number' && s.exp > t,
    );
  }

  /** A new session; returns the cookie value. The oldest sessions make room beyond MAX_SESSIONS. */
  create(): string {
    const token = randomBytes(32).toString('base64url');
    const list = [...this.live(), { key: this.key(token), exp: Math.floor(this.now() / 1000) + SESSION_S }];
    setSetting(this.db, 1, SESSIONS_KEY, list.slice(-MAX_SESSIONS));
    return token;
  }

  valid(token: string): boolean {
    const key = this.key(token);
    return this.live().some((s) => safeEqual(s.key, key));
  }

  end(token: string): void {
    const key = this.key(token);
    const list = this.live();
    const rest = list.filter((s) => s.key !== key);
    if (rest.length !== list.length) setSetting(this.db, 1, SESSIONS_KEY, rest);
  }
}

/** Wrong passwords from one address before it has to wait, and how long. */
const MAX_FAILURES = 8;
const LOCK_MS = 5 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * Brakes password guessing: after MAX_FAILURES wrong passwords within the window an address is locked out of
 * logging in for LOCK_MS (sessions that are already logged in keep working). In memory: a restart clears it.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; first: number; lockedUntil: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds the address still has to wait, 0 when it may try. */
  retryAfterS(ip: string): number {
    const f = this.failures.get(ip);
    if (!f) return 0;
    const t = this.now();
    if (f.lockedUntil > t) return Math.ceil((f.lockedUntil - t) / 1000);
    if (t - f.first > FAILURE_WINDOW_MS) this.failures.delete(ip);
    return 0;
  }

  fail(ip: string): void {
    const t = this.now();
    let f = this.failures.get(ip);
    if (!f || t - f.first > FAILURE_WINDOW_MS) f = { count: 0, first: t, lockedUntil: 0 };
    f.count++;
    if (f.count >= MAX_FAILURES) {
      f.lockedUntil = t + LOCK_MS;
      f.count = 0;
      f.first = t;
    }
    this.failures.set(ip, f);
    // an attacker rotating addresses must not grow the map without bound
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value!);
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }
}

/**
 * Throttle key of a client address. IPv6 clients usually get a whole /64, so they count per /64; IPv4 clients on a
 * dual-stack socket (::ffff:1.2.3.4) count as their IPv4 address.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (net.isIP(ip.replace(/%.*$/, '')) !== 6) return ip;
  // the URL parser writes every IPv6 address in one canonical form (hex groups, the longest zero run as ::)
  const canonical = new URL(`http://[${ip.replace(/%.*$/, '')}]`).hostname.slice(1, -1);
  const [head, tail] = canonical.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

export function isAuthenticated(req: FastifyRequest, password: string | null): boolean {
  if (!password) return true;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && safeEqual(bearer, password)) return true;
  const cookie = readCookie(req, COOKIE);
  return !!cookie && !!req.server.sessions?.valid(cookie);
}

const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

/** Decoded path of a request target, also of an absolute-form one (`GET http://host/api/x HTTP/1.1`). */
function targetPath(url: string): string {
  let p = url.split('?', 1)[0]!;
  if (!p.startsWith('/')) p = p.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '');
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * Whether the request needs the password: decided on the route the router matched, never on the raw target. The
 * router percent-decodes (`/%61pi/backup`) and accepts absolute-form targets, so a string test of req.url misses them.
 * Every route under /api is protected unless it says `config: { public: true }`.
 */
function needsLogin(req: FastifyRequest): boolean {
  if (req.is404) return isApiPath(targetPath(req.url)); // unknown /api paths ask for a login before they are 404
  const route = req.routeOptions;
  return isApiPath(route.url ?? '') && route.config?.public !== true;
}

/** Host name of a Host header value, lower case, without port and brackets. */
function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  const v6 = /^\[([^\]]*)\](?::\d*)?$/.exec(h);
  const name = v6 ? v6[1]! : h.replace(/:\d*$/, '');
  return name.endsWith('.') ? name.slice(0, -1) : name;
}

/**
 * localhost, *.localhost and IP addresses are always allowed (a DNS-rebinding page has a name of its own), plus the
 * configured names ('.example.org' also allows every subdomain).
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  if (!host) return true; // HTTP/1.0 without Host: not a browser
  const name = hostName(host);
  if (name === 'localhost' || name.endsWith('.localhost') || net.isIP(name)) return true;
  return allowed.some((a) => (a.startsWith('.') ? name === a.slice(1) || name.endsWith(a) : name === a));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A browser request another site started: Sec-Fetch-Site when the browser sends it (same-origin, and 'none' for
 * what the user did in the browser itself, pass), else the Origin against the Host. Scripts and native callers send
 * neither header and pass (they need the password like everyone else).
 */
function crossSite(req: FastifyRequest): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    const o = new URL(origin);
    return o.host !== new URL(`${o.protocol}//${req.host}`).host;
  } catch {
    return true; // 'null' (sandboxed frames, file: pages) or garbage
  }
}

const forbidden = (reply: FastifyReply, code: string, message: string) =>
  reply.code(403).send({ error: { code, message } });

/**
 * The request trust policy, registered on the root instance before any route:
 *  1. Host: servers without a password on this machine (desktop app, dev) only answer to local host names, so a
 *     DNS-rebinding page cannot use the API under its own name (config.allowedHosts).
 *  2. Origin: state-changing requests must come from the server's own pages; other sites cannot post uploads,
 *     restores or edits, even with `mode: 'no-cors'`.
 *  3. Password (CADENCE_PASSWORD): every /api route needs a login unless it is declared public.
 * Behind a reverse proxy, CADENCE_TRUST_PROXY makes req.ip / req.protocol / req.host the client's (Fastify trustProxy).
 */
export function registerAuth(
  app: FastifyInstance,
  config: Pick<Config, 'password' | 'allowedHosts' | 'trustProxy'>,
  throttle: LoginThrottle = new LoginThrottle(),
): void {
  const { password, allowedHosts } = config;
  const sessions = password ? new Sessions(app.db, password) : null;
  app.decorate('sessions', sessions);
  const tooMany = (reply: FastifyReply, waitS: number) =>
    reply
      .code(429)
      .header('retry-after', waitS)
      .send({ error: { code: 'too_many_attempts', message: `Too many wrong passwords. Try again in ${Math.ceil(waitS / 60)} min.` } });
  // behind a proxy that is not trusted every client has the proxy's address: say once how to fix that
  let proxyHint = !!password && !config.trustProxy;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (proxyHint && req.headers['x-forwarded-for'] !== undefined) {
      proxyHint = false;
      req.log.warn(
        'Requests come through a reverse proxy (X-Forwarded-For), but CADENCE_TRUST_PROXY is not set: the login ' +
          "throttle counts every client as the proxy's address. Set CADENCE_TRUST_PROXY to the proxy's address.",
      );
    }
    // the Host the browser sent counts, and with CADENCE_TRUST_PROXY also the proxy's X-Forwarded-Host: a page that
    // reaches the server directly from this machine (a trusted loopback address) could name a local host in the latter
    const denied = allowedHosts && [req.headers.host ?? '', req.host].find((h) => !hostAllowed(h, allowedHosts));
    if (typeof denied === 'string') {
      return forbidden(
        reply,
        'forbidden_host',
        `This server does not answer to ${hostName(denied)}. Add it to CADENCE_ALLOWED_HOSTS to allow it.`,
      );
    }
    if (!SAFE_METHODS.has(req.method) && crossSite(req)) {
      return forbidden(reply, 'cross_site_request', 'Requests from other websites are not allowed');
    }
    if (!password || !needsLogin(req) || isAuthenticated(req, password)) return;
    // a wrong Bearer password is a guess like a wrong login
    if (req.headers.authorization?.startsWith('Bearer ')) {
      const key = clientKey(req.ip);
      const waitS = throttle.retryAfterS(key);
      if (waitS > 0) return tooMany(reply, waitS);
      throttle.fail(key);
    }
    return reply.code(401).send({ error: { code: 'unauthorized', message: 'Login required' } });
  });

  app.post<{ Body: { password?: string } }>('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    if (!password) return { ok: true };
    const key = clientKey(req.ip);
    const waitS = throttle.retryAfterS(key);
    if (waitS > 0) return tooMany(reply, waitS);
    if (!req.body?.password || !safeEqual(req.body.password, password)) {
      throttle.fail(key);
      return reply.code(401).send({ error: { code: 'invalid_password', message: 'Wrong password' } });
    }
    throttle.succeed(key);
    // https: the socket, with CADENCE_TRUST_PROXY the proxy's X-Forwarded-Proto, or the page itself (the browser's
    // Origin, also behind a TLS proxy that is not configured as trusted)
    const https = req.protocol === 'https' || /^https:\/\//i.test(req.headers.origin ?? '');
    const secure = https ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `${COOKIE}=${sessions!.create()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_S}${secure}`,
    );
    return { ok: true };
  });

  app.post('/api/auth/logout', { config: { public: true } }, async (req, reply) => {
    const cookie = readCookie(req, COOKIE);
    if (cookie) sessions?.end(cookie);
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });
}
