import { Config } from '@panteon/shared';
import type { Env } from './env.js';

/** Builds the validated runtime Config from env (fills the required clamp + offset). */
export function loadConfig(env: Env): Config {
  return Config.parse({
    week: { resetOffsetHours: env.WEEK_RESET_OFFSET_HOURS },
    batch: { maxDeltaPerInterval: env.MAX_DELTA_PER_INTERVAL },
  });
}
