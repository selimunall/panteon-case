import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { z } from 'zod';
import type { Config } from '@panteon/shared';
import type { Env } from '../env.js';
import { weekIdFor } from '../lib/week.js';
import { getPage, getPlayerRankView } from '../services/leaderboard.js';
import { getTop100 } from '../services/top100Cache.js';

export interface ReadDeps { redis: Redis; config: Config; env: Env; }

const meQuery = z.object({ playerId: z.string().uuid() });
const pageQuery = z.object({
  offset: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerLeaderboardRoutes(app: FastifyInstance, deps: ReadDeps): void {
  const week = () => weekIdFor(new Date(), deps.env.WEEK_RESET_OFFSET_HOURS);

  app.get('/leaderboard/top', async () => {
    const weekId = week();
    const entries = await getTop100(deps.redis, weekId, deps.config.cache.top100TtlMs, deps.config.cache.top100RefreshMs);
    return { weekId, entries };
  });

  app.get('/leaderboard/me', async (req, reply) => {
    const parsed = meQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const view = await getPlayerRankView(deps.redis, week(), parsed.data.playerId);
    if (!view) return reply.code(404).send({ error: 'not_ranked' });
    return view;
  });

  app.get('/leaderboard/page', async (req, reply) => {
    const parsed = pageQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    const weekId = week();
    const entries = await getPage(deps.redis, weekId, parsed.data.offset, parsed.data.limit, deps.config.scroll.cap);
    return { weekId, offset: parsed.data.offset, cap: deps.config.scroll.cap, entries };
  });
}
