# Panteon — Weekly Leaderboard

A weekly leaderboard for an idle/clicker game (10M+ players, ~2M DAU). Players earn currency all
week; each week starts fresh, the top earners climb, and at week's end **2% of everything earned**
is distributed to the top 100 — then the board and pool reset. The board feels **instant**: a
player sees the top 100, their own rank, and the players around them with no freeze.

- **Live UI:** prize pool, week countdown, your rank + neighbours, a top-3 podium, a virtualized
  list (smooth to rank 1000), and a **past-weeks** view (champions + your final standing/reward).
- **Stack (fixed by the brief):** Node.js · PostgreSQL · MongoDB · Redis · TypeScript.

## How it works (one axis per store)

- **Redis = speed.** The live ranking is a Sorted Set; reads (top 100 / my rank / neighbours)
  touch **Redis only**. An earn runs one atomic **Lua** script (idempotency → `ZINCRBY` → pool →
  `XADD` to a Stream). A background refresher keeps a stampede-free top-100 cache.
- **PostgreSQL = truth/money (ACID).** Verified per-player totals, week lifecycle, and payouts.
  Money is exact: the pool and payouts are integers derived from Postgres at close, with the
  invariant `sum(payouts) + rollover = pool`.
- **MongoDB = history.** Append-only `earning_events` (the raw log, deduped by `idempKey`) and a
  weekly `leaderboard_snapshots` archive.

A **Background worker** drains the Stream into Mongo + Postgres (at-least-once, idempotent). A
**leader-locked scheduler** closes each week: barrier (drain) → reconcile → distribute (20/15/10%
+ linear 4–100) → snapshot → open next week → clean up. Design docs live in `docs/specs/` and
`docs/plans/`; the AI workflow is in [`AI-WORKFLOW.md`](./AI-WORKFLOW.md).

---

## Run locally (dev)

Needs Docker + Node ≥ 20 + pnpm (`corepack enable`).

```bash
pnpm install
pnpm db:up                                   # postgres + redis + mongo
cp .env.example .env
cd server && pnpm db:migrate && pnpm seed && cd ..

# three terminals:
cd server && pnpm dev                         # API   (http://localhost:3000)
cd server && pnpm worker                      # background worker (persist + refresher + scheduler)
cd client && pnpm dev                         # UI    (http://localhost:5173)

# optional — a live-moving board + a past week to browse:
cd server && pnpm mock                         # simulated players keep the board moving
cd server && pnpm seed:history                 # fabricate a closed previous week
```

## Run the whole stack in Docker (one command)

Everything (stores + API + worker + client) in containers on an isolated network:

```bash
docker compose -f docker-compose.full.yml up --build              # base stack
docker compose -f docker-compose.full.yml --profile demo up --build   # + the mock load generator
```

Open **http://localhost:8088**. The `migrate` service runs migrations and seeds sample data
(current week + a closed past week) — all idempotent.

## Deploy to Render (accessible domain)

Render runs the API+worker as one self-seeding web service; MongoDB is **Atlas** (Render has no
managed Mongo). Postgres and Redis are managed by Render.

1. **MongoDB Atlas:** create a free M0 cluster, add a DB user, allow access from anywhere
   (`0.0.0.0/0`), and copy the `mongodb+srv://…` connection string.
2. **Push** this repo to GitHub (already done).
3. In Render: **New → Blueprint**, pick the repo. It reads [`render.yaml`](./render.yaml) and
   creates: `panteon-pg` (Postgres), `panteon-redis` (Key Value), `panteon-api` (Docker web,
   runs `start:all:prod`), `panteon-client` (static site).
4. On **panteon-api**, set the secret `MONGO_URL` to your Atlas string. It deploys, migrates, and
   seeds itself on boot. Note its URL (e.g. `https://panteon-api-xxxx.onrender.com`).
5. On **panteon-client**, set `VITE_API_BASE` to that API URL, then redeploy (the build bakes it
   in). The client URL is your **accessible domain**.

> Free tier note: services sleep after ~15 min idle and cold-start on the next request. In
> production the API and worker are separate, independently scalable services (see
> `docker-compose.full.yml`); they're combined here only to fit the free plan.
