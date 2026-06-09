import type Redis from 'ioredis';

const lockKey = (weekId: string) => `lock:close:${weekId}`;

/** Try to become the single closer for a week. Returns true if the lock was acquired. */
export async function acquireCloseLock(redis: Redis, weekId: string, ttlSec = 300): Promise<boolean> {
  const res = await redis.set(lockKey(weekId), '1', 'EX', ttlSec, 'NX');
  return res === 'OK';
}

export async function releaseCloseLock(redis: Redis, weekId: string): Promise<void> {
  await redis.del(lockKey(weekId));
}
