import { randomUUID } from 'node:crypto';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createPg } from './db/pg.js';
import { createRedis } from './db/redis.js';
import { createMongo } from './db/mongo.js';
import { players } from './db/schema.js';
import { weekIdFor } from './lib/week.js';
import { ensureEventIndexes } from './services/mongoEvents.js';
import { ensureWeekRow } from './services/persistScores.js';
import { closeWeek } from './services/closeWeek.js';
import { acquireCloseLock, releaseCloseLock } from './lib/leaderLock.js';

/**
 * Dev tool: fabricate a *closed* past week reusing the current players, so the history view
 * has champions and so the player you're "being" has a past standing too.
 * Usage: pnpm seed:history [weekId]   (defaults to last week)
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig(env);
  const offset = env.WEEK_RESET_OFFSET_HOURS;
  const weekId = process.argv[2] ?? weekIdFor(new Date(Date.now() - 7 * 86400000), offset);

  const { pool, db: pg } = createPg(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const { client: mongoClient, db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);

  const ids = (await pg.select({ id: players.id }).from(players)).map((r) => r.id);
  if (ids.length === 0) { console.error('seed the current week first'); process.exit(1); }

  await ensureWeekRow(pg, weekId, offset);
  await ensureEventIndexes(mongo);
  await mongo.collection('earning_events').deleteMany({ weekId });

  const now = new Date();
  const docs = ids.map((id, i) => ({
    weekId,
    playerId: id,
    delta: 100000 + Math.floor(Math.random() * 900000),
    idempKey: randomUUID(),
    clientTs: now,
    ingestedAt: now,
    streamId: `hist-${i}`,
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

  await redis.quit();
  await mongoClient.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
