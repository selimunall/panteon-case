# Write Path Implementation Plan

> **Methodology:** Implementation-first (the team dropped TDD for this project). Each task writes the real code and is verified by `tsc --noEmit` plus a live run against the Docker stores. **Tests are written last**, in the final testing pass (Task 6 lists the cases). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept client earn batches and apply them on the hot path in a single atomic Redis round-trip — idempotent, rate-limited, anti-cheat-clamped — writing the live ranking, the running pool, and the durability stream, without touching Postgres or Mongo.

**Architecture:** A `POST /earn` Fastify route validates the batch (`EarnPayload`), clamps it to the current week and a per-interval max, rate-limits per player, then runs **one Lua script** that atomically does `SET NX` (idempotency) → `ZINCRBY` (ranking) → `INCRBYFLOAT` (pool) → `XADD` (stream). Reads/durability are out of scope (later plans). See `docs/specs/2026-06-09-architecture-design.md` §3 and `docs/specs/2026-06-09-data-model-design.md` §2.

**Tech Stack:** Fastify, ioredis (`defineCommand` for the Lua script), Zod (`@panteon/shared`), the existing `weekIdFor` util.

**Depends on:** Plan 1 (foundation) — `createRedis`, `loadEnv`, `buildApp`, `weekIdFor`, `Config`, `EarnPayload` all exist.

**Prerequisite:** `pnpm db:up` (Redis must be running for the live verification in Task 5).

---

## File map

| File | Responsibility |
| --- | --- |
| `server/src/lib/keys.ts` (new) | Single source for every Redis key string (`leaderboard:`, `pool:`, `stream:`, `idemp:`, `rl:`). |
| `server/src/env.ts` (modify) | Add `MAX_DELTA_PER_INTERVAL`, `IDEMP_TTL_SEC`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SEC`. |
| `server/src/config.ts` (new) | `loadConfig(env)` → a validated `Config` (fills `batch.maxDeltaPerInterval`, `week.resetOffsetHours`). |
| `server/src/services/earn.ts` (new) | The earn Lua script, `registerEarnCommand`, and `applyEarn`. |
| `server/src/lib/rateLimit.ts` (new) | `checkRateLimit(redis, playerId, env)` per-player sliding counter. |
| `server/src/routes/earn.ts` (new) | `POST /earn` handler: validate → week clamp → delta clamp → rate-limit → apply. |
| `server/src/app.ts` (modify) | `buildApp(deps)` takes `{ redis, config, env }` and registers the earn route. |
| `server/src/index.ts` (modify) | Build redis, register the command, load config, pass deps to `buildApp`. |

---

### Task 1: Redis key helpers + env + server config loader

**Files:** Create `server/src/lib/keys.ts`, `server/src/config.ts`; modify `server/src/env.ts`.

- [ ] **Step 1: Create the key helpers**

Create `server/src/lib/keys.ts`:

```ts
/** Single source of truth for every Redis key string (data-model spec §2). */
export const leaderboardKey = (weekId: string): string => `leaderboard:week:${weekId}`;
export const poolKey = (weekId: string): string => `pool:week:${weekId}`;
export const streamKey = (weekId: string): string => `stream:earnings:week:${weekId}`;
export const idempRedisKey = (idempKey: string): string => `idemp:${idempKey}`;
export const rateLimitKey = (playerId: string): string => `rl:${playerId}`;
```

- [ ] **Step 2: Extend the env schema**

In `server/src/env.ts`, add the four fields to `EnvSchema` (keep the existing ones):

```ts
const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MONGO_URL: z.string().url(),
  MONGO_DB: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  WEEK_RESET_OFFSET_HOURS: z.coerce.number().default(0),
  MAX_DELTA_PER_INTERVAL: z.coerce.number().int().default(1_000_000),
  IDEMP_TTL_SEC: z.coerce.number().int().default(604800), // 7 days
  RATE_LIMIT_MAX: z.coerce.number().int().default(10),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().default(10),
});
```

- [ ] **Step 3: Create the server config loader**

Create `server/src/config.ts`:

```ts
import { Config } from '@panteon/shared';
import type { Env } from './env.js';

