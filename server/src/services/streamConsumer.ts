import type Redis from 'ioredis';
import type { Db as MongoDb } from 'mongodb';
import type { Db as PgDb } from '../db/pg.js';
import { streamKey } from '../lib/keys.js';
import { insertRawEvents, type StreamEvent } from './mongoEvents.js';
import { persistScores } from './persistScores.js';

export const GROUP = 'cg:persist';

interface Deps { redis: Redis; mongo: MongoDb; pg: PgDb; }

/** Create the consumer group at 0 (process all history) if it does not exist yet. */
export async function ensureGroup(redis: Redis, weekId: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', streamKey(weekId), GROUP, '0', 'MKSTREAM');
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('BUSYGROUP')) throw err;
  }
}

/** Flatten ioredis' [id, [f, v, f, v, ...]] entries into StreamEvents. */
function parseEntries(entries: Array<[string, string[]]>): StreamEvent[] {
  return entries.map(([id, fields]) => {
    const f: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
    return {
      streamId: id,
      playerId: f.playerId!,
      delta: Number(f.delta),
      idempKey: f.idempKey!,
      clientTs: Number(f.clientTs),
    };
  });
}

async function handleBatch(deps: Deps, weekId: string, entries: Array<[string, string[]]>): Promise<number> {
  if (entries.length === 0) return 0;
  const events = parseEntries(entries);
  const freshKeys = await insertRawEvents(deps.mongo, weekId, events); // Mongo first (gate)
  const freshEvents = events.filter((e) => freshKeys.has(e.idempKey));
  await persistScores(deps.pg, weekId, freshEvents);                   // Postgres for new only

  // Best-effort stub display name for unseen players (NX never overwrites a real name).
  if (freshEvents.length > 0) {
    const pipe = deps.redis.pipeline();
    for (const e of freshEvents) pipe.set(`profile:${e.playerId}`, `player-${e.playerId.slice(0, 8)}`, 'NX');
    await pipe.exec();
  }

  await deps.redis.xack(streamKey(weekId), GROUP, ...entries.map(([id]) => id));
  return entries.length;
}

/** Reclaim entries pending on dead consumers (idle > 30s) and process them. */
export async function reclaimStale(deps: Deps, weekId: string, consumer: string): Promise<number> {
  const res = (await deps.redis.xautoclaim(
    streamKey(weekId), GROUP, consumer, 30_000, '0', 'COUNT', 200,
  )) as [string, Array<[string, string[]]>, string[]];
  const entries = res?.[1] ?? [];
  return handleBatch(deps, weekId, entries);
}

/** Read and process one batch of new entries. Returns the number processed. */
export async function processBatch(deps: Deps, weekId: string, consumer: string, blockMs = 2000): Promise<number> {
  const res = (await deps.redis.xreadgroup(
    'GROUP', GROUP, consumer, 'COUNT', 500, 'BLOCK', blockMs, 'STREAMS', streamKey(weekId), '>',
  )) as Array<[string, Array<[string, string[]]>]> | null;
  const entries = res?.[0]?.[1] ?? [];
  return handleBatch(deps, weekId, entries);
}

/** Drain a week's stream until both new and pending are empty (used by the close job, Plan 5). */
export async function drainStream(deps: Deps, weekId: string, consumer: string): Promise<void> {
  await ensureGroup(deps.redis, weekId);
  while ((await reclaimStale(deps, weekId, consumer)) > 0) { /* keep claiming */ }
  while ((await processBatch(deps, weekId, consumer, 100)) > 0) { /* keep reading */ }
}
