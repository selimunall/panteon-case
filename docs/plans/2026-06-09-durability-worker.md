# Durability Worker Implementation Plan

> **Methodology:** Implementation-first (no TDD). Each task writes real code, verified by `tsc --noEmit` and a live run against the Docker stores. **Tests are written last** (Task 6 lists the cases). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Drain `stream:earnings:week:{weekId}` with a Redis consumer group and durably persist each earn — raw events into Mongo `earning_events`, verified per-player totals into Postgres `weekly_scores`, and the running `weeks.total_earned` — at-least-once, idempotent, never double-counting.

**Architecture:** A stateless **Background** process runs a consumer-group loop (architecture §3.3). Each cycle: read a batch of stream entries, **insert the raw events into Mongo first** (unique `idempKey` index), persist **only the events new to Mongo** into Postgres inside one transaction, then `XACK`. This makes Mongo the idempotency gate and the raw source of truth; Postgres holds the running verified totals. Reads stay untouched (Redis only).

**Tech Stack:** ioredis (consumer groups: `XGROUP`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`), the official mongodb driver, Drizzle (transactional upserts), the existing `weekIdFor`/key helpers.

**Depends on:** Plan 1 (`createPg`/`createRedis`/`createMongo`, schema, `weekIdFor`) and Plan 2 (the hot path that fills the stream; `keys.ts`).

**Prerequisite:** `pnpm db:up`.

---

## Key design decision: idempotent persistence under at-least-once delivery

The hot-path Lua already dedupes by `idempKey` (`SET NX` before `XADD`), so under normal operation **each batch enters the stream at most once**. The only source of a duplicate reaching the worker is **stream redelivery** of un-acked entries after a worker crash (the consumer group's PEL, or `XAUTOCLAIM` from a dead consumer). We must not double-count those.

**Mechanism — Mongo is the idempotency gate:**

1. `earning_events` has a **unique index on `idempKey`**.
2. Each cycle the worker `insertMany(..., { ordered: false })`. Re-delivered events hit the unique index and surface as `E11000` duplicate errors; the rest insert. The worker computes the set of **newly-inserted `idempKey`s**.
3. Postgres is updated **only for the newly-inserted events** (grouped per player), in one transaction. So a redelivered batch — already in Mongo — is skipped in Postgres → **no double count**.

**Edge case (dual-write):** if Mongo commits but the Postgres transaction or the `XACK` fails, redelivery finds the events already in Mongo and skips Postgres, so those deltas are momentarily missing from `weekly_scores`. This is healed by the **close-time reconcile (Plan 5)**: before distribution, the close job recomputes `weekly_scores` exactly from the deduped `earning_events` (Mongo is the raw truth). During the week `weekly_scores` is a fast running total; exact money is guaranteed at close. This keeps the worker simple and correct without a separate Postgres dedupe table.

---

## Operational notes / known trade-offs

- **Merge window = batch.** "Per-player 500ms merge" (architecture §3.3) is realised as "merge whatever one `XREADGROUP COUNT/BLOCK` returns" — the batch *is* the window. Functionally equivalent; tune `COUNT`/`BLOCK` to trade latency for batch size.
- **Consumer ids are per-process.** Each restart uses a new random consumer name, so a crashed worker's in-flight entries are picked up by `reclaimStale` only after the 30s idle threshold, and dead consumers accumulate in the group (cosmetic; could `XGROUP DELCONSUMER` on shutdown later).
- **bigint sql params.** `weeks.total_earned` is incremented with a `bigint` param (`${batchTotal}`); verified to work through pg/Drizzle (the seed already inserts `bigint` values), but confirm during implementation.

## File map

| File | Responsibility |
| --- | --- |
| `server/src/services/mongoEvents.ts` (new) | Ensure the `earning_events` unique index; `insertRawEvents` → returns the newly-inserted `idempKey`s. |
| `server/src/services/persistScores.ts` (new) | `ensureWeekRow` (upsert the week) + transactional persist: stub players, increment `weekly_scores`, bump `weeks.total_earned`. |
| `server/src/services/streamConsumer.ts` (new) | Ensure the group, parse entries, orchestrate one batch (Mongo→filter→Postgres→ack), reclaim stale pending. |
| `server/src/worker.ts` (new) | The Background entrypoint: loop over the current week, graceful shutdown. |
| `server/package.json` (modify) | Add the `worker` script. |

---

### Task 1: Mongo raw-event writer (the idempotency gate)

**Files:** Create `server/src/services/mongoEvents.ts`.

- [ ] **Step 1: Create the Mongo events module**

Create `server/src/services/mongoEvents.ts`:

```ts
import type { Db } from 'mongodb';

export interface StreamEvent {
  streamId: string;   // Redis stream entry id
  playerId: string;
  delta: number;
  idempKey: string;
  clientTs: number;
}

/** Create the unique idempKey index once (idempotency gate) plus a query index. */
export async function ensureEventIndexes(db: Db): Promise<void> {
  const col = db.collection('earning_events');
  await col.createIndex({ idempKey: 1 }, { unique: true });
  await col.createIndex({ weekId: 1, playerId: 1 });
}

/**
 * Insert raw events; duplicates (re-delivered) are ignored via the unique index.
 * Returns the set of idempKeys that were NEWLY inserted (to be applied to Postgres).
 */
export async function insertRawEvents(db: Db, weekId: string, events: StreamEvent[]): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  const now = new Date();
  const docs = events.map((e) => ({
    weekId,
    playerId: e.playerId,
    delta: e.delta,
    idempKey: e.idempKey,
    clientTs: new Date(e.clientTs),
    ingestedAt: now,
    streamId: e.streamId,
  }));

  try {
    await db.collection('earning_events').insertMany(docs, { ordered: false });
    return new Set(events.map((e) => e.idempKey)); // all new
  } catch (err: unknown) {
    const e = err as { writeErrors?: Array<{ code?: number; index?: number }> };
    const writeErrors = e.writeErrors ?? [];
    // Only a bulk write whose failures are ALL duplicate-key (E11000) is a partial success.
    // Any other failure (connection error, etc.) must propagate so the batch is NOT acked and
    // is redelivered — otherwise we would ack events that never landed in Mongo and lose them.
    if (writeErrors.length === 0 || writeErrors.some((w) => w.code !== 11000)) {
      throw err;
    }
    const dupKeys = new Set<string>();
    for (const we of writeErrors) {
      if (we.index !== undefined && docs[we.index]) dupKeys.add(docs[we.index]!.idempKey);
    }
    return new Set(events.filter((ev) => !dupKeys.has(ev.idempKey)).map((ev) => ev.idempKey));
  }
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/mongoEvents.ts
git commit -m "feat(worker): mongo raw-event writer with unique-idempKey gate"
```

---

### Task 2: Postgres transactional persist

**Files:** Create `server/src/services/persistScores.ts`.

- [ ] **Step 1: Create the persist module**

Create `server/src/services/persistScores.ts`:

```ts
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
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/persistScores.ts
git commit -m "feat(worker): transactional postgres persist (scores + week total)"
```

---

### Task 3: Stream consumer

**Files:** Create `server/src/services/streamConsumer.ts`.

- [ ] **Step 1: Create the consumer module**

Create `server/src/services/streamConsumer.ts`:

```ts
import type Redis from 'ioredis';
import type { Db as MongoDb } from 'mongodb';
import type { Db as PgDb } from '../db/pg.js';
import { streamKey } from '../lib/keys.js';
import { insertRawEvents, type StreamEvent } from './mongoEvents.js';
import { persistScores } from './persistScores.js';

export const GROUP = 'cg:persist';

/** Create the consumer group at 0 (process all history) if it does not exist yet. */
export async function ensureGroup(redis: Redis, weekId: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', streamKey(weekId), GROUP, '0', 'MKSTREAM');
  } catch (err: unknown) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('BUSYGROUP')) throw err;
  }
}

