# Panteon Weekly Leaderboard — Architecture Design

- **Status:** Approved
- **Date:** 2026-06-09
- **Scope:** System architecture (data model, write/read paths, weekly lifecycle, topology, stack). Frontend UI design is a separate later spec.

---

## 1. Context & Goals

One of Panteon's idle/clicker games has **10M+ registered players** and **~2M daily active players**. Players earn in-game currency continuously; **each week starts fresh** and the top earners climb a weekly leaderboard. The legacy leaderboard is slow, can't show a player their own rank, and freezes on scroll.

The product ask: **make the leaderboard feel instant**, let every player see **their own rank and neighbours**, and **distribute weekly rewards automatically**.

### Hard requirements (from the brief)

- Stack is fixed: **Node.js, PostgreSQL, MongoDB, Redis**. Implementation must stay within it.
- **Stateless** architecture; horizontally scalable.
- **TypeScript** on both client and server; **separate** client and server projects.
- Tested on **PC and mobile**.
- **Prize pool** = 2% of total currency earned during the week. At week end, distributed to the **top 100**: 1st 20%, 2nd 15%, 3rd 10%; remaining **55% across ranks 4–100 by rank**. Then pool and leaderboard **reset**.
- Leaderboard always shows **top 100**. A player outside the top 100 sees **their own rank plus the 3 players above and 2 below**.
- A **production build** deployed on an **accessible domain**.

### Non-goals

- Not full event-sourcing. MongoDB holds the raw earning log; the authoritative verified totals live in PostgreSQL.
- Not per-timezone leaderboards. There is **one global board** with one global weekly boundary.
- Not sub-second monetary consistency on the hot path. The leaderboard is allowed to be eventually consistent within a small window (seconds); **money is exact** at distribution time.

---

## 2. Architectural Principle: One Axis Per Store

The single rule the whole design follows: **each datastore is a specialist on exactly one axis, and none does another's job.**

| Store | Axis | Owns | Source of truth? | On hot read path? |
| --- | --- | --- | --- | --- |
| **Redis** | Speed | Live weekly sorted set, running prize-pool counter, idempotency keys, rate-limit counters, the durability stream | No — disposable, rebuildable from Postgres | **Yes (and hot write path)** |
| **PostgreSQL** | Truth / money (ACID) | `players`, `weekly_scores` (verified totals), `weeks` (lifecycle), `reward_payouts` | **Yes** | No |
| **MongoDB** | Volume / history | `earning_events` (append-only), `leaderboard_snapshots` (weekly archive) | Yes, for **raw history / audit** only | No |

**Deliberate duplication:** the weekly total and the pool counter exist in *both* Redis and Postgres. This is intentional — Redis is fast, Postgres is durable. Redis is treated as a **lossy hot layer**: if it is lost, it is rebuilt from Postgres.

**Consequence that makes the board feel instant:** a read request (top 100 / my rank / my neighbours) touches **Redis only** — never Postgres, never Mongo. At 2M DAU this single rule is the reason the board is instant.

---

## 3. Write Path

### 3.1 Client batching

The client accumulates earnings locally and sends **one delta every ~5s** (configurable), not one request per click.

- An idle/clicker board does not need sub-second precision; a 5s delay is invisible to a competitive player, and the pool accumulates over the whole week, so a batched delta loses no money as long as it is eventually counted.
- The "tap → instant feel" happens **locally on the client**; what goes to the server is only synchronization.

Three safeguards:

1. **Idempotency key per batch.** Mobile networks retry; without a key a retried batch double-counts. The key is checked inside the hot-path Lua script and dedupes the earn *before* it ever enters the stream.
2. **Lifecycle flush + offline persistence.** Force-send on background / app close / screen change. Because mobile apps can be killed, the pending delta is also persisted locally and re-sent on next launch **with the same idempotency key**, so a session's queue is never lost.
3. **Server-side clamp.** Because the batch interval is known, "max plausible earnings per interval" is a checkable bound — a simple, well-placed anti-cheat gate.

### 3.2 Hot path — synchronous, Redis only

The synchronous part of the request runs a **single atomic Lua script** in one round-trip (sub-ms), which performs:

```
1. idempotency check  (SET NX on the batch key; if exists -> no-op, return)
2. ZINCRBY  leaderboard:week:{weekId}  delta  playerId      # ranking
3. INCRBYFLOAT  pool:week:{weekId}  (delta * poolRate)      # running prize pool (poolRate from config, default 0.02)
4. XADD  stream:earnings:week:{weekId}  ...                 # enqueue for durability
```

