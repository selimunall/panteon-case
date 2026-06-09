# Panteon Weekly Leaderboard — Data Model

- **Status:** Approved
- **Date:** 2026-06-09
- **Depends on:** `docs/specs/2026-06-09-architecture-design.md` (the approved architecture; source of truth). Nothing settled there is re-decided here.
- **Scope:** The persistent shapes only — Postgres (Drizzle), Redis key catalog, MongoDB documents, and the shared TypeScript types in `packages/shared`. No application code.

This spec turns the architecture's "one axis per store" principle into exact schemas:
Postgres holds the verified truth and money, Redis holds the live/hot shapes, Mongo holds
the raw history. Naming follows the architecture's key patterns verbatim.

**Resolved decisions** (previously open):
- **Player id = `uuid`.** Identity is assigned upstream; we mirror it. All reference columns and wire values use uuid.
- **Currency is integer (no decimals).** Earned currency is whole units, so every persisted money column is `bigint`. The only place a fraction appears is the `earned * rate` pool math, which is floored to an integer at close; the leftover is handled by the existing rollover mechanism (architecture §5.4).

---

## 1. PostgreSQL — Drizzle schema

Four tables: `players`, `weeks`, `weekly_scores`, `reward_payouts`. All money columns are
`bigint` (exact integer currency; aggregates for 2M players over a week stay far within the
64-bit range).

```ts
// packages/server/src/db/schema.ts  (Drizzle, drizzle-orm/pg-core)
import {
  pgTable, pgEnum, uuid, bigint, bigserial, text, integer,
  timestamp, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Week lifecycle states (architecture §5). */
export const weekStatus = pgEnum('week_status', ['active', 'closing', 'closed']);

/**
 * players — locally-owned reference of the upstream game's players.
 * Identity is assigned upstream, so `id` is a uuid with NO default (we store, not generate).
 */
export const players = pgTable('players', {
  id: uuid('id').primaryKey(),                                // externally assigned upstream
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * weeks — one row per weekly cycle. `week_id` is the time-derived ISO week
 * (e.g. "2026-W24" — the week of Mon 2026-06-08), used verbatim in every Redis key.
 * Auditable invariant after close: pool_total = floor(total_earned * poolRate) + rollover_in,
 * and sum(reward_payouts.amount) + rollover_out = pool_total.
 */
export const weeks = pgTable('weeks', {
  weekId: text('week_id').primaryKey(),                       // ISO week "YYYY-Www"
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: weekStatus('status').notNull().default('active'),
  totalEarned: bigint('total_earned', { mode: 'bigint' }).notNull().default(0n),
  rolloverIn: bigint('rollover_in', { mode: 'bigint' }).notNull().default(0n),
  poolTotal: bigint('pool_total', { mode: 'bigint' }).notNull().default(0n),
  rolloverOut: bigint('rollover_out', { mode: 'bigint' }).notNull().default(0n),
  closedAt: timestamp('closed_at', { withTimezone: true }),   // nullable until closed
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * weekly_scores — the authoritative per-player verified total for a week
 * (written by the durability worker via batch upsert).
 * PK (week_id, player_id); index (week_id, total_earned DESC) powers the
 * close-job top-100 query: ORDER BY total_earned DESC LIMIT 100.
 */
export const weeklyScores = pgTable('weekly_scores', {
  weekId: text('week_id').notNull().references(() => weeks.weekId),
  playerId: uuid('player_id').notNull().references(() => players.id),
  totalEarned: bigint('total_earned', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.weekId, t.playerId] }),
  topRank: index('weekly_scores_week_total_desc_idx').on(t.weekId, t.totalEarned.desc()),
}));

/**
 * reward_payouts — the immutable record of what each top-100 player was paid.
 * Surrogate PK + unique(week_id, player_id) makes a re-run of the close job a
 * no-op (idempotency). amount is integer currency.
 */
export const rewardPayouts = pgTable('reward_payouts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  weekId: text('week_id').notNull().references(() => weeks.weekId),
  playerId: uuid('player_id').notNull().references(() => players.id),
  rank: integer('rank').notNull(),                            // final rank 1..100
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  weekPlayer: uniqueIndex('reward_payouts_week_player_uq').on(t.weekId, t.playerId),
  weekRank: index('reward_payouts_week_rank_idx').on(t.weekId, t.rank),
}));
```

### Column reference

**players** — `id` uuid PK (not null, no default, externally assigned) · `display_name` text not null · `created_at` timestamptz not null default now().

**weeks** — `week_id` PK text · `starts_at`/`ends_at` timestamptz not null · `status` enum not null default `active` · `total_earned`/`rollover_in`/`pool_total`/`rollover_out` bigint not null default 0 · `closed_at` timestamptz **null** · `created_at` timestamptz not null default now().

