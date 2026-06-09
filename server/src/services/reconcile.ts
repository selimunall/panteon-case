import { sql, eq } from 'drizzle-orm';
import type { Db as PgDb } from '../db/pg.js';
import type { Db as MongoDb } from 'mongodb';
import { players, weeklyScores, weeks } from '../db/schema.js';

const CHUNK = 5000;

/**
 * Recompute the week's verified totals from the deduped raw log (Mongo is the source of truth),
 * overwriting weekly_scores and weeks.total_earned. Returns the authoritative weekly total.
 */
export async function reconcileWeek(pg: PgDb, mongo: MongoDb, weekId: string): Promise<bigint> {
  const agg = await mongo.collection('earning_events').aggregate<{ _id: string; total: number }>(
    [{ $match: { weekId } }, { $group: { _id: '$playerId', total: { $sum: '$delta' } } }],
    { allowDiskUse: true },
  ).toArray();

  const total = agg.reduce((s, a) => s + BigInt(a.total), 0n);

  await pg.transaction(async (tx) => {
    for (let i = 0; i < agg.length; i += CHUNK) {
      const slice = agg.slice(i, i + CHUNK);
      await tx.insert(players)
        .values(slice.map((a) => ({ id: a._id, displayName: `player-${a._id.slice(0, 8)}` })))
        .onConflictDoNothing();
      await tx.insert(weeklyScores)
        .values(slice.map((a) => ({ weekId, playerId: a._id, totalEarned: BigInt(a.total) })))
        .onConflictDoUpdate({
          target: [weeklyScores.weekId, weeklyScores.playerId],
          set: { totalEarned: sql`EXCLUDED.total_earned`, updatedAt: sql`now()` },
        });
    }
    await tx.update(weeks).set({ totalEarned: total }).where(eq(weeks.weekId, weekId));
  });

  return total;
}