Everything the user must see immediately ends here. Postgres and Mongo are **not touched**.

**Why synchronous triple-write is rejected:** it would bind earn latency to Postgres's slowest moment, couple availability across stores, and put Postgres on the hot path at 2M DAU. Money and ranking must not live inside the "user tapped" request.

### 3.3 Durability — asynchronous worker

A **Background process** runs a Redis **Streams consumer group** over `stream:earnings:week:{weekId}`:

- Drains the stream in batches.
- **Inserts raw events into Mongo `earning_events` first — idempotently.** Each event carries its batch `idempKey`; the **unique index on `idempKey`** rejects a redelivered event as a duplicate instead of inserting it twice. This insert is the worker's **idempotency gate**.
- **Accumulates only the newly-inserted events.** Within a short window (~500ms) the worker **merges the just-inserted events per player**, so the same player's N events collapse into one upsert that adds the summed delta to `weekly_scores.total_earned` **and** to `weeks.total_earned`. ~100k events/s reduces to far fewer DB operations. The pool is **not** accumulated here — it is derived once at close as `floor(total_earned × rate)` (§5.2.4), so no float rounding drift can build up.
- **Acks** each message.

**Why this is idempotent under at-least-once delivery:** a message can be redelivered if the worker crashes after writing but before `XACK`. The Redis Lua dedupe (§3.2) only stops a *client* from enqueuing the same batch twice; it does **not** prevent the consumer group from **redelivering** an already-enqueued entry. The unique `idempKey` index is therefore load-bearing, not decorative: because the Postgres accumulation is gated on the newly-inserted set, a redelivered message contributes nothing and money is never double-counted. Replay is safe.

**Why Redis Streams specifically:** the stack is fixed — no Kafka/RabbitMQ/SQS. The only stack-native durable queue is Redis Streams. Consumer group + ack gives at-least-once and replay, and is strictly better than list/pub-sub here. This is **not a preference, it is the natural consequence of the constraint** — and is justified as such.

**Accepted loss window (stated honestly):** if Redis is lost entirely after `ZINCRBY` but before the worker persists, events still in the stream are gone. This is bounded by **AOF persistence + a fast-consuming worker**; since Postgres is the source of truth, the system reconciles from there. For this system that window is acceptable and documented rather than hidden.

---

## 4. Read Path (Redis only)

| View | Operation | Notes |
| --- | --- | --- |
| **Top 100** | `ZREVRANGE leaderboard:week:{weekId} 0 99 WITHSCORES` | Served from a refreshed cache (below), not live per request. |
| **My rank** | `ZREVRANK leaderboard:week:{weekId} playerId` | Single call. |
| **My neighbours** (outside top 100) | `ZREVRANGE (rank-3) (rank+2) WITHSCORES` | 3 above + self + 2 below, fixed-cost single call, uncached. |
| **Scroll / explore** | `ZREVRANGE offset (offset+49) WITHSCORES` | Page size 50; **capped at top 1000**. |

### 4.1 Top-100 cache (the hottest read)

Top 100 is requested by up to 2M players on open and on poll; the answer is identical for everyone for ~1s. So:

- A **background refresher** recomputes the serialized top-100 JSON every ~1s and `SET`s it. The cache is never empty → **no cache stampede** (unlike plain TTL expiry, where 2M concurrent clients would all miss at once and storm `ZREVRANGE`). This turns N reads into ~1 `ZREVRANGE`/s.
- Optionally, each API instance keeps a **~1s in-process cache** of this derived, public JSON. It is derived public data (not session state), so caching it does not break statelessness and instances remain interchangeable. With this, most top-100 reads never even reach Redis.

The **personal window is per-user and uncached** — already one cheap call.

### 4.2 Scroll cap = top 1000

Scrollable exploration is capped at **top 1000** (configurable constant):

- The product value of manual exploration drops to ~zero after the first few hundred — nobody compares themselves to rank 1,500,000.
- It bounds worst-case offset, preventing someone from scripting a deep scroll to hammer Redis.
- "Find myself" is already handled by the personal window, which is **independent of the cap** and locates the player anywhere in 2M. Top 1000 = global exploration; personal window = self-location; the two complement each other.

### 4.3 Accepted read consistency

