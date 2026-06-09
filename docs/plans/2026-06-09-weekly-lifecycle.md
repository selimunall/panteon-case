# Weekly Lifecycle Implementation Plan

> **Methodology:** Implementation-first (no TDD). Each task writes real code, verified by `tsc --noEmit` and a live run against the Docker stores. **Tests are written last** (Task 8). Steps use checkbox (`- [ ]`) syntax.

**Goal:** At the end of each week, close it exactly once: drain its stream (barrier), reconcile the verified totals from Mongo, derive the top 100 from Postgres, distribute the integer prize pool (20/15/10 + linear 4–100), roll the remainder forward, archive a snapshot, open the next week, and clean up the week's Redis keys.

**Architecture:** A scheduler in the **Background** process finds ended-but-active weeks and closes each under a **leader lock** (only one runner). The close is idempotent (gated on `status`). Money is exact: the prize pool and payouts are integers derived from Postgres after a Mongo reconcile; the leftover rolls into next week so `sum(payouts) + rolloverOut = pool`. See architecture §5.

**Tech Stack:** Drizzle (transactional payout + close), ioredis (leader lock, key cleanup, `drainStream` from Plan 3), mongodb (reconcile aggregation, snapshot), the existing `weekIdFor`/`weekWindow`.

**Depends on:** Plans 1–4. Reuses `drainStream`/`GROUP` (Plan 3), `ensureWeekRow` (Plan 3), the schema, key helpers, and `Config`.

**Prerequisite:** `pnpm db:up`.

---

## Key design points

- **Barrier before money.** The close first calls `drainStream(weekId)` so every earn for the week has reached Mongo + Postgres before we read totals (architecture §5.2). Without it we would distribute incomplete money.
- **Reconcile from Mongo.** `weekly_scores` is a fast running total; at close we recompute it exactly from the deduped `earning_events` (Mongo is the raw truth), healing any worker crash-edge drift. **This requires `earning_events` to be the complete raw log** — so this plan also updates the seed to emit one event per player (Task 1), keeping the seeded dataset internally consistent (Mongo sum == weekly_scores == ZSET).
- **Integer money + rollover invariant.** Pool `= floor(total * rate) + rolloverIn`. Top 3 get 20/15/10%; ranks 4–100 split 55% by weight `(101 - rank)^k`. Every amount is a floored integer; `rolloverOut = pool - sum(payouts)` carries the remainder forward, so no currency is created or destroyed.
- **Idempotent + leader-locked.** A Redis `lock:close:{weekId}` (`SET NX EX`) elects one runner; the close is gated on `weeks.status = 'active'` and `reward_payouts` is `unique(week_id, player_id)`, so a re-run is a no-op.

---

## File map

| File | Responsibility |
| --- | --- |
| `server/src/db/seed.ts` (modify) | Emit one `earning_events` doc per player (consistent raw log) + ensure indexes. |
| `server/src/services/distribution.ts` (new) | Pure `computeDistribution(orderedPlayerIds, pool, poolCfg)` → payouts + rolloverOut. |
| `server/src/services/reconcile.ts` (new) | `reconcileWeek(pg, mongo, weekId)` → overwrite `weekly_scores` + `weeks.total_earned` from Mongo. |
| `server/src/lib/leaderLock.ts` (new) | `acquireCloseLock` / `releaseCloseLock`. |
| `server/src/services/closeWeek.ts` (new) | The full close orchestration. |
| `server/src/scheduler.ts` (new) | `startCloseScheduler` — periodic find-and-close. |
| `server/src/close.ts` (new) | CLI to close a specific weekId (ops/verification). |
| `server/src/worker.ts` (modify) | Start the scheduler in the Background process. |

---

### Task 1: Make the seed's raw log consistent

**Files:** Modify `server/src/db/seed.ts`.

- [ ] **Step 1: Emit one earning_event per player + ensure indexes**

In `server/src/db/seed.ts`, replace the single placeholder Mongo insert with one event per player, and ensure the unique index exists. Replace this block:

