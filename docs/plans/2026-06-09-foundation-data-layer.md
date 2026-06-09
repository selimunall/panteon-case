# Foundation & Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the pnpm monorepo, the persistence layer (Postgres/Drizzle, Redis, Mongo), the shared types/config, the `weekId` time utility, the integration-test harness, and a seed script — so every later plan has a booting app, a migrated schema, and seedable sample data.

**Architecture:** A pnpm workspace with three packages — `shared` (types + Zod config), `server` (Fastify app + DB clients), and the existing `client`. Postgres is the source of truth (Drizzle schema from the data-model spec), Redis is the hot layer (ioredis), Mongo holds raw history (official driver). All data shapes come verbatim from `docs/specs/2026-06-09-data-model-design.md`; nothing here re-decides the architecture in `docs/specs/2026-06-09-architecture-design.md`.

**Tech Stack:** TypeScript (ESM), pnpm workspaces, Fastify, Zod, Drizzle ORM + drizzle-kit + node-postgres, ioredis, mongodb, Vitest, Docker Compose.

**Prerequisites for the engineer:** Docker Desktop running (the integration tests need Postgres/Redis/Mongo containers). Node ≥ 20, `pnpm` installed (`npm i -g pnpm`).

**Convention for every test task:** start the data stores once with `pnpm db:up` (Task 1) before running integration tests. The integration tests share the dev stores and assume a reasonably clean schema; if a re-run shows stale rows, reset with `pnpm db:reset && (cd server && pnpm db:migrate)` for a clean slate.

---

### Task 1: Monorepo skeleton + data stores + Vitest

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `docker-compose.yml`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Modify: `client/package.json` (rename package to `@panteon/client` — see step)

- [ ] **Step 1: Create the workspace manifest**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - 'shared'
  - 'server'
  - 'client'
```

- [ ] **Step 2: Create the root package.json**

Create `package.json`:

```json
{
  "name": "panteon-leaderboard",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "db:up": "docker compose up -d",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d",
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "~5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 3: Create the base tsconfig**

Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 4: Create the data stores compose file**

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: panteon
      POSTGRES_PASSWORD: panteon
      POSTGRES_DB: leaderboard
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U panteon -d leaderboard"]
      interval: 2s
      timeout: 3s
      retries: 20
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
  mongo:
    image: mongo:7
    ports: ["27017:27017"]
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 2s
      timeout: 3s
      retries: 20
```

- [ ] **Step 5: Create env example and gitignore**

Create `.env.example`:

```bash
DATABASE_URL=postgres://panteon:panteon@localhost:5432/leaderboard
REDIS_URL=redis://localhost:6379
MONGO_URL=mongodb://localhost:27017
MONGO_DB=leaderboard
PORT=3000
WEEK_RESET_OFFSET_HOURS=0
```

Create `.gitignore`:

```
node_modules/
dist/
.env
*.log
```

- [ ] **Step 6: Create the Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['{shared,server}/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

- [ ] **Step 7: Normalize the client package name**

In `client/package.json`, change the `"name"` field from `"client"` to `"@panteon/client"`. Leave everything else untouched.

- [ ] **Step 8: Install and bring stores up**

Run:
```bash
pnpm install
pnpm db:up
docker compose ps
```
Expected: `pnpm install` completes; `docker compose ps` shows `postgres`, `redis`, `mongo` all `healthy`.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json docker-compose.yml vitest.config.ts .env.example .gitignore client/package.json pnpm-lock.yaml
git commit -m "chore: monorepo skeleton, data stores, vitest harness"
```

---

### Task 2: Shared package — types + Zod config

**Files:**
- Create: `shared/package.json`
- Create: `shared/tsconfig.json`
- Create: `shared/src/types.ts`
- Create: `shared/src/config.ts`
- Create: `shared/src/index.ts`
- Test: `shared/src/config.test.ts`

- [ ] **Step 1: Create the package manifest and tsconfig**

Create `shared/package.json`:

```json
{
  "name": "@panteon/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "zod": "^3.23.0" }
}
```

Create `shared/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

> **Forward-looking note (not triggered in this plan):** `main`/`exports` point to `./src/index.ts`, which is correct for `tsx`/Vitest (they consume TypeScript directly), and nothing in this foundation imports `@panteon/shared` at runtime. Before a later plan runs the **production** server (`node dist/index.js`) while importing shared, the shared resolution must be settled: either build shared to `dist` and repoint `exports` to `./dist/index.js` (with `pnpm -r build` compiling shared first), or bundle the server (tsup/esbuild) / run it with `tsx`. Decide this in the server-wiring/deploy plan.

- [ ] **Step 2: Create the domain types**

Create `shared/src/types.ts` (verbatim from data-model spec §4):

```ts
import { z } from 'zod';

/** Client → server earn batch (architecture §3.1). */
export const EarnPayload = z.object({
  playerId: z.string().uuid(),
  delta: z.number().int().nonnegative(),
  weekId: z.string(),
  idempKey: z.string().uuid(),
  clientTs: z.number().int(),
});
export type EarnPayload = z.infer<typeof EarnPayload>;

export interface LeaderboardEntry {
  rank: number;
  playerId: string;
  displayName?: string;
  totalEarned: number;
}

export interface PlayerRankView {
  weekId: string;
  inTop100: boolean;
  player: LeaderboardEntry;
  neighbours: LeaderboardEntry[];
}
```

- [ ] **Step 3: Write the failing config test**

Create `shared/src/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Config } from './config.js';

