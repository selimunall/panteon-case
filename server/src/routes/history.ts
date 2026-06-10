import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { z } from 'zod';
import type { Db as MongoDb } from 'mongodb';
import type { Db as PgDb } from '../db/pg.js';
import { listClosedWeeks, getSnapshot, getMyHistory } from '../services/history.js';

export interface HistoryDeps { redis: Redis; mongo: MongoDb; pg: PgDb; }

const meQuery = z.object({ playerId: z.string().uuid() });

export function registerHistoryRoutes(app: FastifyInstance, deps: HistoryDeps): void {
  app.get('/history/weeks', async () => ({ weeks: await listClosedWeeks(deps.pg) }));

  app.get<{ Params: { weekId: string } }>('/history/:weekId', async (req, reply) => {
    const snap = await getSnapshot(deps.mongo, deps.redis, req.params.weekId);
    if (!snap) return reply.code(404).send({ error: 'not_archived' });
    return snap;
  });

  app.get<{ Params: { weekId: string } }>('/history/:weekId/me', async (req, reply) => {
    const parsed = meQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return getMyHistory(deps.pg, req.params.weekId, parsed.data.playerId);
  });
}