```ts
    await mongo.db.collection('earning_events').insertOne({
      weekId, playerId: playerRows[0]!.id, delta: 1000, idempKey: randomUUID(),
      clientTs: now, ingestedAt: now, streamId: 'seed-0',
    });
```

with:

```ts
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
```

Add the import at the top of the file:

```ts
import { ensureEventIndexes } from '../services/mongoEvents.js';
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/db/seed.ts
git commit -m "feat(server): seed emits one earning_event per player (consistent raw log)"
```

---

### Task 2: Distribution math (pure)

**Files:** Create `server/src/services/distribution.ts`.

- [ ] **Step 1: Create the distribution function**

Create `server/src/services/distribution.ts`:

```ts
import type { Config } from '@panteon/shared';

export interface Payout { rank: number; playerId: string; amount: bigint; }
export interface Distribution { payouts: Payout[]; rolloverOut: bigint; }

/**
 * Distribute an integer pool to the top 100 (architecture §5.3): 1st 20%, 2nd 15%, 3rd 10%,
 * ranks 4..N split 55% by weight (101 - rank)^k. Every amount is floored; the leftover is
 * rolloverOut, so sum(payouts) + rolloverOut === pool exactly.
 */
export function computeDistribution(orderedPlayerIds: string[], pool: bigint, poolCfg: Config['pool']): Distribution {
  const N = Math.min(orderedPlayerIds.length, 100);
  const payouts: Payout[] = [];
  const bps = (f: number) => BigInt(Math.round(f * 10000));
  const add = (rank: number, amount: bigint) => payouts.push({ rank, playerId: orderedPlayerIds[rank - 1]!, amount });

  if (N >= 1) add(1, (pool * bps(poolCfg.top3[0])) / 10000n);
  if (N >= 2) add(2, (pool * bps(poolCfg.top3[1])) / 10000n);
  if (N >= 3) add(3, (pool * bps(poolCfg.top3[2])) / 10000n);

  if (N >= 4) {
    const band = (pool * bps(poolCfg.bandShare)) / 10000n;
    const weights: number[] = [];
    let sumW = 0;
    for (let rank = 4; rank <= N; rank++) { const w = Math.pow(101 - rank, poolCfg.curveExponent); weights.push(w); sumW += w; }
    const sumWi = BigInt(Math.round(sumW * 1e6));
    for (let i = 0; i < weights.length; i++) {
      const wi = BigInt(Math.round(weights[i]! * 1e6));
      add(4 + i, (band * wi) / sumWi);
    }
  }

  const totalPaid = payouts.reduce((a, p) => a + p.amount, 0n);
  return { payouts, rolloverOut: pool - totalPaid };
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/distribution.ts
git commit -m "feat(server): integer prize-pool distribution (20/15/10 + linear 4-100)"
```

---

### Task 3: Reconcile weekly_scores from Mongo

**Files:** Create `server/src/services/reconcile.ts`.

- [ ] **Step 1: Create the reconcile module**

Create `server/src/services/reconcile.ts`:

```ts
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
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/reconcile.ts
git commit -m "feat(server): close-time reconcile of weekly_scores from Mongo"
```

---

### Task 4: Leader lock

**Files:** Create `server/src/lib/leaderLock.ts`.

- [ ] **Step 1: Create the lock helpers**

Create `server/src/lib/leaderLock.ts`:

```ts
import type Redis from 'ioredis';

const lockKey = (weekId: string) => `lock:close:${weekId}`;

/** Try to become the single closer for a week. Returns true if the lock was acquired. */
export async function acquireCloseLock(redis: Redis, weekId: string, ttlSec = 300): Promise<boolean> {
  const res = await redis.set(lockKey(weekId), '1', 'EX', ttlSec, 'NX');
  return res === 'OK';
}

export async function releaseCloseLock(redis: Redis, weekId: string): Promise<void> {
  await redis.del(lockKey(weekId));
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/lib/leaderLock.ts
git commit -m "feat(server): redis leader lock for the weekly close"
```

---

### Task 5: Close-week orchestration

**Files:** Create `server/src/services/closeWeek.ts`.

- [ ] **Step 1: Create the close orchestration**

