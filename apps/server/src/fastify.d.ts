import 'fastify';
import type { Config } from './config';
import type { Db } from './db/db';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    /** Main-thread connection. Never hold it across awaits inside a transaction. */
    db: Db;
  }
  interface FastifyRequest {
    /** Resolved athlete for this request (always 1 until multi-user auth exists). */
    athleteId: number;
  }
}
