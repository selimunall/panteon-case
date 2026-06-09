import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MONGO_URL: z.string().url(),
  MONGO_DB: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  WEEK_RESET_OFFSET_HOURS: z.coerce.number().default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