Create `server/src/services/closeWeek.ts`:

```ts
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
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/closeWeek.ts
git commit -m "feat(server): weekly close orchestration (barrier/reconcile/distribute/archive)"
```

---

### Task 6: Scheduler + close CLI

**Files:** Create `server/src/scheduler.ts`, `server/src/close.ts`; modify `server/src/worker.ts`, `server/package.json`.

- [ ] **Step 1: Create the scheduler**

Create `server/src/scheduler.ts`:

```ts
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
```

- [ ] **Step 2: Create the close CLI (ops / verification)**

Create `server/src/close.ts`:

```ts
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createPg } from './db/pg.js';
import { createRedis } from './db/redis.js';
import { createMongo } from './db/mongo.js';
import { closeWeek } from './services/closeWeek.js';

async function main(): Promise<void> {
  const weekId = process.argv[2];
  if (!weekId) { console.error('usage: tsx src/close.ts <weekId>'); process.exit(1); }

  const env = loadEnv();
  const config = loadConfig(env);
  const { pool, db: pg } = createPg(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const { client, db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);

  try {
    const result = await closeWeek({ redis, mongo, pg }, weekId, env.WEEK_RESET_OFFSET_HOURS, config);
    console.log('close result:', result && {
      weekId: result.weekId, pool: result.pool.toString(),
      rolloverOut: result.rolloverOut.toString(), paid: result.paid, nextWeekId: result.nextWeekId,
    });
  } finally {
    await client.close();
    await redis.quit();
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
```

Add to `server/package.json` scripts:

```json
    "close": "tsx --env-file=../.env src/close.ts",
```

- [ ] **Step 3: Start the scheduler in the worker**

In `server/src/worker.ts` add the import and start it next to the refresher:

```ts
import { startCloseScheduler } from './scheduler.js';
```

After `const stopRefresher = startTop100Refresher(...);` add:

```ts
  const stopScheduler = startCloseScheduler(deps, env.WEEK_RESET_OFFSET_HOURS, config);
```

And in `shutdown`, call `stopScheduler();` alongside `stopRefresher();`.

