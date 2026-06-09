import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createRedis } from './db/redis.js';
import { registerEarnCommand } from './services/earn.js';

const env = loadEnv();
const config = loadConfig(env);
const redis = createRedis(env.REDIS_URL);
registerEarnCommand(redis);

const app = buildApp({ redis, config, env });

app.listen({ port: env.PORT, host: '0.0.0.0' })
  .then((addr) => console.log(`server listening on ${addr}`))
  .catch((err) => { console.error(err); process.exit(1); });
