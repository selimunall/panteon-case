import type Redis from 'ioredis';
import type { LeaderboardEntry } from '@panteon/shared';
import { top100CacheKey } from '../lib/keys.js';
import { computeTop100 } from './leaderboard.js';

/** Recompute and store the serialized top-100 with a short TTL. */
export async function cacheTop100(redis: Redis, weekId: string, ttlMs: number): Promise<LeaderboardEntry[]> {
  const entries = await computeTop100(redis, weekId);
  await redis.set(top100CacheKey(weekId), JSON.stringify(entries), 'PX', ttlMs);
  return entries;
}

/** Read the cached top-100; on miss, compute live and warm the cache (fallback). */
async function getRedisTop100(redis: Redis, weekId: string, ttlMs: number): Promise<LeaderboardEntry[]> {
  const cached = await redis.get(top100CacheKey(weekId));
  if (cached) return JSON.parse(cached) as LeaderboardEntry[];
  return cacheTop100(redis, weekId, ttlMs);
}

// Per-instance in-process cache: derived public data, so it does not break statelessness.
let memo: { weekId: string; at: number; data: LeaderboardEntry[] } | null = null;

/** Serve the top 100 with an in-process cache in front of the Redis cache. */
export async function getTop100(redis: Redis, weekId: string, redisTtlMs: number, ipcMs: number): Promise<LeaderboardEntry[]> {
  const now = Date.now();
  if (memo && memo.weekId === weekId && now - memo.at < ipcMs) return memo.data;
  const data = await getRedisTop100(redis, weekId, redisTtlMs);
  memo = { weekId, at: now, data };
  return data;
}

/** Background loop that keeps the Redis cache warm so 2M concurrent reads never stampede. */
export function startTop100Refresher(
  redis: Redis,
  getWeekId: () => string,
  opts: { refreshMs: number; ttlMs: number },
): () => void {
  let stopped = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    while (!stopped) {
      try { await cacheTop100(redis, getWeekId(), opts.ttlMs); }
      catch (err) { console.error('top100 refresher error', err); }
      await sleep(opts.refreshMs);
    }
  })();
  return () => { stopped = true; };
}
