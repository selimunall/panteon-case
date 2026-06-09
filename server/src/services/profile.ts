import type Redis from 'ioredis';
import type { LeaderboardEntry } from '@panteon/shared';
import { profileKey } from '../lib/keys.js';

/** Store display names (idempotent overwrite). */
export async function setProfiles(redis: Redis, profiles: { id: string; displayName: string }[]): Promise<void> {
  if (profiles.length === 0) return;
  const pipe = redis.pipeline();
  for (const p of profiles) pipe.set(profileKey(p.id), p.displayName);
  await pipe.exec();
}

/** Attach displayName to entries via one MGET (keeps reads Redis-only). */
export async function attachNames(redis: Redis, entries: LeaderboardEntry[]): Promise<LeaderboardEntry[]> {
  if (entries.length === 0) return entries;
  const names = await redis.mget(entries.map((e) => profileKey(e.playerId)));
  return entries.map((e, i) => ({ ...e, displayName: names[i] ?? undefined }));
}
