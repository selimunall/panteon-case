import type Redis from 'ioredis';
import type { Env } from '../env.js';
import { rateLimitKey } from './keys.js';

/** Fixed-window per-player counter. Returns true if the request is within budget. */
export async function checkRateLimit(redis: Redis, playerId: string, env: Env): Promise<boolean> {
  const key = rateLimitKey(playerId);
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.expire(key, env.RATE_LIMIT_WINDOW_SEC);
  }
  return n <= env.RATE_LIMIT_MAX;
}
