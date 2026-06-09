import { sql, eq } from 'drizzle-orm';
import type { Db } from '../db/pg.js';
import { players, weeklyScores, weeks } from '../db/schema.js';
import { weekWindow } from '../lib/week.js';
import type { StreamEvent } from './mongoEvents.js';

/**
 * Ensure the week row exists before we increment its total. A fresh week's row may not be
 * opened yet (seed/Plan 5 own that), so the worker upserts it as a safety net — otherwise the
 * `UPDATE weeks` below would silently affect 0 rows and total_earned would never accumulate.
 */
export async function ensureWeekRow(db: Db, weekId: string, offsetHours: number): Promise<void> {
  const { startsAt, endsAt } = weekWindow(weekId, offsetHours);
  await db.insert(weeks).values({ weekId, startsAt, endsAt, status: 'active' }).onConflictDoNothing();
}

/**
 * Apply the given (already idempotency-filtered) events to Postgres in one transaction:
 * ensure player rows exist, increment per-player weekly_scores, bump weeks.total_earned.
 * Players are owned upstream; for ids we have not seen we insert a stub (display name filled
 * later by upstream sync) so the weekly_scores FK holds.
 */
export async function persistScores(db: Db, weekId: string, events: StreamEvent[]): Promise<void> {
  if (events.length === 0) return;

  // Sum deltas per player.
  const perPlayer = new Map<string, bigint>();
  for (const e of events) {
    perPlayer.set(e.playerId, (perPlayer.get(e.playerId) ?? 0n) + BigInt(e.delta));
  }
  const playerIds = [...perPlayer.keys()];
  const scoreRows = playerIds.map((id) => ({ weekId, playerId: id, totalEarned: perPlayer.get(id)! }));
  const stubPlayers = playerIds.map((id) => ({ id, displayName: `player-${id.slice(0, 8)}` }));
  const batchTotal = [...perPlayer.values()].reduce((a, b) => a + b, 0n);

  await db.transaction(async (tx) => {
    await tx.insert(players).values(stubPlayers).onConflictDoNothing();
    await tx.insert(weeklyScores).values(scoreRows).onConflictDoUpdate({
      target: [weeklyScores.weekId, weeklyScores.playerId],
      set: {
        totalEarned: sql`${weeklyScores.totalEarned} + EXCLUDED.total_earned`,
        updatedAt: sql`now()`,
      },
    });
    await tx.update(weeks)
      .set({ totalEarned: sql`${weeks.totalEarned} + ${batchTotal}` })
      .where(eq(weeks.weekId, weekId));
  });
}
