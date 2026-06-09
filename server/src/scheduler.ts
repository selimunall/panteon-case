import { and, eq, lte } from 'drizzle-orm';
import type { Config } from '@panteon/shared';
import { weeks } from './db/schema.js';
import { acquireCloseLock, releaseCloseLock } from './lib/leaderLock.js';
import { closeWeek, type CloseDeps } from './services/closeWeek.js';

/** Periodically close any ended-but-active week, one at a time, under the leader lock. */
export function startCloseScheduler(deps: CloseDeps, offsetHours: number, config: Config, intervalMs = 60_000): () => void {
  let stopped = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  void (async () => {
    while (!stopped) {
      try {
        // Oldest-first so rollover chains correctly when several weeks are pending.
        const due = await deps.pg.select({ weekId: weeks.weekId })
          .from(weeks).where(and(eq(weeks.status, 'active'), lte(weeks.endsAt, new Date())))
          .orderBy(weeks.endsAt);
        for (const { weekId } of due) {
          if (await acquireCloseLock(deps.redis, weekId)) {
            try { await closeWeek(deps, weekId, offsetHours, config); }
            finally { await releaseCloseLock(deps.redis, weekId); }
          }
        }
      } catch (err) { console.error('close scheduler error', err); }
      await sleep(intervalMs);
    }
  })();
  return () => { stopped = true; };
}
