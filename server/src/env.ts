import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MONGO_URL: z.string().url(),
  MONGO_DB: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  WEEK_RESET_OFFSET_HOURS: z.coerce.number().default(0),
  MAX_DELTA_PER_INTERVAL: z.coerce.number().int().default(1_000_000),
  IDEMP_TTL_SEC: z.coerce.number().int().default(604800), // 7 days
  RATE_LIMIT_MAX: z.coerce.number().int().default(10),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().default(10),
  CORS_ORIGIN: z.string().default('*'),
  DEMO_TRAFFIC: z.string().default('false'), // 'true' → generate light in-process earn traffic
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
