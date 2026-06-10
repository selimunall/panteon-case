import { randomUUID } from 'node:crypto';
import { loadEnv } from './env.js';
import { createPg } from './db/pg.js';
import { players } from './db/schema.js';
import { weekIdFor } from './lib/week.js';

/**
 * Dev load generator: simulates active players by POSTing /earn continuously, so the
 * leaderboard visibly shifts (ranks reorder, prize pool grows) instead of sitting static.
 * Usage: pnpm mock [earnsPerTick=10] [tickMs=700]
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const base = process.env.API_URL ?? `http://localhost:${env.PORT}`;
  const perTick = Number(process.argv[2] ?? 10);
  const tickMs = Number(process.argv[3] ?? 700);

  const { pool, db } = createPg(env.DATABASE_URL);
  const ids = (await db.select({ id: players.id }).from(players)).map((r) => r.id);
  await pool.end();
  if (ids.length === 0) { console.error('no players — run the seed first'); process.exit(1); }

  console.log(`mock: ${ids.length} players · ${perTick} earns / ${tickMs}ms → ${base}/earn`);
  let ok = 0;
  let fail = 0;

  const tick = async () => {
    const weekId = weekIdFor(new Date(), env.WEEK_RESET_OFFSET_HOURS);
    await Promise.allSettled(
      Array.from({ length: perTick }, () => {
        const playerId = ids[Math.floor(Math.random() * ids.length)]!;
        // mostly small earns, occasionally a "whale" so the top reorders too
        const delta = Math.random() < 0.1
          ? 20000 + Math.floor(Math.random() * 60000)
          : 500 + Math.floor(Math.random() * 6000);
        return fetch(`${base}/earn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId, delta, weekId, idempKey: randomUUID(), clientTs: Date.now() }),
        }).then((r) => { r.ok ? ok++ : fail++; }).catch(() => { fail++; });
      }),
    );
    process.stdout.write(`\rsent ok=${ok} fail=${fail}`);
  };

  setInterval(() => void tick(), tickMs);
}

main().catch((err) => { console.error(err); process.exit(1); });