/** Flatten ioredis' [id, [f, v, f, v, ...]] entries into StreamEvents. */
function parseEntries(entries: Array<[string, string[]]>): StreamEvent[] {
  return entries.map(([id, fields]) => {
    const f: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) f[fields[i]!] = fields[i + 1]!;
    return {
      streamId: id,
      playerId: f.playerId!,
      delta: Number(f.delta),
      idempKey: f.idempKey!,
      clientTs: Number(f.clientTs),
    };
  });
}

async function handleBatch(
  deps: { redis: Redis; mongo: MongoDb; pg: PgDb },
  weekId: string,
  entries: Array<[string, string[]]>,
): Promise<number> {
  if (entries.length === 0) return 0;
  const events = parseEntries(entries);
  const freshKeys = await insertRawEvents(deps.mongo, weekId, events); // Mongo first (gate)
  const freshEvents = events.filter((e) => freshKeys.has(e.idempKey));
  await persistScores(deps.pg, weekId, freshEvents);                   // Postgres for new only
  await deps.redis.xack(streamKey(weekId), GROUP, ...entries.map(([id]) => id));
  return entries.length;
}

/** Reclaim entries pending on dead consumers (idle > 30s) and process them. */
export async function reclaimStale(
  deps: { redis: Redis; mongo: MongoDb; pg: PgDb },
  weekId: string,
  consumer: string,
): Promise<number> {
  const res = (await deps.redis.xautoclaim(
    streamKey(weekId), GROUP, consumer, 30_000, '0', 'COUNT', 200,
  )) as [string, Array<[string, string[]]>, string[]];
  const entries = res?.[1] ?? [];
  return handleBatch(deps, weekId, entries);
}

