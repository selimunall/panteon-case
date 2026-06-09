/** Single source of truth for every Redis key string (data-model spec §2). */
export const leaderboardKey = (weekId: string): string => `leaderboard:week:${weekId}`;
export const poolKey = (weekId: string): string => `pool:week:${weekId}`;
export const streamKey = (weekId: string): string => `stream:earnings:week:${weekId}`;
export const idempRedisKey = (idempKey: string): string => `idemp:${idempKey}`;
export const rateLimitKey = (playerId: string): string => `rl:${playerId}`;
export const top100CacheKey = (weekId: string): string => `cache:leaderboard:week:${weekId}:top100`;