describe('Config', () => {
  it('applies architecture defaults when given an empty object', () => {
    const c = Config.parse({ batch: { maxDeltaPerInterval: 1000 } });
    expect(c.pool.rate).toBe(0.02);
    expect(c.pool.top3).toEqual([0.2, 0.15, 0.1]);
    expect(c.pool.bandShare).toBe(0.55);
    expect(c.pool.curveExponent).toBe(1);
    expect(c.scroll.cap).toBe(1000);
    expect(c.scroll.pageSize).toBe(50);
    expect(c.week.timezone).toBe('UTC');
  });

  it('rejects a non-UTC timezone', () => {
    expect(() => Config.parse({ week: { timezone: 'Europe/Istanbul' }, batch: { maxDeltaPerInterval: 1 } }))
      .toThrow();
  });

  it('rejects pool shares that do not sum to 1', () => {
    expect(() => Config.parse({
      pool: { top3: [0.2, 0.15, 0.1], bandShare: 0.40 }, // 0.45 + 0.40 = 0.85 ≠ 1
      batch: { maxDeltaPerInterval: 1 },
    })).toThrow();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm vitest run shared/src/config.test.ts`
Expected: FAIL — cannot find module `./config.js`.

- [ ] **Step 5: Implement the config schema**

Create `shared/src/config.ts` (data-model spec §4 Config — note the section-level `.default({})` and `timezone.default('UTC')`, which let a partial/empty config parse; the spec carries the same defaults):

```ts
import { z } from 'zod';

export const Config = z.object({
  week: z.object({
    timezone: z.literal('UTC').default('UTC'),
    resetOffsetHours: z.number().default(0),
  }).default({}),
  pool: z.object({
    rate: z.number().default(0.02),
    top3: z.tuple([z.number(), z.number(), z.number()]).default([0.2, 0.15, 0.1]),
    bandShare: z.number().default(0.55),
    curveExponent: z.number().default(1),
  }).default({}),
  scroll: z.object({
    cap: z.number().int().default(1000),
    pageSize: z.number().int().default(50),
  }).default({}),
  batch: z.object({
    intervalMs: z.number().int().default(5000),
    maxDeltaPerInterval: z.number().int(),
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

- [ ] **Step 6: Create the barrel export**

Create `shared/src/index.ts`:

```ts
export * from './types.js';
export * from './config.js';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm vitest run shared/src/config.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 8: Commit**

```bash
git add shared
git commit -m "feat(shared): domain types and Zod config schema"
```

---

### Task 3: Server skeleton — Fastify app + env loader + health route

**Files:**
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/src/env.ts`
- Create: `server/src/app.ts`
- Create: `server/src/index.ts`
- Test: `server/src/env.test.ts`
- Test: `server/src/app.test.ts`

- [ ] **Step 1: Create the package manifest and tsconfig**

Create `server/package.json`:

```json
{
  "name": "@panteon/server",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "seed": "tsx src/db/seed.ts"
  },
  "dependencies": {
    "@panteon/shared": "workspace:*",
    "fastify": "^5.0.0",
    "drizzle-orm": "^0.36.0",
    "pg": "^8.13.0",
    "ioredis": "^5.4.0",
    "mongodb": "^6.10.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.28.0",
    "tsx": "^4.19.0",
    "@types/pg": "^8.11.0"
  }
}
```

Create `server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Run: `pnpm install` (links the workspace dependency).

- [ ] **Step 2: Write the failing env test**

Create `server/src/env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  MONGO_URL: 'mongodb://localhost:27017',
  MONGO_DB: 'leaderboard',
};

describe('loadEnv', () => {
  it('parses a valid environment', () => {
    const env = loadEnv({ ...base, PORT: '3000' });
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toContain('postgres://');
  });

  it('defaults PORT to 3000 when missing', () => {
    expect(loadEnv(base).PORT).toBe(3000);
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run server/src/env.test.ts`
Expected: FAIL — cannot find module `./env.js`.

- [ ] **Step 4: Implement the env loader**

Create `server/src/env.ts`:

```ts
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  MONGO_URL: z.string().url(),
  MONGO_DB: z.string().min(1),
  PORT: z.coerce.number().int().default(3000),
  WEEK_RESET_OFFSET_HOURS: z.coerce.number().default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run server/src/env.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 6: Write the failing app/health test**

Create `server/src/app.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildApp } from './app.js';

describe('buildApp', () => {
  it('GET /health returns ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm vitest run server/src/app.test.ts`
Expected: FAIL — cannot find module `./app.js`.

- [ ] **Step 8: Implement the Fastify app**

Create `server/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm vitest run server/src/app.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 10: Implement the entrypoint**

Create `server/src/index.ts`:

```ts
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();
const app = buildApp();

app.listen({ port: env.PORT, host: '0.0.0.0' })
  .then((addr) => console.log(`server listening on ${addr}`))
  .catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 11: Commit**

```bash
git add server pnpm-lock.yaml
git commit -m "feat(server): fastify skeleton, env loader, health route"
```

---

### Task 4: Postgres — Drizzle schema, connection, migration

**Files:**
- Create: `server/src/db/schema.ts`
- Create: `server/src/db/pg.ts`
- Create: `server/drizzle.config.ts`
- Create: `server/src/db/migrate.ts`
- Test: `server/src/db/schema.test.ts`

- [ ] **Step 1: Create the Drizzle schema**

Create `server/src/db/schema.ts` (verbatim from data-model spec §1):

```ts
import {
  pgTable, pgEnum, uuid, bigint, bigserial, text, integer,
  timestamp, primaryKey, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

export const weekStatus = pgEnum('week_status', ['active', 'closing', 'closed']);

export const players = pgTable('players', {
  id: uuid('id').primaryKey(),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const weeks = pgTable('weeks', {
  weekId: text('week_id').primaryKey(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: weekStatus('status').notNull().default('active'),
  totalEarned: bigint('total_earned', { mode: 'bigint' }).notNull().default(0n),
  rolloverIn: bigint('rollover_in', { mode: 'bigint' }).notNull().default(0n),
  poolTotal: bigint('pool_total', { mode: 'bigint' }).notNull().default(0n),
  rolloverOut: bigint('rollover_out', { mode: 'bigint' }).notNull().default(0n),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const weeklyScores = pgTable('weekly_scores', {
  weekId: text('week_id').notNull().references(() => weeks.weekId),
  playerId: uuid('player_id').notNull().references(() => players.id),
  totalEarned: bigint('total_earned', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.weekId, t.playerId] }),
  topRank: index('weekly_scores_week_total_desc_idx').on(t.weekId, t.totalEarned.desc()),
}));

export const rewardPayouts = pgTable('reward_payouts', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  weekId: text('week_id').notNull().references(() => weeks.weekId),
  playerId: uuid('player_id').notNull().references(() => players.id),
  rank: integer('rank').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  weekPlayer: uniqueIndex('reward_payouts_week_player_uq').on(t.weekId, t.playerId),
  weekRank: index('reward_payouts_week_rank_idx').on(t.weekId, t.rank),
}));
```

- [ ] **Step 2: Create the pg connection module**

Create `server/src/db/pg.ts`:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export function createPg(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export type Db = ReturnType<typeof createPg>['db'];
export { schema };
```

- [ ] **Step 3: Create the drizzle-kit config**

Create `server/drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://panteon:panteon@localhost:5432/leaderboard',
  },
});
```

- [ ] **Step 4: Generate the migration**

Run:
```bash
cd server && DATABASE_URL=postgres://panteon:panteon@localhost:5432/leaderboard pnpm db:generate && cd ..
```
Expected: a SQL file appears under `server/drizzle/` creating the enum and four tables. **Open the generated SQL and confirm `weekly_scores_week_total_desc_idx` orders `total_earned` DESC.** (drizzle-orm ≥ 0.31 emits column-level `.desc()` in indexes; if your version doesn't, change that index in `schema.ts` to ``index('weekly_scores_week_total_desc_idx').on(t.weekId, sql`${t.totalEarned} DESC`)`` and add `sql` to the `drizzle-orm` import, then regenerate.)

- [ ] **Step 5: Create the migration runner**

Create `server/src/db/migrate.ts`:

```ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: join(__dirname, '../../drizzle') });
  await pool.end();
}

// Allow `pnpm db:migrate` as a standalone script.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? 'postgres://panteon:panteon@localhost:5432/leaderboard';
  runMigrations(url).then(() => { console.log('migrated'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 6: Write the failing schema integration test**

Create `server/src/db/schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createPg } from './pg.js';
import { players } from './schema.js';
import { runMigrations } from './migrate.js';

const URL = process.env.DATABASE_URL ?? 'postgres://panteon:panteon@localhost:5432/leaderboard';
let ctx: ReturnType<typeof createPg>;

beforeAll(async () => {
  await runMigrations(URL);
  ctx = createPg(URL);
});
afterAll(async () => { await ctx.pool.end(); });

describe('schema', () => {
  it('inserts and reads a player', async () => {
    const id = randomUUID();
    await ctx.db.insert(players).values({ id, displayName: 'Tester' });
    const rows = await ctx.db.select().from(players).where(eq(players.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe('Tester');
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm db:up` (if not already up), then `pnpm vitest run server/src/db/schema.test.ts`
Expected: PASS (1 passing) — the migration generated in Step 4 is applied by `runMigrations` in the test's `beforeAll`. If it fails because of stale rows from a prior run, run `pnpm db:reset` and retry.

- [ ] **Step 8: Commit**

```bash
git add server/src/db server/drizzle.config.ts server/drizzle
git commit -m "feat(server): drizzle schema, pg connection, migrations"
```

---

### Task 5: Redis + Mongo client modules

**Files:**
- Create: `server/src/db/redis.ts`
- Create: `server/src/db/mongo.ts`
- Test: `server/src/db/redis.test.ts`
- Test: `server/src/db/mongo.test.ts`

> A composite `/ready` probe (pings Postgres + Redis + Mongo together) is intentionally deferred to the deployment plan, where the app is wired to live client instances. The `/health` liveness route from Task 3 is sufficient for the foundation.

- [ ] **Step 1: Create the Redis client module**

Create `server/src/db/redis.ts`:

```ts
import Redis from 'ioredis';

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
}
```

- [ ] **Step 2: Write the failing Redis test**

Create `server/src/db/redis.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createRedis } from './redis.js';

const redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
afterAll(async () => { await redis.quit(); });

describe('redis', () => {
  it('responds to ping', async () => {
    expect(await redis.ping()).toBe('PONG');
  });
  it('round-trips a sorted set', async () => {
    await redis.del('test:zset');
    await redis.zadd('test:zset', 10, 'a', 20, 'b');
    expect(await redis.zrevrange('test:zset', 0, 0)).toEqual(['b']);
  });
});
```

- [ ] **Step 3: Run the Redis test**

Run: `pnpm vitest run server/src/db/redis.test.ts`
Expected: PASS (2 passing) with Redis container up.

- [ ] **Step 4: Create the Mongo client module**

Create `server/src/db/mongo.ts`:

```ts
import { MongoClient, type Db as MongoDb } from 'mongodb';

export async function createMongo(url: string, dbName: string): Promise<{ client: MongoClient; db: MongoDb }> {
  const client = new MongoClient(url);
  await client.connect();
  return { client, db: client.db(dbName) };
}
```

- [ ] **Step 5: Write the failing Mongo test**

Create `server/src/db/mongo.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMongo } from './mongo.js';

let ctx: Awaited<ReturnType<typeof createMongo>>;
beforeAll(async () => {
  ctx = await createMongo(process.env.MONGO_URL ?? 'mongodb://localhost:27017', 'leaderboard_test');
});
afterAll(async () => { await ctx.client.close(); });

describe('mongo', () => {
  it('inserts and reads a document', async () => {
    const col = ctx.db.collection('ping');
    await col.deleteMany({});
    await col.insertOne({ ok: 1 });
    expect(await col.countDocuments()).toBe(1);
  });
});
```

- [ ] **Step 6: Run the Mongo test**

Run: `pnpm vitest run server/src/db/mongo.test.ts`
Expected: PASS (1 passing) with Mongo container up.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/redis.ts server/src/db/mongo.ts server/src/db/redis.test.ts server/src/db/mongo.test.ts
git commit -m "feat(server): redis and mongo client modules"
```

---

### Task 6: `weekId` time utility

**Files:**
- Create: `server/src/lib/week.ts`
- Test: `server/src/lib/week.test.ts`

This utility derives the time-based `weekId` and week window (architecture §5.1: ISO week, boundary UTC Monday 00:00 + configurable offset). Every later plan uses it.

- [ ] **Step 1: Write the failing week tests**

Create `server/src/lib/week.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { weekIdFor, weekWindow } from './week.js';

describe('weekIdFor', () => {
  it('formats an ISO week as YYYY-Www', () => {
    // 2026-06-08 is a Monday in ISO week 24 of 2026.
    expect(weekIdFor(new Date('2026-06-08T00:00:00Z'), 0)).toBe('2026-W24');
  });

  it('keeps Sunday in the same ISO week as the preceding Monday', () => {
    expect(weekIdFor(new Date('2026-06-14T23:59:00Z'), 0)).toBe('2026-W24');
  });

  it('rolls to the next week at Monday 00:00 UTC', () => {
    expect(weekIdFor(new Date('2026-06-15T00:00:00Z'), 0)).toBe('2026-W25');
  });

  it('shifts the boundary by the offset hours', () => {
    // With a +1h offset, 00:30 Monday still belongs to the previous week.
    expect(weekIdFor(new Date('2026-06-15T00:30:00Z'), 1)).toBe('2026-W24');
  });
});

describe('weekWindow', () => {
  it('returns a Monday-00:00-UTC start and a 7-day end', () => {
    const w = weekWindow('2026-W24', 0);
    expect(w.startsAt.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    expect(w.endsAt.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/src/lib/week.test.ts`
Expected: FAIL — cannot find module `./week.js`.

- [ ] **Step 3: Implement the week utility**

Create `server/src/lib/week.ts`:

```ts
/** ISO-week id (e.g. "2026-W24") for an instant, with a configurable hour offset. */
export function weekIdFor(now: Date, resetOffsetHours: number): string {
  const shifted = new Date(now.getTime() - resetOffsetHours * 3600_000);
  const { year, week } = isoWeek(shifted);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Start (inclusive) and end (exclusive) instants for a weekId. */
export function weekWindow(weekId: string, resetOffsetHours: number): { startsAt: Date; endsAt: Date } {
  const [yearStr, weekStr] = weekId.split('-W');
  const year = Number(yearStr);
  const week = Number(weekStr);
  const monday = isoWeekMonday(year, week);
  const startsAt = new Date(monday.getTime() + resetOffsetHours * 3600_000);
  const endsAt = new Date(startsAt.getTime() + 7 * 24 * 3600_000);
  return { startsAt, endsAt };
}

/** ISO-8601 week number and ISO week-year for a UTC instant. */
function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // ISO weekday: Mon=1..Sun=7. Shift to the Thursday of this week.
  const dayNum = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year, week };
}

/** The UTC Monday 00:00 that starts the given ISO week. */
function isoWeekMonday(isoYear: number, isoWeek: number): Date {
  // Jan 4th is always in ISO week 1.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  return new Date(week1Monday.getTime() + (isoWeek - 1) * 7 * 86400000);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run server/src/lib/week.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add server/src/lib
git commit -m "feat(server): ISO weekId + week window utility"
```

---

### Task 7: Seed script (sample data)

**Files:**
- Create: `server/src/db/seed.ts`
- Test: `server/src/db/seed.test.ts`

Seeds the current week: N players, their `weekly_scores`, the matching Redis ZSET, the `weeks` row, and a couple of `earning_events` — so every later plan and the UI have testable sample data (brief requirement).

- [ ] **Step 1: Write the failing seed test**

Create `server/src/db/seed.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runSeed } from './seed.js';
import { createPg } from './pg.js';
import { players, weeklyScores } from './schema.js';
import { eq } from 'drizzle-orm';
import { createRedis } from './redis.js';
import { runMigrations } from './migrate.js';

const PG = process.env.DATABASE_URL ?? 'postgres://panteon:panteon@localhost:5432/leaderboard';
const RD = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MG = process.env.MONGO_URL ?? 'mongodb://localhost:27017';

const ctx = createPg(PG);
const redis = createRedis(RD);
// Self-sufficient: migrate here so this test passes in isolation, independent of file order.
beforeAll(async () => { await runMigrations(PG); });
afterAll(async () => { await ctx.pool.end(); await redis.quit(); });

describe('runSeed', () => {
  it('populates Postgres and the Redis ZSET consistently', async () => {
    const { weekId, count } = await runSeed({ pgUrl: PG, redisUrl: RD, mongoUrl: MG, mongoDb: 'leaderboard_test', players: 250 });
    const pgPlayers = await ctx.db.select().from(players);
    const pgScores = await ctx.db.select().from(weeklyScores).where(eq(weeklyScores.weekId, weekId));
    const zcard = await redis.zcard(`leaderboard:week:${weekId}`);
    expect(count).toBe(250);
    expect(pgPlayers.length).toBeGreaterThanOrEqual(250);
    expect(pgScores.length).toBe(250);
    expect(zcard).toBe(250);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run server/src/db/seed.test.ts`
Expected: FAIL — cannot find module `./seed.js`.

- [ ] **Step 3: Implement the seed script**

Create `server/src/db/seed.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createPg } from './pg.js';
import { players, weeks, weeklyScores } from './schema.js';
import { createRedis } from './redis.js';
import { createMongo } from './mongo.js';
import { weekIdFor, weekWindow } from '../lib/week.js';

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
    // the seed leaves Postgres and Redis with the same 250 rows (no divergence/accumulation).
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

    await mongo.db.collection('earning_events').insertOne({
      weekId, playerId: playerRows[0]!.id, delta: 1000, idempKey: randomUUID(),
      clientTs: now, ingestedAt: now, streamId: 'seed-0',
    });

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm db:reset` (clean slate), then `cd server && pnpm db:migrate && cd ..`, then `pnpm vitest run server/src/db/seed.test.ts`
Expected: PASS (1 passing).

- [ ] **Step 5: Run the seed CLI end-to-end**

Run:
```bash
cd server && pnpm seed && cd ..
```
Expected: prints `seeded 500 players for 2026-Www`.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/seed.ts server/src/db/seed.test.ts
git commit -m "feat(server): sample-data seed script"
```

---

## Self-Review

**Spec coverage (data-model spec):**
- Drizzle schema for all four tables with exact PK/index/unique/constraints → Task 4 (verbatim). ✓
- Redis key patterns → `leaderboard:week:{weekId}` created in seed (Task 7) and exercised in Task 5; the remaining hot keys (`pool:`, `stream:`, `idemp:`, `rl:`, `cache:`) are created by later plans (write/read/lifecycle) — noted, not a gap for the foundation. ✓
- MongoDB collections → `earning_events` seeded (Task 7); `leaderboard_snapshots` is written by the lifecycle plan. ✓
- Shared types (`EarnPayload`, `LeaderboardEntry`, `PlayerRankView`, `Config`) → Task 2 (verbatim). ✓
- `weekId` = ISO-week string, UTC Monday + offset → Task 6. ✓
- Integer (`bigint`) currency, uuid player ids → Task 4 schema + Task 7 seed. ✓

**Placeholder scan:** No TODO/TBD; every code step contains complete content. ✓

**Type consistency:** `Config`/`EarnPayload` names match across Tasks 2/3; `createPg`/`createRedis`/`createMongo`/`runMigrations`/`runSeed`/`weekIdFor`/`weekWindow` signatures are used consistently in Tasks 4–7. `players`/`weeklyScores`/`weeks`/`rewardPayouts` table identifiers match the schema in Task 4. ✓

**Deferred to later plans (by design):** hot-path Lua + `/earn`, the durability worker, read endpoints, the weekly close job, and the frontend each have their own plan.
