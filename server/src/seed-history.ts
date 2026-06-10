import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Db as MongoDb } from 'mongodb';
import type { Config } from '@panteon/shared';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createPg, type Db as PgDb } from './db/pg.js';
import { createRedis } from './db/redis.js';
import { createMongo } from './db/mongo.js';
import { players, weeks } from './db/schema.js';
import { weekIdFor } from './lib/week.js';
import { ensureEventIndexes } from './services/mongoEvents.js';
import { ensureWeekRow } from './services/persistScores.js';
import { closeWeek } from './services/closeWeek.js';
import { acquireCloseLock, releaseCloseLock } from './lib/leaderLock.js';

export interface SeedHistoryDeps { redis: Redis; mongo: MongoDb; pg: PgDb; }

/**
 * Fabricate a *closed* past week reusing the current players, so the history view has champions
 * and the player you're "being" has a past standing too. Idempotent: skips if already closed.
 */
export async function seedClosedWeek(deps: SeedHistoryDeps, weekId: string, offset: number, config: Config): Promise<void> {
  const { redis, mongo, pg } = deps;
  const wk = (await pg.select().from(weeks).where(eq(weeks.weekId, weekId)))[0];
  if (wk?.status === 'closed') { console.log(`history week ${weekId} already closed — skipping`); return; }

  const ids = (await pg.select({ id: players.id }).from(players)).map((r) => r.id);
  if (ids.length === 0) { console.log('no players yet — skipping history seed'); return; }

  await ensureWeekRow(pg, weekId, offset);
  await ensureEventIndexes(mongo);
  await mongo.collection('earning_events').deleteMany({ weekId });

  const now = new Date();
  const docs = ids.map((id, i) => ({
    weekId, playerId: id,
    delta: 100000 + Math.floor(Math.random() * 900000),
    idempKey: randomUUID(), clientTs: now, ingestedAt: now, streamId: `hist-${i}`,
  }));
  for (let i = 0; i < docs.length; i += 2000) {
    await mongo.collection('earning_events').insertMany(docs.slice(i, i + 2000), { ordered: false });
  }

  console.log(`seeded ${docs.length} events for ${weekId}, closing…`);
  const locked = await acquireCloseLock(redis, weekId);
  try {
    const res = await closeWeek({ redis, mongo, pg }, weekId, offset, config);
    console.log('closed:', res && { weekId: res.weekId, pool: res.pool.toString(), paid: res.paid });
  } finally {
    if (locked) await releaseCloseLock(redis, weekId);
  }
}

// CLI: pnpm seed:history [weekId]  (defaults to last week)
async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig(env);
  const offset = env.WEEK_RESET_OFFSET_HOURS;
  const weekId = process.argv[2] ?? weekIdFor(new Date(Date.now() - 7 * 86400000), offset);

  const { pool, db: pg } = createPg(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const { client: mongoClient, db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);
  try {
    await seedClosedWeek({ redis, mongo, pg }, weekId, offset, config);
  } finally {
    await redis.quit();
    await mongoClient.close();
    await pool.end();
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
