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

export function isAuthenticated(req: FastifyRequest, password: string | null): boolean {
  if (!password) return true;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && safeEqual(bearer, password)) return true;
  const cookie = readCookie(req, COOKIE);
  return !!cookie && safeEqual(cookie, token(password));
}

export function registerAuth(app: FastifyInstance, password: string | null): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!password) return;
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path)) return;
    if (!isAuthenticated(req, password)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'Login required' } });
    }
  });

  app.post<{ Body: { password?: string } }>('/api/auth/login', async (req, reply) => {
    if (!password) return { ok: true };
    if (!req.body?.password || !safeEqual(req.body.password, password)) {
      return reply.code(401).send({ error: { code: 'invalid_password', message: 'Wrong password' } });
    }
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