Offset-based pagination over a live set may show minor shifts while scrolling (a row appearing twice or skipped). For a live leaderboard this is normal and acceptable; the top 100 stays stable behind the ~1s cache, and no one expects millimetric consistency on lower pages. The frontend uses **virtualization** (only visible rows in the DOM — the legacy freeze came from rendering all rows) plus **prefetch** of the next page near the bottom.

---

## 5. Weekly Lifecycle

### 5.1 Time-derived week id (no swap)

The ZSET key is `leaderboard:week:{weekId}` where `weekId` is **derived from the clock** (ISO week, boundary **UTC Monday 00:00**, with a **configurable offset**).

- **No swap is needed.** Once the clock crosses the boundary, new earns naturally write to the new key; the old key freezes. The close job operates on the *previous*, now-frozen key.
- The tiny boundary race is eliminated by **clamping on the `weekId` carried in the payload**.
- The exact hour is configurable so product can align the reset with the **global activity trough**, which shrinks both the boundary race and the close job's load peak. One global boundary is mandatory because there is one shared board; UTC also removes all DST complexity.

### 5.2 Close job — barrier, then distribute (idempotent, single-runner)

Triggered by a **timer in the Background process**, guarded by a **leader lock** (Redis lock / Postgres advisory lock) so that with N background replicas, **exactly one** runs the close. Steps:

1. **Freeze + mark closing:** the previous `weekId` key already stopped receiving writes once the clock passed the boundary; set that week's `weeks.status = 'closing'`.
2. **Barrier — wait for the pipeline to fully drain.** Wait until that week's `stream:earnings:week:{weekId}` is **empty and fully acked**, so every earn has landed in Postgres. **Without this barrier the pool and totals would still be behind Redis and distribution would pay out with incomplete money.**
3. **Derive ranking from Postgres, not from the frozen ZSET:** `SELECT ... FROM weekly_scores WHERE week_id = ? ORDER BY total_earned DESC LIMIT 100` (indexed, cheap). The Redis ranking exists only for live UX; because money depends on rank, deriving the payout ranking from Postgres's authoritative totals eliminates the "Redis says X, Postgres says Y" edge case entirely.
4. **Compute pool** from Postgres's authoritative weekly total (money = source of truth, not the Redis counter).
5. **Distribute** (see 5.3), writing `reward_payouts` inside a **single transaction**.
6. **Archive** the final board to Mongo `leaderboard_snapshots` — the top-1000 `entries` (a second `ORDER BY total_earned DESC LIMIT 1000` from `weekly_scores`, matching the scroll cap §4.2) plus the top-100 `payouts`.
7. **Roll the remainder** into next week's pool, **clean up** the old Redis key, and set `weeks.status = 'closed'` (with `closed_at`).

**Idempotency:** keyed by `weekId`. If the job runs twice, the existing payout record for that week makes the second run a no-op — no double payout.

### 5.3 Distribution formula

- 1st = **20%**, 2nd = **15%**, 3rd = **10%** of the pool.
- Remaining **55%** across ranks **4–100** (97 players) weighted **linearly by rank**: `weight_i = (101 - rank_i)` (rank 4 → 97, …, rank 100 → 1), normalized over the band (sum = 4753). Concretely rank 4 ≈ 1.12% of the pool, rank 100 ≈ 0.012%.
- **Linear is deliberate.** The brief already imposes a sharp cliff between 3rd (10%) and 4th (~1.1%); that cliff is a **feature** — being on the podium should feel dramatically better. A front-loaded curve (e.g. `1/rank`) would soften the 3→4 cliff we want and flatten the middle, making ranks 50–100 meaningless. Linear is monotone, smooth, and defensible in one sentence: "higher ranks earn more, and no one is worthless next to their neighbour."
- An optional `k` exponent (`(101 - rank)^k`, default **`k = 1`**) is exposed as config if product later wants a more top-heavy curve, without changing code.

### 5.4 Remainder handling — roll over

Currency is distributed in whole units (cents). The leftover from rounding **rolls into next week's pool**.

- Preserves the money invariant: **no currency is created or destroyed** across all time (in = out).
- Auditable equality every week: **`sum(payouts) + rollover = pool`** — exactly what a reviewer wants to see in a money system.
- The rollover is at the cents level (a few units total), so "this week's pool = 2% + rollover" is negligible — a clean, honest rollover rather than arbitrary favouritism.

