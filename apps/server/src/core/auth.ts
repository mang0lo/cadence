import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Optional single-password protection for server deployments (CADENCE_PASSWORD).
 * Desktop/dev mode has no password and binds to 127.0.0.1 only.
 *
 * Clients authenticate either with the `cadence_auth` cookie (set by POST /api/auth/login)
 * or with `Authorization: Bearer <password>` (scripts, the macOS shell pointing at a remote server).
 */
const COOKIE = 'cadence_auth';
const PUBLIC_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/logout']);

function token(password: string): string {
  return createHmac('sha256', password).update('cadence-session-v1').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
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

export function isAuthenticated(req: FastifyRequest, password: string | null): boolean {
  if (!password) return true;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && safeEqual(bearer, password)) return true;
  const cookie = readCookie(req, COOKIE);
  return !!cookie && safeEqual(cookie, token(password));
}

export function registerAuth(
  app: FastifyInstance,
  password: string | null,
  throttle: LoginThrottle = new LoginThrottle(),
): void {
  const tooMany = (reply: FastifyReply, waitS: number) =>
    reply
      .code(429)
      .header('retry-after', waitS)
      .send({ error: { code: 'too_many_attempts', message: `Too many wrong passwords. Try again in ${Math.ceil(waitS / 60)} min.` } });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!password) return;
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path)) return;
    if (!isAuthenticated(req, password)) {
      // a wrong Bearer password is a guess like a wrong login
      if (req.headers.authorization?.startsWith('Bearer ')) {
        const waitS = throttle.retryAfterS(req.ip);
        if (waitS > 0) return tooMany(reply, waitS);
        throttle.fail(req.ip);
      }
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Login required' } });
    }
  });

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    if (!password) return { ok: true };
    const waitS = throttle.retryAfterS(req.ip);
    if (waitS > 0) return tooMany(reply, waitS);
    if (!req.body?.password || !safeEqual(req.body.password, password)) {
      throttle.fail(req.ip);
      return reply.code(401).send({ error: { code: 'invalid_password', message: 'Wrong password' } });
    }
    throttle.succeed(req.ip);
    const secure = req.protocol === 'https' ? '; Secure' : '';
    reply.header(
      'set-cookie',
      `${COOKIE}=${token(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`,
    );
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });
}
