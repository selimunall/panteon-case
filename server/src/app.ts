import Fastify, { type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { Db as MongoDb } from 'mongodb';
import type { Config } from '@panteon/shared';
import type { Env } from './env.js';
import type { Db as PgDb } from './db/pg.js';
import { registerEarnRoute } from './routes/earn.js';
import { registerLeaderboardRoutes } from './routes/leaderboard.js';
import { registerHistoryRoutes } from './routes/history.js';

export interface AppDeps { redis: Redis; config: Config; env: Env; mongo: MongoDb; pg: PgDb; }

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));
  registerEarnRoute(app, deps);
  registerLeaderboardRoutes(app, deps);
  registerHistoryRoutes(app, { redis: deps.redis, mongo: deps.mongo, pg: deps.pg });
  return app;
}
