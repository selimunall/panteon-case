import { randomUUID } from 'node:crypto';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createRedis } from './db/redis.js';
import { createPg } from './db/pg.js';
import { createMongo } from './db/mongo.js';
import { registerEarnCommand, applyEarn } from './services/earn.js';
import { players } from './db/schema.js';
import { runMigrations } from './db/migrate.js';
import { runSeed } from './db/seed.js';
import { seedClosedWeek } from './seed-history.js';
import { ensureEventIndexes } from './services/mongoEvents.js';
import { ensureWeekRow } from './services/persistScores.js';
import { ensureGroup, processBatch, reclaimStale } from './services/streamConsumer.js';
import { startTop100Refresher } from './services/top100Cache.js';
import { startCloseScheduler } from './scheduler.js';
import { weekIdFor } from './lib/week.js';

/**
 * Single-process entrypoint for cost-constrained PaaS (e.g. Render free tier): runs the API
 * AND the background loops (refresher, scheduler, consumer) together, and self-initializes the
 * schema + sample data on boot. All bootstrap steps are idempotent. In production these are
 * separate, independently scalable services (see docker-compose.full.yml / render.yaml).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig(env);
  const offset = env.WEEK_RESET_OFFSET_HOURS;

  // self-initialize (idempotent): schema + current-week sample data + a closed past week
  await runMigrations(env.DATABASE_URL);
  await runSeed({ pgUrl: env.DATABASE_URL, redisUrl: env.REDIS_URL, mongoUrl: env.MONGO_URL, mongoDb: env.MONGO_DB, offsetHours: offset });

  const redis = createRedis(env.REDIS_URL);
  registerEarnCommand(redis);
  const { db: pg } = createPg(env.DATABASE_URL);
  const { db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);
  const deps = { redis, mongo, pg };

  await seedClosedWeek(deps, weekIdFor(new Date(Date.now() - 7 * 86400000), offset), offset, config);
  await ensureEventIndexes(mongo);

  // API
  const app = buildApp({ redis, config, env, mongo, pg });
  const addr = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`server (combined api+worker) listening on ${addr}`);

  // background loops, in-process
  startTop100Refresher(redis, () => weekIdFor(new Date(), offset), { refreshMs: config.cache.top100RefreshMs, ttlMs: config.cache.top100TtlMs });
  startCloseScheduler(deps, offset, config);

  const consumer = `inproc-${randomUUID().slice(0, 8)}`;
  let lastWeek = '';
  void (async () => {
    for (;;) {
      const weekId = weekIdFor(new Date(), offset);
      if (weekId !== lastWeek) {
        await ensureWeekRow(pg, weekId, offset);
        await ensureGroup(redis, weekId);
        lastWeek = weekId;
      }
      await reclaimStale(deps, weekId, consumer);
      await processBatch(deps, weekId, consumer);
    }
  })();

  // Optional in-process demo traffic so the deployed board visibly moves (no separate worker).
  if (env.DEMO_TRAFFIC === 'true') {
    const ids = (await pg.select({ id: players.id }).from(players)).map((r) => r.id);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    console.log(`demo traffic on: ${ids.length} players`);
    void (async () => {
      while (ids.length > 0) {
        const weekId = weekIdFor(new Date(), offset);
        for (let i = 0; i < 4; i++) {
          const playerId = ids[Math.floor(Math.random() * ids.length)]!;
          const delta = Math.random() < 0.1 ? 20000 + Math.floor(Math.random() * 60000) : 500 + Math.floor(Math.random() * 6000);
          await applyEarn(redis, {
            weekId, playerId, delta, idempotencyKey: randomUUID(),
            clientTs: Date.now(), poolRate: config.pool.rate, idempTtlSec: env.IDEMP_TTL_SEC,
          }).catch(() => {});
        }
        await sleep(1500);
      }
    })();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