- [ ] **Step 4: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/scheduler.ts server/src/close.ts server/src/worker.ts server/package.json
git commit -m "feat(worker): close scheduler + manual close CLI"
```

---

### Task 7: Live verification (manual, end-to-end)

The close runs on any `weekId` via the CLI regardless of `endsAt`, so we close the seeded current week directly and inspect the money.

- [ ] **Step 1: Fresh seed (consistent raw log)**

```bash
pnpm db:reset
cd server && npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && cd ..
```
Note the weekId (`2026-W24`). The updated seed wrote 500 `earning_events` matching the scores.

- [ ] **Step 2: Close the week**

```bash
cd server && npx tsx --env-file=../.env src/close.ts 2026-W24 && cd ..
```
Expected: `close result: { weekId: '2026-W24', pool: '<n>', rolloverOut: '<r>', paid: 100, nextWeekId: '2026-W25' }`.

- [ ] **Step 3: Verify the money invariant + payouts**

```bash
PSQL="docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc"
echo -n "payout rows (100): ";   $PSQL "select count(*) from reward_payouts where week_id='2026-W24'"
echo -n "sum(payouts):       ";  $PSQL "select coalesce(sum(amount),0) from reward_payouts where week_id='2026-W24'"
echo    "week row (pool/rollover_out/status):"; $PSQL "select pool_total, rollover_out, status from weeks where week_id='2026-W24'"
echo "INVARIANT sum(payouts)+rollover_out == pool_total:"
$PSQL "select (select coalesce(sum(amount),0) from reward_payouts where week_id='2026-W24') + (select rollover_out from weeks where week_id='2026-W24') = (select pool_total from weeks where week_id='2026-W24')"
```
Expected: 100 rows; `status=closed`; the final boolean is `t` (invariant holds).

- [ ] **Step 4: Verify the top-3 percentages**

```bash
PSQL="docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc"
POOL=$($PSQL "select pool_total from weeks where week_id='2026-W24'")
echo "pool=$POOL  rank1 (~20%): $($PSQL "select amount from reward_payouts where week_id='2026-W24' and rank=1")"
echo "rank2 (~15%): $($PSQL "select amount from reward_payouts where week_id='2026-W24' and rank=2")  rank3 (~10%): $($PSQL "select amount from reward_payouts where week_id='2026-W24' and rank=3")"
echo "rank4 > rank100 (monotone): $($PSQL "select (select amount from reward_payouts where week_id='2026-W24' and rank=4) > (select amount from reward_payouts where week_id='2026-W24' and rank=100)")"
```
Expected: rank1 ≈ 20% of pool, rank2 ≈ 15%, rank3 ≈ 10%, and rank4 > rank100 (`t`).

- [ ] **Step 5: Snapshot, next week, and Redis cleanup**

```bash
docker exec panteon-leaderboard-mongo-1 mongosh leaderboard --quiet --eval "const s=db.leaderboard_snapshots.findOne({weekId:'2026-W24'}); print('snapshot entries', s.entries.length, 'payouts', s.payouts.length)"
docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc "select week_id, rollover_in, status from weeks where week_id='2026-W25'"
echo -n "old ZSET deleted (0): "; docker exec panteon-leaderboard-redis-1 redis-cli exists leaderboard:week:2026-W24
```
Expected: snapshot has 500 entries + 100 payouts; `2026-W25` exists with `rollover_in` = the closed week's `rollover_out`; old ZSET `exists` → 0.

- [ ] **Step 6: Idempotency — re-close is a no-op**

```bash
cd server && npx tsx --env-file=../.env src/close.ts 2026-W24 && cd ..
docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc "select count(*) from reward_payouts where week_id='2026-W24'"  # still 100
```
Expected: `close result: null` (already closed); payout rows still 100.

- [ ] **Step 7: No commit (verification only).**

---

### Task 8: Tests (deferred to the final testing pass)

- **`computeDistribution`:** top3 = 20/15/10% of pool; band shares are monotone decreasing (rank 4 > rank 100); `sum(payouts) + rolloverOut === pool` for various pools and player counts (including N<4 and N<100).
- **`reconcileWeek`:** overwrites `weekly_scores` to the Mongo sums; sets `weeks.total_earned`; idempotent (running twice yields the same totals).
- **`closeWeek`:** writes 100 payouts; sets `status=closed`, `pool_total`, `rollover_out`; archives a snapshot; opens the next week with `rollover_in = rolloverOut`; deletes the Redis keys; re-run returns `null`.
- **`startCloseScheduler`:** picks up an ended-but-active week; the lock prevents two concurrent closers.

---

## Self-Review

**Spec coverage (architecture §5):**
- Time-derived `nextWeekId`, no swap → Task 5 (`weekIdFor(weekWindow(...).endsAt)`). ✓
- Barrier (drain the pipeline) before reading totals → Task 5 (`drainStream`). ✓
- Payout ranking from Postgres authoritative totals after a Mongo reconcile → Tasks 3 + 5. ✓
- Integer pool, 20/15/10 + linear `(101-rank)^k`, rollover invariant → Task 2. ✓
- `reward_payouts` in one transaction; idempotent close (status gate + unique + leader lock) → Tasks 4 + 5. ✓
- Snapshot archive to Mongo; open next week with rollover; clean up Redis keys → Task 5. ✓
- Scheduler in the Background process → Task 6. ✓

**Type consistency:** `Payout`/`Distribution` (Task 2) feed `closeWeek` (Task 5); `CloseDeps` matches the worker `deps`; `reconcileWeek`/`drainStream`/`ensureWeekRow`/`computeDistribution` signatures line up; money stays `bigint` end to end (converted to `Number` only for the Mongo snapshot, with the known large-value caveat).

**Known trade-offs:** reconcile re-aggregates all of a week's events (heavy at true scale; chunked, `allowDiskUse`); a crash after the close transaction but before Redis cleanup leaves the old keys lingering until manually cleared (money is already correct); snapshot money fields are stored as `Number` (fine for the case, switch to string/Decimal128 at extreme scale).
