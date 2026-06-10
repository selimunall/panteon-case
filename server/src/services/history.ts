import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Db as MongoDb } from 'mongodb';
import type { Db as PgDb } from '../db/pg.js';
import { weeks, weeklyScores, rewardPayouts } from '../db/schema.js';
import { attachNames } from './profile.js';

export interface ArchiveWeek { weekId: string; poolTotal: number; totalEarned: number; closedAt: string | null; }
export interface Champion { rank: number; playerId: string; displayName?: string; totalEarned: number; reward: number; }
export interface SnapshotView { weekId: string; closedAt: string | null; poolTotal: number; totalEarned: number; champions: Champion[]; }
export interface MyHistory { weekId: string; played: boolean; rank: number | null; totalEarned: number; reward: number; }

/** Closed weeks, newest first. */
export async function listClosedWeeks(pg: PgDb, limit = 12): Promise<ArchiveWeek[]> {
  const rows = await pg.select().from(weeks).where(eq(weeks.status, 'closed')).orderBy(desc(weeks.endsAt)).limit(limit);
  return rows.map((w) => ({
    weekId: w.weekId,
    poolTotal: Number(w.poolTotal),
    totalEarned: Number(w.totalEarned),
    closedAt: w.closedAt ? w.closedAt.toISOString() : null,
  }));
}

/** A closed week's champions (top 100) with rewards, decorated with names. Null if not archived. */
export async function getSnapshot(mongo: MongoDb, redis: Redis, weekId: string): Promise<SnapshotView | null> {
  const snap = await mongo.collection('leaderboard_snapshots').findOne<{
    weekId: string; closedAt: Date; poolTotal: number; totalEarned: number;
    entries: { rank: number; playerId: string; totalEarned: number }[];
    payouts: { rank: number; playerId: string; amount: number }[];
  }>({ weekId });
  if (!snap) return null;

  const reward = new Map(snap.payouts.map((p) => [p.playerId, p.amount]));
  const top = snap.entries.slice(0, 100);
  const decorated = await attachNames(redis, top.map((e) => ({ rank: e.rank, playerId: e.playerId, totalEarned: e.totalEarned })));
  const champions: Champion[] = decorated.map((e) => ({ ...e, reward: reward.get(e.playerId) ?? 0 }));

  return {
    weekId: snap.weekId,
    closedAt: snap.closedAt ? new Date(snap.closedAt).toISOString() : null,
    poolTotal: snap.poolTotal,
    totalEarned: snap.totalEarned,
    champions,
  };
}

/** A player's final standing for a closed week — works even outside the snapshot's top 1000. */
export async function getMyHistory(pg: PgDb, weekId: string, playerId: string): Promise<MyHistory> {
  const mine = (await pg.select({ total: weeklyScores.totalEarned })
    .from(weeklyScores).where(and(eq(weeklyScores.weekId, weekId), eq(weeklyScores.playerId, playerId))))[0];

  if (!mine) return { weekId, played: false, rank: null, totalEarned: 0, reward: 0 };

  const higher = (await pg.select({ n: sql<number>`count(*)::int` })
    .from(weeklyScores).where(and(eq(weeklyScores.weekId, weekId), gt(weeklyScores.totalEarned, mine.total))))[0];
  const payout = (await pg.select({ amount: rewardPayouts.amount })
    .from(rewardPayouts).where(and(eq(rewardPayouts.weekId, weekId), eq(rewardPayouts.playerId, playerId))))[0];

  return {
    weekId,
    played: true,
    rank: (higher?.n ?? 0) + 1,
    totalEarned: Number(mine.total),
    reward: payout ? Number(payout.amount) : 0,
  };
}
