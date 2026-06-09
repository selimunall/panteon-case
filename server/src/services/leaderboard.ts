import type Redis from 'ioredis';
import type { LeaderboardEntry, PlayerRankView } from '@panteon/shared';
import { leaderboardKey } from '../lib/keys.js';

/** Turn a ZREVRANGE WITHSCORES slice (starting at 0-based rank `start`) into ranked entries. */
async function rangeToEntries(redis: Redis, weekId: string, start: number, stop: number): Promise<LeaderboardEntry[]> {
  if (stop < start) return [];
  const flat = await redis.zrevrange(leaderboardKey(weekId), start, stop, 'WITHSCORES');
  const out: LeaderboardEntry[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    out.push({ rank: start + i / 2 + 1, playerId: flat[i]!, totalEarned: Number(flat[i + 1]!) });
  }
  return out;
}

/** Top 100 (rank 1..100). */
export function computeTop100(redis: Redis, weekId: string): Promise<LeaderboardEntry[]> {
  return rangeToEntries(redis, weekId, 0, 99);
}

/** A page of the ranking, clamped to [0, cap). */
export function getPage(redis: Redis, weekId: string, offset: number, limit: number, cap = 1000): Promise<LeaderboardEntry[]> {
  const start = Math.max(0, offset);
  if (start >= cap) return Promise.resolve([]);
  const stop = Math.min(start + limit - 1, cap - 1);
  return rangeToEntries(redis, weekId, start, stop);
}

/** A player's own rank plus 3 above / 2 below (the window is only filled outside the top 100). */
export async function getPlayerRankView(redis: Redis, weekId: string, playerId: string): Promise<PlayerRankView | null> {
  const key = leaderboardKey(weekId);
  const rank0 = await redis.zrevrank(key, playerId);
  if (rank0 === null) return null; // not on the board this week
  const score = await redis.zscore(key, playerId);
  const rank = rank0 + 1;
  const inTop100 = rank <= 100;
  const player: LeaderboardEntry = { rank, playerId, totalEarned: Number(score) };

  let neighbours: LeaderboardEntry[] = [];
  if (!inTop100) {
    const window = await rangeToEntries(redis, weekId, Math.max(0, rank0 - 3), rank0 + 2);
    neighbours = window.filter((e) => e.playerId !== playerId);
  }
  return { weekId, inTop100, player, neighbours };
}
