import type Redis from 'ioredis';
import { leaderboardKey, poolKey, streamKey, idempRedisKey } from '../lib/keys.js';

/**
 * Atomic hot path (architecture §3.2). One round-trip:
 *   KEYS[1]=idemp key  KEYS[2]=zset  KEYS[3]=pool  KEYS[4]=stream
 *   ARGV[1]=playerId ARGV[2]=delta ARGV[3]=poolRate ARGV[4]=idempTtlSec
 *   ARGV[5]=clientTs ARGV[6]=idempKeyRaw
 * Returns 1 if applied, 0 if this batch was already processed (duplicate).
 */
const EARN_LUA = `
local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', tonumber(ARGV[4]))
if not fresh then
  return 0
end
local delta = tonumber(ARGV[2])
redis.call('ZINCRBY', KEYS[2], delta, ARGV[1])
redis.call('INCRBYFLOAT', KEYS[3], delta * tonumber(ARGV[3]))
redis.call('XADD', KEYS[4], '*',
  'playerId', ARGV[1], 'delta', ARGV[2], 'idempKey', ARGV[6], 'clientTs', ARGV[5])
return 1
`;

/** ioredis command added by defineCommand — declared so callers stay typed. */
type EarnRedis = Redis & {
  earnApply(
    idempKey: string, zset: string, pool: string, stream: string,
    playerId: string, delta: string, poolRate: string, idempTtlSec: string,
    clientTs: string, idempKeyRaw: string,
  ): Promise<number>;
};

export function registerEarnCommand(redis: Redis): void {
  redis.defineCommand('earnApply', { numberOfKeys: 4, lua: EARN_LUA });
}

export interface EarnInput {
  weekId: string;
  playerId: string;
  delta: number;
  idempotencyKey: string;
  clientTs: number;
  poolRate: number;
  idempTtlSec: number;
}

/** Runs the atomic script. Returns true if applied, false if duplicate. */
export async function applyEarn(redis: Redis, input: EarnInput): Promise<boolean> {
  const r = redis as EarnRedis;
  const applied = await r.earnApply(
    idempRedisKey(input.idempotencyKey),
    leaderboardKey(input.weekId),
    poolKey(input.weekId),
    streamKey(input.weekId),
    input.playerId,
    String(input.delta),
    String(input.poolRate),
    String(input.idempTtlSec),
    String(input.clientTs),
    input.idempotencyKey,
  );
  return applied === 1;
}