**weekly_scores** — `week_id` FK→weeks not null · `player_id` uuid FK→players not null · `total_earned` bigint not null default 0 · `updated_at` timestamptz not null default now() · **PK (week_id, player_id)** · **index (week_id, total_earned DESC)**.

**reward_payouts** — `id` bigserial PK · `week_id` FK→weeks not null · `player_id` uuid FK→players not null · `rank` int not null · `amount` bigint not null · `created_at` timestamptz not null default now() · **unique (week_id, player_id)** · index (week_id, rank).

---

## 2. Redis — key catalog

Every key embeds `{weekId}` (the ISO week), so a week change moves all hot state to fresh
keys with no swap (architecture §5.1). "Cleaned by close job" = deleted after the week is
archived to Mongo.

| Key pattern | Type | Value | TTL |
| --- | --- | --- | --- |
| `leaderboard:week:{weekId}` | Sorted Set | member = `playerId` (uuid), score = weekly `total_earned` | none — deleted by close job after archive |
| `pool:week:{weekId}` | String (float) | **live, lossy** running pool for the UI, accumulated via `INCRBYFLOAT (delta * poolRate)`; the authoritative integer pool is computed at close from Postgres | none — deleted by close job |
| `stream:earnings:week:{weekId}` | Stream | entries `{ playerId, delta, idempKey, clientTs }`, consumed by the worker group | none — trimmed/deleted by close job after drain |
| `idemp:{idempKey}` | String | `"1"` marker, written `SET NX` in the hot-path Lua to dedupe a batch | **7 days** (configurable) — must outlive offline re-send within a week |
| `rl:{playerId}` | String (counter) | rate-limit count for the current window (`INCR` + `EXPIRE`) | = rate-limit window (~10s ≈ 2× the 5s batch interval, leaving headroom for retries) |
| `cache:leaderboard:week:{weekId}:top100` | String | serialized JSON array of the top-100 `LeaderboardEntry[]`, rewritten ~1s by the background refresher | **~2s** safety TTL (refresher keeps it warm → no stampede) |

Notes:
- The hot-path Lua touches only `idemp:*`, `leaderboard:week:*`, `pool:week:*`,
  `stream:earnings:week:*` — one atomic round-trip (architecture §3.2).
- `pool:week:*` is a **live display approximation** and may carry a fraction; it is part of the
  disposable hot layer. The **distributed** pool is `floor(total_earned * poolRate)`, an integer
  derived from Postgres at close, so all paid money stays whole (architecture §5.2–5.4).
- The personal-window read (`ZREVRANK` + `ZREVRANGE rank-3 … rank+2`) is computed live off
  `leaderboard:week:{weekId}`; it is **not** cached.
- A Redis consumer group (e.g. `cg:persist`) is created on `stream:earnings:week:{weekId}`;
  the group name is operational config, not stored data.
- Sorted-set scores are IEEE-754 doubles (53-bit integer precision). Per-player weekly totals
  stay well within 2^53 for an idle game, so live ranking is exact in practice; should a total
  ever exceed 2^53 the live score loses low-order precision, but the **payout ranking is derived
  from Postgres `bigint` at close** (architecture §5.2.3), so money is never affected.

---

## 3. MongoDB — document shapes

Two append-only collections. Mongo is the source of truth for **raw history/audit only**;
verified totals live in Postgres (architecture §2). All currency values are integers.

### `earning_events` — one document per raw stream entry (batch)

```jsonc
{
  "_id": "ObjectId",
  "weekId": "2026-W24",                                 // Mon 2026-06-08 is in ISO week 24
  "playerId": "0f8a1c4e-3b2d-4e5f-9a10-7c6b5d4e3f21",  // uuid, matches players.id
  "delta": 1500,                // integer currency in this batch
  "idempKey": "b1f2...uuid",    // batch idempotency key
  "clientTs": "2026-06-08T21:14:03.000Z",    // BSON Date; worker converts EarnPayload.clientTs (epoch ms) on persist
  "ingestedAt": "2026-06-08T21:14:03.480Z",  // when the worker persisted it
  "streamId": "1780953243480-0"              // source Redis stream id (replay/trace)
}
```

Indexes: `{ weekId: 1, playerId: 1 }` (per-player history / reconcile) and a **unique** index
on `{ idempKey: 1 }`. This unique index is the durability worker's **idempotency gate**: the
Redis Lua dedupe stops a *client* from enqueuing a batch twice, but consumer-group
**redelivery** can replay an already-enqueued entry, so only events newly inserted here (not
rejected as duplicates) are accumulated into Postgres — preventing double-counted money
(architecture §3.3).

### `leaderboard_snapshots` — one document per closed week (archive)

