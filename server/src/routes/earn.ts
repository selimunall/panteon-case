import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { EarnPayload, type Config } from '@panteon/shared';
import type { Env } from '../env.js';
import { weekIdFor } from '../lib/week.js';
import { applyEarn } from '../services/earn.js';
import { checkRateLimit } from '../lib/rateLimit.js';

export interface EarnDeps { redis: Redis; config: Config; env: Env; }

export function registerEarnRoute(app: FastifyInstance, deps: EarnDeps): void {
  app.post('/earn', async (req, reply) => {
    const parsed = EarnPayload.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // Week-boundary clamp: only the current week accepts earns (architecture §5.1).
    const currentWeek = weekIdFor(new Date(), deps.env.WEEK_RESET_OFFSET_HOURS);
    if (body.weekId !== currentWeek) {
      return reply.code(409).send({ error: 'stale_week', currentWeek });
    }

    // Anti-cheat clamp: no batch may exceed the per-interval maximum.
    if (body.delta > deps.config.batch.maxDeltaPerInterval) {
      return reply.code(400).send({ error: 'delta_too_large', max: deps.config.batch.maxDeltaPerInterval });
    }

    // Per-player rate limit.
    const allowed = await checkRateLimit(deps.redis, body.playerId, deps.env);
    if (!allowed) {
      return reply.code(429).send({ error: 'rate_limited' });
    }

    const applied = await applyEarn(deps.redis, {
      weekId: currentWeek,
      playerId: body.playerId,
      delta: body.delta,
      idempotencyKey: body.idempKey,
      clientTs: body.clientTs,
      poolRate: deps.config.pool.rate,
      idempTtlSec: deps.env.IDEMP_TTL_SEC,
    });

    return reply.code(200).send({ applied, weekId: currentWeek });
  });
}
