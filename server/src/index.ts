import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createRedis } from './db/redis.js';
import { createPg } from './db/pg.js';
import { createMongo } from './db/mongo.js';
import { registerEarnCommand } from './services/earn.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadConfig(env);
  const redis = createRedis(env.REDIS_URL);
  registerEarnCommand(redis);
  const { db: pg } = createPg(env.DATABASE_URL);
  const { db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);

  const app = buildApp({ redis, config, env, mongo, pg });
  const addr = await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`server listening on ${addr}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
