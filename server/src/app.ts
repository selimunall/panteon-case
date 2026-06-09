import Fastify, { type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { Config } from '@panteon/shared';
import type { Env } from './env.js';
import { registerEarnRoute } from './routes/earn.js';

export interface AppDeps { redis: Redis; config: Config; env: Env; }

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));
  registerEarnRoute(app, deps);
  return app;
}