---

## 6. Process Topology

Two stateless, horizontally scalable process types from **one codebase**:

| Process | Responsibilities | Scaling |
| --- | --- | --- |
| **API** | Earn ingestion (hot-path Lua) + all reads | Horizontal, behind a load balancer |
| **Background** | (a) Stream **consumer-group worker** → Postgres/Mongo persist; (b) **scheduler/closer** with leader lock | Worker scales with write volume (5–10 replicas); closer runs on exactly one via the lock |

- Worker and closer are **combined into one Background unit** but kept as **separate modules**. Combining is free for correctness because the closer is leader-locked: however many background replicas run, only one executes the close, the rest fail to acquire the lock and do nothing. The close is short and weekly, so it never starves the worker loop.
- The modular split means that if the close ever gets heavy, it can be broken into its own deployable later. **Two deploy units now, splittable by design.**
- Nothing holds local state; the only "leader" state is the short-lived lock in Redis/Postgres.

### Durability baseline

- **Redis AOF** persistence to bound the loss window.
- **Postgres is the source of truth**; Redis (ranking, pool, idempotency) is **rebuildable** from `weekly_scores` + `earning_events` after any Redis loss.

---

## 7. Technology Stack

| Concern | Choice | Rationale |
| --- | --- | --- |
| Language | **TypeScript** (client + server) | Required; one type system end to end. |
| HTTP server | **Fastify** | Faster than Express, schema-first, suited to high throughput. |
| Validation | **Zod** | Earn payloads + config validation, inferred types. |
| Redis client | **ioredis** | First-class Lua scripting + Streams support. |
| Postgres access | **Drizzle** | SQL-close and type-safe. The two Postgres touch points (worker batch upserts, closer transaction + top-100 order-by) are hand-tuned specific queries — Drizzle's sweet spot. Avoids Prisma's bulk-upsert friction and query-engine weight. Reinforces the performance/scalability narrative. |
| MongoDB access | Official **mongodb** driver | Append-only writes; no ORM needed. |
| Packaging | **Docker** | Stateless containers for both process types. |
| Hosting | **PaaS** (Render / Railway) + **MongoDB Atlas** | See §8. |

---

## 8. Deployment & Cloud

**PaaS over hand-rolled AWS**, deliberately:

- The priority is a **reliably running, accessible domain**. A half-finished AWS setup (VPC, security groups, ECS task defs, RDS, ElastiCache, DocumentDB wired together) consumes days, and a broken AWS deploy scores worse than a working PaaS one.
- Docker + managed services on **Render / Railway / Fly** ships fast: managed Postgres + Redis ready, **Atlas** for Mongo (universal fallback; if a single provider can host all three, prefer that, confirmed at deploy time).
- The "cloud usage" criterion is met strongly on PaaS anyway: **stateless containers + managed data layer + horizontal scale** is cloud-native thinking.

**AWS-equivalent mapping** is documented (not built) to signal cloud-native fluency without spending days:

| This system | AWS equivalent |
| --- | --- |
| Stateless container | ECS (Fargate) task |
| Managed Postgres | RDS for PostgreSQL |
| Managed Redis | ElastiCache for Redis |
| MongoDB | DocumentDB / Atlas |
| Load balancer | ALB |

AWS is chosen only with ample time and comfort; for a take-home the risk/reward favours PaaS.

---

## 9. Cross-Cutting Concerns

- **Statelessness:** no process holds session/user state; the only shared state is in Redis/Postgres/Mongo and the short-lived leader lock. Any instance is interchangeable.
- **Idempotency:** end to end — client batch key → Lua dedupe → stream → worker upsert → weekly close keyed by `weekId`.
- **Anti-cheat:** server-side per-interval clamp at ingestion.
- **Observability:** stream lag (pending/acked) is the key health signal for the worker; the close job logs the auditable `sum(payouts) + rollover = pool` equality.
- **Sample data:** a seed script populates players and a week of `weekly_scores` / Redis ZSET so the board and personal-window flows are testable, as the brief requires.

---

## 10. Open Items (for later specs)

- **Frontend UI design** — the leaderboard screen (interactions, self-location, reward/status communication, mobile + PC). Separate spec; intentionally last.
- **API surface** — concrete endpoint contracts (earn, top-100, my-window, page) belong to the implementation plan.
- **Reusable React components** — to be defined in the frontend spec/plan.
