import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createPg } from './pg.js';
import { players, weeks, weeklyScores } from './schema.js';
import { createRedis } from './redis.js';
import { createMongo } from './mongo.js';
import { weekIdFor, weekWindow } from '../lib/week.js';
import { ensureEventIndexes } from '../services/mongoEvents.js';

export interface SeedOptions {
  pgUrl: string; redisUrl: string; mongoUrl: string; mongoDb: string;
  players?: number; offsetHours?: number; now?: Date;
}

export async function runSeed(opts: SeedOptions): Promise<{ weekId: string; count: number }> {
  const count = opts.players ?? 500;
  const offset = opts.offsetHours ?? 0;
  const now = opts.now ?? new Date();
  const weekId = weekIdFor(now, offset);
  const { startsAt, endsAt } = weekWindow(weekId, offset);

  const { pool, db } = createPg(opts.pgUrl);
  const redis = createRedis(opts.redisUrl);
  const mongo = await createMongo(opts.mongoUrl, opts.mongoDb);

  try {
    await db.insert(weeks).values({ weekId, startsAt, endsAt, status: 'active' }).onConflictDoNothing();

    // Idempotent re-seed: clear this week's scores AND the ZSET together, so re-running
    // the seed leaves Postgres and Redis with the same rows (no divergence/accumulation).
    await db.delete(weeklyScores).where(eq(weeklyScores.weekId, weekId));
    const zKey = `leaderboard:week:${weekId}`;
    await redis.del(zKey);

    const playerRows: { id: string; displayName: string }[] = [];
    const scoreRows: { weekId: string; playerId: string; totalEarned: bigint }[] = [];
    const zArgs: (string | number)[] = [];

    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      // Deterministic-ish descending spread so ranks are meaningful.
      const score = BigInt((count - i) * 1000 + ((i * 37) % 1000));
      playerRows.push({ id, displayName: `Player_${i + 1}` });
      scoreRows.push({ weekId, playerId: id, totalEarned: score });
      zArgs.push(Number(score), id);
    }

    await db.insert(players).values(playerRows).onConflictDoNothing();
    await db.insert(weeklyScores).values(scoreRows).onConflictDoNothing();
    await redis.zadd(zKey, ...zArgs);

    await ensureEventIndexes(mongo.db);
    await mongo.db.collection('earning_events').deleteMany({ weekId });
    await mongo.db.collection('earning_events').insertMany(
      scoreRows.map((s, i) => ({
        weekId,
        playerId: s.playerId,
        delta: Number(s.totalEarned),
        idempKey: randomUUID(),
        clientTs: now,
        ingestedAt: now,
        streamId: `seed-${i}`,
      })),
      { ordered: false },
    );

    return { weekId, count };
  } finally {
    await pool.end();
    await redis.quit();
    await mongo.client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeed({
    pgUrl: process.env.DATABASE_URL ?? 'postgres://panteon:panteon@localhost:5432/leaderboard',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    mongoUrl: process.env.MONGO_URL ?? 'mongodb://localhost:27017',
    mongoDb: process.env.MONGO_DB ?? 'leaderboard',
  }).then((r) => { console.log(`seeded ${r.count} players for ${r.weekId}`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
