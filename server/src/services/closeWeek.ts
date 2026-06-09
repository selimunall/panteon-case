import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Db as MongoDb } from 'mongodb';
import type { Config } from '@panteon/shared';
import type { Db as PgDb } from '../db/pg.js';
import { weeks, weeklyScores, rewardPayouts } from '../db/schema.js';
import { leaderboardKey, poolKey, streamKey } from '../lib/keys.js';
import { weekIdFor, weekWindow } from '../lib/week.js';
import { drainStream } from './streamConsumer.js';
import { reconcileWeek } from './reconcile.js';
import { computeDistribution } from './distribution.js';
import { ensureWeekRow } from './persistScores.js';

export interface CloseDeps { redis: Redis; mongo: MongoDb; pg: PgDb; }
export interface CloseResult { weekId: string; pool: bigint; rolloverOut: bigint; paid: number; nextWeekId: string; }

export async function closeWeek(deps: CloseDeps, weekId: string, offsetHours: number, config: Config): Promise<CloseResult | null> {
  const { redis, mongo, pg } = deps;

  const wk = (await pg.select().from(weeks).where(eq(weeks.weekId, weekId)))[0];
  if (!wk || wk.status === 'closed') return null; // idempotent skip

  // 1. Barrier — every earn for the week is now in Mongo + Postgres.
  await drainStream(deps, weekId, `closer-${randomUUID().slice(0, 8)}`);

  // 2. Reconcile the verified totals from the raw log, then compute the integer pool.
  const total = await reconcileWeek(pg, mongo, weekId);
  const rateBps = BigInt(Math.round(config.pool.rate * 10000));
  const pool = (total * rateBps) / 10000n + wk.rolloverIn;

  // 3. Derive the ranking from Postgres (authoritative for money).
  const top100 = await pg.select({ playerId: weeklyScores.playerId })
    .from(weeklyScores).where(eq(weeklyScores.weekId, weekId))
    .orderBy(desc(weeklyScores.totalEarned)).limit(100);
  const { payouts, rolloverOut } = computeDistribution(top100.map((r) => r.playerId), pool, config.pool);

  // 4. Archive a snapshot (top 1000 + payouts), idempotent by weekId.
  const top1000 = await pg.select({ playerId: weeklyScores.playerId, totalEarned: weeklyScores.totalEarned })
    .from(weeklyScores).where(eq(weeklyScores.weekId, weekId))
    .orderBy(desc(weeklyScores.totalEarned)).limit(1000);
  await mongo.collection('leaderboard_snapshots').replaceOne(
    { weekId },
    {
      weekId,
      closedAt: new Date(),
      poolTotal: Number(pool),
      totalEarned: Number(total),
      rolloverIn: Number(wk.rolloverIn),
      rolloverOut: Number(rolloverOut),
      entries: top1000.map((r, i) => ({ rank: i + 1, playerId: r.playerId, totalEarned: Number(r.totalEarned) })),
      payouts: payouts.map((p) => ({ rank: p.rank, playerId: p.playerId, amount: Number(p.amount) })),
    },
    { upsert: true },
  );

  // 5. Open the next week (so rollover has a home).
  const nextWeekId = weekIdFor(weekWindow(weekId, offsetHours).endsAt, offsetHours);
  await ensureWeekRow(pg, nextWeekId, offsetHours);

  // 6. Commit money atomically: payouts + close this week + carry rollover to the next.
  await pg.transaction(async (tx) => {
    if (payouts.length > 0) {
      await tx.insert(rewardPayouts)
        .values(payouts.map((p) => ({ weekId, playerId: p.playerId, rank: p.rank, amount: p.amount })))
        .onConflictDoNothing();
    }
    await tx.update(weeks)
      .set({ status: 'closed', poolTotal: pool, rolloverOut, closedAt: sql`now()` })
      .where(eq(weeks.weekId, weekId));
    await tx.update(weeks).set({ rolloverIn: rolloverOut }).where(eq(weeks.weekId, nextWeekId));
  });

  // 7. Clean up the week's hot keys (best-effort).
  await redis.del(leaderboardKey(weekId), poolKey(weekId), streamKey(weekId));

  return { weekId, pool, rolloverOut, paid: payouts.length, nextWeekId };
}