```jsonc
{
  "_id": "ObjectId",
  "weekId": "2026-W23",         // the prior, now-closed week (W24 is the active one above)
  "closedAt": "2026-06-08T00:00:12.000Z",   // closed just after the W23→W24 boundary (Mon 00:00 UTC)
  "poolTotal": 4820350,         // integer, = floor(totalEarned * rate) + rolloverIn
  "totalEarned": 241017500,     // integer (floor(241017500 * 0.02) = 4820350)
  "rolloverIn": 0,              // integer remainder carried in
  "rolloverOut": 41,            // integer remainder carried to next week
  "entries": [                  // final ranking, top 1000 (explorable range)
    { "rank": 1, "playerId": "0f8a1c4e-...", "totalEarned": 1820350 }
    // ...
  ],
  "payouts": [                  // top 100 only, mirrors reward_payouts
    { "rank": 1, "playerId": "0f8a1c4e-...", "amount": 964070 }
    // ...
  ]
}
```

Index: `{ weekId: 1 }` unique (one snapshot per week).

---

## 4. Shared TypeScript types (`packages/shared`)

These are the contracts the API, worker, client, and config all import.

```ts
// packages/shared/src/types.ts
import { z } from 'zod';

/** Client → server earn batch (architecture §3.1). */
export const EarnPayload = z.object({
  playerId: z.string().uuid(),
  delta: z.number().int().nonnegative(),   // integer currency since last sync
  weekId: z.string(),                      // ISO week, used for boundary clamping
  idempKey: z.string().uuid(),             // one per batch
  clientTs: z.number().int(),              // epoch ms
});
export type EarnPayload = z.infer<typeof EarnPayload>;

/** One row of the board. */
export interface LeaderboardEntry {
  rank: number;
  playerId: string;        // uuid
  displayName?: string;
  totalEarned: number;     // integer currency (JS number is safe for display values)
}

/** "My rank + neighbours" response (architecture §4). */
export interface PlayerRankView {
  weekId: string;
  inTop100: boolean;
  player: LeaderboardEntry;        // the requesting player
  neighbours: LeaderboardEntry[];  // 3 above + 2 below, when outside top 100
}

/** Runtime configuration (single source for all tunables in the architecture). */
export const Config = z.object({
  week: z.object({
    timezone: z.literal('UTC').default('UTC'),
    resetOffsetHours: z.number().default(0),   // offset from UTC Monday 00:00
  }).default({}),
  pool: z.object({
    rate: z.number().default(0.02),            // 2% of earnings
    top3: z.tuple([z.number(), z.number(), z.number()]).default([0.20, 0.15, 0.10]),
    bandShare: z.number().default(0.55),       // ranks 4..100
    curveExponent: z.number().default(1),      // k in (101 - rank)^k
  }).default({}),
  scroll: z.object({
    cap: z.number().int().default(1000),       // deepest explorable rank
    pageSize: z.number().int().default(50),
  }).default({}),
  batch: z.object({
    intervalMs: z.number().int().default(5000),
    maxDeltaPerInterval: z.number().int(),     // server-side anti-cheat clamp (required)
  }),
  cache: z.object({
    top100RefreshMs: z.number().int().default(1000),
    top100TtlMs: z.number().int().default(2000),
  }).default({}),
}).refine(
  (c) => Math.abs(c.pool.top3[0] + c.pool.top3[1] + c.pool.top3[2] + c.pool.bandShare - 1) < 1e-9,
  { message: 'pool.top3 + pool.bandShare must sum to 1 (the whole pool must be distributed)' },
);
export type Config = z.infer<typeof Config>;
```

> Persisted money is `bigint` in Postgres for exactness. View/wire types use `number` for
> display values (board totals, single-batch deltas), which stay well within the JS-safe
> integer range for an idle game; the authoritative integer money never leaves Postgres as a
> lossy `number`.

---

## 5. Assumptions made

- **Monorepo layout** (pnpm workspaces): server at `packages/server` (or `apps/server`),
  shared types at `packages/shared`. Client and server remain **separate, separately
  deployable packages** — consistent with the brief's "separate projects".
- **`week_id` is the ISO-week string** `"YYYY-Www"` (e.g. `2026-W23`) — human-readable,
  lexically sortable, and embeds directly into Redis keys.
- **`players` is a locally-owned reference table** (id + display name), populated from upstream
  / the seed script; we don't re-derive player identity.
- **`earning_events` stores one doc per raw stream entry** (the per-player 500ms merge applies
  only to Postgres upserts; Mongo keeps the raw batches).
- **`leaderboard_snapshots` stores top 1000 entries + top 100 payouts** — top 1000 matches the
  explorable scroll cap; the paid set is the top 100.
- **`idemp:*` TTL = 7 days** (configurable), chosen to outlive any plausible offline re-send
  window within a single week; **`rl:*` TTL ≈ 2× batch interval** (~10s).
- **`top100` cache TTL ≈ 2s** with a ~1s background refresher (stampede-free per architecture §4.1).
