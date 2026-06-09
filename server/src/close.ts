import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createPg } from './db/pg.js';
import { createRedis } from './db/redis.js';
import { createMongo } from './db/mongo.js';
import { closeWeek } from './services/closeWeek.js';

async function main(): Promise<void> {
  const weekId = process.argv[2];
  if (!weekId) { console.error('usage: tsx src/close.ts <weekId>'); process.exit(1); }

  const env = loadEnv();
  const config = loadConfig(env);
  const { pool, db: pg } = createPg(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const { client, db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);

  try {
    const result = await closeWeek({ redis, mongo, pg }, weekId, env.WEEK_RESET_OFFSET_HOURS, config);
    console.log('close result:', result && {
      weekId: result.weekId, pool: result.pool.toString(),
      rolloverOut: result.rolloverOut.toString(), paid: result.paid, nextWeekId: result.nextWeekId,
    });
  } finally {
    await client.close();
    await redis.quit();
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