/** Builds the validated runtime Config from env (fills the required clamp + offset). */
export function loadConfig(env: Env): Config {
  return Config.parse({
    week: { resetOffsetHours: env.WEEK_RESET_OFFSET_HOURS },
    batch: { maxDeltaPerInterval: env.MAX_DELTA_PER_INTERVAL },
  });
}
```

- [ ] **Step 4: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/lib/keys.ts server/src/config.ts server/src/env.ts
git commit -m "feat(server): redis key helpers, earn env vars, config loader"
```

---

### Task 2: Earn Lua script + earn service

**Files:** Create `server/src/services/earn.ts`.

- [ ] **Step 1: Create the earn service (Lua + command registration + apply)**

Create `server/src/services/earn.ts`:

```ts
import type Redis from 'ioredis';
import { leaderboardKey, poolKey, streamKey, idempRedisKey } from '../lib/keys.js';

/**
 * Atomic hot path (architecture §3.2). One round-trip:
 *   KEYS[1]=idemp key  KEYS[2]=zset  KEYS[3]=pool  KEYS[4]=stream
 *   ARGV[1]=playerId ARGV[2]=delta ARGV[3]=poolRate ARGV[4]=idempTtlSec
 *   ARGV[5]=clientTs ARGV[6]=idempKeyRaw
 * Returns 1 if applied, 0 if this batch was already processed (duplicate).
 */
const EARN_LUA = `
local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', tonumber(ARGV[4]))
if not fresh then
  return 0
end
local delta = tonumber(ARGV[2])
redis.call('ZINCRBY', KEYS[2], delta, ARGV[1])
redis.call('INCRBYFLOAT', KEYS[3], delta * tonumber(ARGV[3]))
redis.call('XADD', KEYS[4], '*',
  'playerId', ARGV[1], 'delta', ARGV[2], 'idempKey', ARGV[6], 'clientTs', ARGV[5])
return 1
`;

/** ioredis command added by defineCommand — declared so callers stay typed. */
type EarnRedis = Redis & {
  earnApply(
    idempKey: string, zset: string, pool: string, stream: string,
    playerId: string, delta: string, poolRate: string, idempTtlSec: string,
    clientTs: string, idempKeyRaw: string,
  ): Promise<number>;
};

export function registerEarnCommand(redis: Redis): void {
  redis.defineCommand('earnApply', { numberOfKeys: 4, lua: EARN_LUA });
}

export interface EarnInput {
  weekId: string;
  playerId: string;
  delta: number;
  idempotencyKey: string;
  clientTs: number;
  poolRate: number;
  idempTtlSec: number;
}

/** Runs the atomic script. Returns true if applied, false if duplicate. */
export async function applyEarn(redis: Redis, input: EarnInput): Promise<boolean> {
  const r = redis as EarnRedis;
  const applied = await r.earnApply(
    idempRedisKey(input.idempotencyKey),
    leaderboardKey(input.weekId),
    poolKey(input.weekId),
    streamKey(input.weekId),
    input.playerId,
    String(input.delta),
    String(input.poolRate),
    String(input.idempTtlSec),
    String(input.clientTs),
    input.idempotencyKey,
  );
  return applied === 1;
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/services/earn.ts
git commit -m "feat(server): atomic earn Lua script (idempotency/zincrby/pool/xadd)"
```

---

### Task 3: Rate-limit helper

**Files:** Create `server/src/lib/rateLimit.ts`.

- [ ] **Step 1: Create the rate-limit helper**

Create `server/src/lib/rateLimit.ts`:

```ts
import type Redis from 'ioredis';
import type { Env } from '../env.js';
import { rateLimitKey } from './keys.js';

/** Fixed-window per-player counter. Returns true if the request is within budget. */
export async function checkRateLimit(redis: Redis, playerId: string, env: Env): Promise<boolean> {
  const key = rateLimitKey(playerId);
  const n = await redis.incr(key);
  if (n === 1) {
    await redis.expire(key, env.RATE_LIMIT_WINDOW_SEC);
  }
  return n <= env.RATE_LIMIT_MAX;
}
```