/** Read and process one batch of new entries. Returns the number processed. */
export async function processBatch(
  deps: { redis: Redis; mongo: MongoDb; pg: PgDb },
  weekId: string,
  consumer: string,
  blockMs = 2000,
): Promise<number> {
  const res = (await deps.redis.xreadgroup(
    'GROUP', GROUP, consumer, 'COUNT', 500, 'BLOCK', blockMs, 'STREAMS', streamKey(weekId), '>',
  )) as Array<[string, Array<[string, string[]]>]> | null;
  const entries = res?.[0]?.[1] ?? [];
  return handleBatch(deps, weekId, entries);
}

/** Drain a week's stream until both new and pending are empty (used by the close job, Plan 5). */
export async function drainStream(
  deps: { redis: Redis; mongo: MongoDb; pg: PgDb },
  weekId: string,
  consumer: string,
): Promise<void> {
  await ensureGroup(deps.redis, weekId);
  while ((await reclaimStale(deps, weekId, consumer)) > 0) { /* keep claiming */ }
  while ((await processBatch(deps, weekId, consumer, 100)) > 0) { /* keep reading */ }
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/streamConsumer.ts
git commit -m "feat(worker): stream consumer (read/persist/ack + reclaim/drain)"
```

---

### Task 4: Worker entrypoint

**Files:** Create `server/src/worker.ts`; modify `server/package.json`.

- [ ] **Step 1: Create the worker loop**

Create `server/src/worker.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { loadEnv } from './env.js';
import { createPg } from './db/pg.js';
import { createRedis } from './db/redis.js';
import { createMongo } from './db/mongo.js';
import { weekIdFor } from './lib/week.js';
import { ensureEventIndexes } from './services/mongoEvents.js';
import { ensureWeekRow } from './services/persistScores.js';
import { ensureGroup, processBatch, reclaimStale } from './services/streamConsumer.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const consumer = `worker-${randomUUID().slice(0, 8)}`;
  const { pool, db: pg } = createPg(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const { client: mongoClient, db: mongo } = await createMongo(env.MONGO_URL, env.MONGO_DB);

  await ensureEventIndexes(mongo);
  const deps = { redis, mongo, pg };

  let running = true;
  const shutdown = async () => {
    running = false;
    await Promise.allSettled([redis.quit(), mongoClient.close(), pool.end()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`worker ${consumer} started`);
  let lastWeek = '';
  while (running) {
    const weekId = weekIdFor(new Date(), env.WEEK_RESET_OFFSET_HOURS);
    if (weekId !== lastWeek) {
      await ensureWeekRow(pg, weekId, env.WEEK_RESET_OFFSET_HOURS);
      await ensureGroup(redis, weekId);
      lastWeek = weekId;
    }
    await reclaimStale(deps, weekId, consumer);   // pick up crashed consumers' work
    await processBatch(deps, weekId, consumer);   // BLOCK-waits for new entries
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add the worker script**

In `server/package.json` scripts, add:

```json
    "worker": "tsx --env-file=../.env src/worker.ts",
```

- [ ] **Step 3: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/worker.ts server/package.json
git commit -m "feat(worker): background consumer-group loop entrypoint"
```

---

### Task 5: Live verification (manual, end-to-end)

- [ ] **Step 1: Fresh stores + seed + migrate**

```bash
pnpm db:reset
cd server && npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && cd ..
```
Note the seeded `weekId` (e.g. `2026-W24`).

- [ ] **Step 2: Boot the API and the worker (separate terminals)**

```bash
# terminal A
cd server && npx tsx --env-file=../.env src/index.ts
# terminal B
cd server && npx tsx --env-file=../.env src/worker.ts
```
Expected: API logs `server listening …`; worker logs `worker worker-xxxxxxxx started`.

- [ ] **Step 3: Post two earns for the same new player (different idempKeys)**

```bash
W=2026-W24; P=33333333-3333-3333-3333-333333333333
curl -s -X POST localhost:3000/earn -H 'content-type: application/json' -d "{\"playerId\":\"$P\",\"delta\":700,\"weekId\":\"$W\",\"idempKey\":\"$(uuidgen|tr A-Z a-z)\",\"clientTs\":1}"; echo
curl -s -X POST localhost:3000/earn -H 'content-type: application/json' -d "{\"playerId\":\"$P\",\"delta\":300,\"weekId\":\"$W\",\"idempKey\":\"$(uuidgen|tr A-Z a-z)\",\"clientTs\":1}"; echo
sleep 2
```

- [ ] **Step 4: Confirm durable persistence**

```bash
W=2026-W24; P=33333333-3333-3333-3333-333333333333
echo -n "mongo events for player: "; docker exec panteon-leaderboard-mongo-1 mongosh leaderboard --quiet --eval "db.earning_events.countDocuments({playerId:'$P'})"
echo -n "pg weekly_scores total:  "; docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc "select total_earned from weekly_scores where week_id='$W' and player_id='$P'"
echo -n "pg weeks.total_earned grew: "; docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc "select total_earned > 0 from weeks where week_id='$W'"
```
Expected: mongo events = 2; weekly_scores total = **1000** (700+300 merged); `weeks.total_earned` grew.

- [ ] **Step 5: Idempotency under redelivery (real gate test)**

A worker restart does not re-deliver acked entries, so it cannot exercise the gate. Force a real duplicate: grab an already-persisted `idempKey` and `XADD` it straight onto the stream (bypassing the hot path). The worker must read it, find it duplicate in Mongo, and skip Postgres:

```bash
W=2026-W24; P=33333333-3333-3333-3333-333333333333
DUP=$(docker exec panteon-leaderboard-mongo-1 mongosh leaderboard --quiet --eval "print(db.earning_events.findOne({playerId:'$P'}).idempKey)")
docker exec panteon-leaderboard-redis-1 redis-cli XADD "stream:earnings:week:$W" '*' playerId "$P" delta 999999 idempKey "$DUP" clientTs 1
sleep 2
docker exec panteon-leaderboard-postgres-1 psql -U panteon -d leaderboard -tAc "select total_earned from weekly_scores where player_id='$P'"   # -> still 1000
docker exec panteon-leaderboard-mongo-1 mongosh leaderboard --quiet --eval "db.earning_events.countDocuments({playerId:'$P'})"                   # -> still 2
```
Expected: `weekly_scores` still **1000** (the 999999 was gated out of Postgres) and Mongo still **2** — the duplicate `idempKey` entry was acked without being counted.

- [ ] **Step 6: Stop the API and worker** (Ctrl-C both). No commit (verification only).

---

### Task 6: Tests (deferred to the final testing pass)

- **`insertRawEvents`:** new batch → all keys returned + docs in Mongo; replay same batch → empty set, count unchanged.
- **`persistScores`:** per-player merge sums deltas into one row; second call increments (not replaces); `weeks.total_earned` bumped by the batch sum; stub player inserted only when absent.
- **`streamConsumer.processBatch`:** reads a batch, persists, acks (PEL empty afterwards via `XPENDING`).
- **`reclaimStale`:** an entry pending on a dead consumer past the idle threshold is reclaimed and acked.
- **End-to-end:** earn via `/earn` → worker → Mongo event + Postgres total; duplicate stream delivery does not double-count.

---

## Self-Review

**Spec coverage (architecture §3.3):**
- Consumer group over `stream:earnings:week:*` → Task 3 (`ensureGroup`, `processBatch`). ✓
- Per-player merge before persist → Task 2 (`perPlayer` map → single upsert per player). ✓
- Bulk raw insert to Mongo `earning_events` → Task 1. ✓
- Batch upsert to Postgres `weekly_scores` + accumulate the authoritative total → Task 2. ✓
- At-least-once + ack, replayable → Task 3 (`XACK`, `XAUTOCLAIM` reclaim). ✓
- No double count under redelivery → Mongo unique-`idempKey` gate (design section); close-time reconcile heals the dual-write edge (Plan 5). ✓
- Stateless, horizontally scalable → each replica is a distinct consumer in `cg:persist`; Task 4 generates a per-process consumer id. ✓

**Type consistency:** `StreamEvent` (Task 1) flows through `insertRawEvents` → `persistScores` → consumer; `Db` (pg) and `Db as MongoDb` (mongo) imports match Plan 1; `streamKey`/`weekIdFor` reused. `GROUP`/`drainStream` are exported for the close job (Plan 5).

**Deferred by design:** `drainStream` is built here but invoked by Plan 5 (the barrier before distribution); the close-time reconcile of `weekly_scores` from Mongo lives in Plan 5; all automated tests are Task 6.
