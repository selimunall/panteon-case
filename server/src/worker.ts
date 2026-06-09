import { randomUUID } from 'node:crypto';
import { loadEnv } from './env.js';
import { createPg } from './db/pg.js';
import { createRedis } from './db/redis.js';
import { createMongo } from './db/mongo.js';
import { weekIdFor } from './lib/week.js';
import { loadConfig } from './config.js';
import { ensureEventIndexes } from './services/mongoEvents.js';
import { ensureWeekRow } from './services/persistScores.js';
import { ensureGroup, processBatch, reclaimStale } from './services/streamConsumer.js';
import { startTop100Refresher } from './services/top100Cache.js';
import { startCloseScheduler } from './scheduler.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const consumer = `worker-${randomUUID().slice(0, 8)}`;
  const { pool, db: pg } = createPg(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const { client: mongoClient, db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);

  await ensureEventIndexes(mongo);
  const deps = { redis, mongo, pg };

  const config = loadConfig(env);
  const stopRefresher = startTop100Refresher(
    redis,
    () => weekIdFor(new Date(), env.WEEK_RESET_OFFSET_HOURS),
    { refreshMs: config.cache.top100RefreshMs, ttlMs: config.cache.top100TtlMs },
  );
  const stopScheduler = startCloseScheduler(deps, env.WEEK_RESET_OFFSET_HOURS, config);

  let running = true;
  const shutdown = async () => {
    running = false;
    stopRefresher();
    stopScheduler();
    await Promise.allSettled([redis.quit(), mongoClient.close(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`worker ${consumer} started`);
  let lastWeek = '';
  while (running) {
    const weekId = weekIdFor(new Date(), env.WEEK_RESET_OFFSET_HOURS);
    if (weekId !== lastWeek) {
      await ensureWeekRow(pg, weekId, env.WEEK_RESET_OFFSET_HOURS);
      await ensureGroup(redis, weekId);
      lastWeek = weekId;
    }
    await reclaimStale(deps, weekId, consumer);   // pick up crashed consumers' work
    await processBatch(deps, weekId, consumer);   // BLOCK-waits for new entries
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