- [ ] **Step 2: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/lib/rateLimit.ts
git commit -m "feat(server): per-player fixed-window rate limit"
```

---

### Task 4: `/earn` route + app wiring

**Files:** Create `server/src/routes/earn.ts`; modify `server/src/app.ts`, `server/src/index.ts`.

- [ ] **Step 1: Create the earn route**

Create `server/src/routes/earn.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import { EarnPayload, type Config } from '@panteon/shared';
import type { Env } from '../env.js';
import { weekIdFor } from '../lib/week.js';
import { applyEarn } from '../services/earn.js';
import { checkRateLimit } from '../lib/rateLimit.js';

export interface EarnDeps { redis: Redis; config: Config; env: Env; }

export function registerEarnRoute(app: FastifyInstance, deps: EarnDeps): void {
  app.post('/earn', async (req, reply) => {
    const parsed = EarnPayload.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', issues: parsed.error.issues });
    }
    const body = parsed.data;

    // Week-boundary clamp: only the current week accepts earns (architecture §5.1).
    const currentWeek = weekIdFor(new Date(), deps.env.WEEK_RESET_OFFSET_HOURS);
    if (body.weekId !== currentWeek) {
      return reply.code(409).send({ error: 'stale_week', currentWeek });
    }

    // Anti-cheat clamp: no batch may exceed the per-interval maximum.
    if (body.delta > deps.config.batch.maxDeltaPerInterval) {
      return reply.code(400).send({ error: 'delta_too_large', max: deps.config.batch.maxDeltaPerInterval });
    }

    // Per-player rate limit.
    const allowed = await checkRateLimit(deps.redis, body.playerId, deps.env);
    if (!allowed) {
      return reply.code(429).send({ error: 'rate_limited' });
    }

    const applied = await applyEarn(deps.redis, {
      weekId: currentWeek,
      playerId: body.playerId,
      delta: body.delta,
      idempotencyKey: body.idempKey,
      clientTs: body.clientTs,
      poolRate: deps.config.pool.rate,
      idempTtlSec: deps.env.IDEMP_TTL_SEC,
    });

    return reply.code(200).send({ applied, weekId: currentWeek });
  });
}
```

- [ ] **Step 2: Refactor `buildApp` to take dependencies**

Replace `server/src/app.ts` with:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type { Config } from '@panteon/shared';
import type { Env } from './env.js';
import { registerEarnRoute } from './routes/earn.js';

export interface AppDeps { redis: Redis; config: Config; env: Env; }

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));
  registerEarnRoute(app, deps);
  return app;
}
```

- [ ] **Step 3: Update the entrypoint to construct dependencies**

Replace `server/src/index.ts` with:

```ts
import { buildApp } from './app.js';
import { loadEnv } from './env.js';
import { loadConfig } from './config.js';
import { createRedis } from './db/redis.js';
import { registerEarnCommand } from './services/earn.js';

const env = loadEnv();
const config = loadConfig(env);
const redis = createRedis(env.REDIS_URL);
registerEarnCommand(redis);

const app = buildApp({ redis, config, env });

app.listen({ port: env.PORT, host: '0.0.0.0' })
  .then((addr) => console.log(`server listening on ${addr}`))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Type-check and commit**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
git add server/src/routes/earn.ts server/src/app.ts server/src/index.ts
git commit -m "feat(server): POST /earn route with week/delta clamps + wiring"
```

---

### Task 5: Live verification (manual, end-to-end)

No automated tests yet — verify the real behavior against the Docker stores.

- [ ] **Step 1: Start stores and seed a week**

```bash
pnpm db:up
cd server && npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && cd ..
```
Expected: `migrated` then `seeded 500 players for <weekId>`. Note the printed `weekId`.

- [ ] **Step 2: Boot the server**

```bash
cd server && npx tsx src/index.ts
```
Expected: `server listening on http://0.0.0.0:3000`. Leave it running; use a second terminal for the curls.

- [ ] **Step 3: Post an earn for a fresh player and confirm it applies**

Replace `<weekId>` with the seeded week; pick any UUIDs:

```bash
curl -s -X POST localhost:3000/earn -H 'content-type: application/json' -d '{
  "playerId":"11111111-1111-1111-1111-111111111111",
  "delta":5000,
  "weekId":"<weekId>",
  "idempKey":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "clientTs":1717880043480
}'
```
Expected: `{"applied":true,"weekId":"<weekId>"}`.

- [ ] **Step 4: Confirm the four Redis effects**

```bash
docker exec panteon-leaderboard-redis-1 redis-cli zscore leaderboard:week:<weekId> 11111111-1111-1111-1111-111111111111   # -> 5000
docker exec panteon-leaderboard-redis-1 redis-cli get pool:week:<weekId>                                                  # -> grew by 100 (5000*0.02)
docker exec panteon-leaderboard-redis-1 redis-cli xlen stream:earnings:week:<weekId>                                      # -> 1
docker exec panteon-leaderboard-redis-1 redis-cli get idemp:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa                          # -> "1"
```

- [ ] **Step 5: Re-post the same batch — idempotency holds**

Repeat the Step 3 curl verbatim. Expected: `{"applied":false,...}`. Re-check `zscore` (still 5000) and `xlen` (still 1) — no double count.

- [ ] **Step 6: Clamp and stale-week rejections**

```bash
# delta over the max -> 400 delta_too_large
curl -s -X POST localhost:3000/earn -H 'content-type: application/json' -d '{"playerId":"11111111-1111-1111-1111-111111111111","delta":999999999,"weekId":"<weekId>","idempKey":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","clientTs":1}'
# wrong week -> 409 stale_week
curl -s -X POST localhost:3000/earn -H 'content-type: application/json' -d '{"playerId":"11111111-1111-1111-1111-111111111111","delta":1,"weekId":"1999-W01","idempKey":"cccccccc-cccc-cccc-cccc-cccccccccccc","clientTs":1}'
```
Expected: first → `{"error":"delta_too_large",...}`; second → `{"error":"stale_week",...}`.

- [ ] **Step 7: Stop the server** (Ctrl-C). No commit (verification only).

---

### Task 6: Tests (deferred to the final testing pass)

When the project reaches its testing phase, cover at least:

- **`weekIdFor` clamp** — already verified manually; add a unit assertion.
- **`applyEarn` (integration, Redis up):** fresh batch → `true`, ZSET/pool/stream updated; same `idempKey` → `false`, no double count; `idemp:` key has a TTL.
- **`checkRateLimit`:** first `RATE_LIMIT_MAX` calls return `true`, the next returns `false`; key expires after the window.
- **`POST /earn` (via `app.inject`):** invalid payload → 400; `delta > max` → 400; wrong week → 409; over rate limit → 429; happy path → 200 `{applied:true}`; duplicate → 200 `{applied:false}`.
- **`loadConfig`:** required `maxDeltaPerInterval` comes from env; pool shares still satisfy the `Config` refine.

---

## Self-Review

**Spec coverage (architecture §3):**
- Client batch contract (`EarnPayload`) validated at the route → Task 4. ✓
- Single atomic Lua: idempotency `SET NX` → `ZINCRBY` → `INCRBYFLOAT` pool → `XADD` stream → Task 2. ✓
- Idempotency key per batch, deduped before the stream → Task 2 (the `SET NX` short-circuits). ✓
- Server-side clamp (per-interval max) → Task 4. ✓
- Rate-limit counter (`rl:` key) → Task 3. ✓
- Reads/durability untouched (Redis only on this path) → no Postgres/Mongo imports in Tasks 2–4. ✓
- `pool:` is the live float counter; authoritative integer pool is computed at close (later plan) — consistent. ✓

**Type consistency:** `applyEarn`/`registerEarnCommand` (Task 2), `checkRateLimit` (Task 3), `registerEarnRoute`/`buildApp`/`AppDeps` (Task 4) signatures line up; key helpers (Task 1) are the only place key strings are built. `EarnPayload`/`Config` come from `@panteon/shared`.

**Deferred by design:** the durability worker that drains `stream:earnings:week:*` into Mongo/Postgres is Plan 3; all automated tests are Task 6.
