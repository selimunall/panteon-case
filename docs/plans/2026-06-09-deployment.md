# Deployment Implementation Plan

> **Methodology:** Implementation-first. Containers verified by building + running the **full stack in Docker** (`docker compose -f docker-compose.full.yml up`) and browsing the app. PaaS deploy is declarative config (`render.yaml`) + documented steps the owner runs with their own accounts. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the whole system as containers — API, Background worker, and the client — so it runs with one command locally and deploys to a PaaS on an **accessible domain** (the brief's delivery requirement), with managed Postgres/Redis and MongoDB Atlas.

**Architecture:** One **server image** (API + worker share it; different commands) and one **client image** (Vite build served by nginx, which also proxies `/api`). A one-shot **migrate+seed** service runs before the app. Locally a `docker-compose.full.yml` wires stores + migrate + api + worker + client. On PaaS, `render.yaml` declares the same services against managed Postgres/Redis + Atlas. The server runs via **tsx** in the container (no separate build step) — this is the chosen resolution for the `@panteon/shared` workspace import (tsx resolves the TS workspace directly), the open item flagged back in Plan 1.

**Tech Stack:** Docker (multi-stage), nginx, `@fastify/cors` (cross-origin when client and API are separate domains), Render Blueprint (or Railway).

**Depends on:** Plans 1–8 (the running system).

---

## Key decisions

- **Server runs via `tsx` in the container.** No `dist` build; the container has the full pnpm workspace so `@panteon/shared` resolves from source. Simplest robust answer to Plan 1's "shared production resolution" note.
- **API + worker = one image, two commands.** `start:prod` (API) and `worker:prod` (worker). Smaller surface, identical deps.
- **Client = nginx serving the static build + proxying `/api`.** Locally nginx proxies to `api:3000` (same-origin, no CORS). On PaaS where services have separate domains, the client is built with `VITE_API_BASE=<api public url>` and the API enables **CORS**. Both modes supported.
- **Migrations run once** in a dedicated `migrate` service (also seeds sample data for the demo), not on every API boot — avoids replica races.

---

## File map

| File | Responsibility |
| --- | --- |
| `docker/server.Dockerfile` (new) | Build the workspace, run API/worker/migrate via tsx. |
| `docker/client.Dockerfile` (new) | Multi-stage: Vite build → nginx static + `/api` proxy. |
| `docker/nginx.conf` (new) | Serve the SPA, proxy `/api/` → the API. |
| `.dockerignore` (new) | Keep `node_modules`/`dist`/`.git` out of the build context. |
| `server/package.json` (modify) | Add `start:prod`, `worker:prod`, `migrate:prod`, `seed:prod` (env from the environment, no `--env-file`). |
| `server/src/app.ts` (modify) | Register `@fastify/cors`. |
| `docker-compose.full.yml` (new) | Whole stack in containers (stores + migrate + api + worker + client). |
| `render.yaml` (new) | Render Blueprint: api (web) + worker + client (web) + managed Postgres/Redis; Atlas via env. |
| `README.md` (modify) | Run-locally-in-Docker + deploy steps. |

---

### Task 1: Server image + prod scripts + CORS

**Files:** create `docker/server.Dockerfile`, `.dockerignore`; modify `server/package.json`, `server/src/app.ts`.

- [ ] **Step 1: Prod scripts (env from the container, no `--env-file`)**

Add to `server/package.json` scripts:

```json
    "start:prod": "tsx src/index.ts",
    "worker:prod": "tsx src/worker.ts",
    "migrate:prod": "tsx src/db/migrate.ts",
    "seed:prod": "tsx src/db/seed.ts"
```

- [ ] **Step 2: CORS (for the separate-domain PaaS case)**

Add the dependency: `pnpm --filter @panteon/server add @fastify/cors`. In `server/src/app.ts`, register it before the routes:

```ts
import cors from '@fastify/cors';
// inside buildApp, right after `const app = Fastify(...)`:
  app.register(cors, { origin: deps.env.CORS_ORIGIN === '*' ? true : deps.env.CORS_ORIGIN.split(',') });
```

Add `CORS_ORIGIN: z.string().default('*')` to `server/src/env.ts`'s `EnvSchema`.

- [ ] **Step 3: Server Dockerfile**

Create `docker/server.Dockerfile`:

```dockerfile
FROM node:20-slim
WORKDIR /app
RUN corepack enable
# install deps against the workspace manifests (better layer caching)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile
# source
COPY shared ./shared
COPY server ./server
ENV NODE_ENV=production
EXPOSE 3000
# default = API; worker/migrate override `command`
CMD ["pnpm", "--filter", "@panteon/server", "start:prod"]
```

- [ ] **Step 4: .dockerignore**

Create `.dockerignore`:

```
**/node_modules
**/dist
.git
client/dist
*.log
.env
docs
```

- [ ] **Step 5: Type-check + build the image**

```bash
cd server && npx tsc --noEmit -p tsconfig.json && cd ..
docker build -f docker/server.Dockerfile -t panteon-server .
```
Expected: tsc clean; the image builds.

- [ ] **Step 6: Commit**

```bash
git add docker/server.Dockerfile .dockerignore server/package.json server/src/app.ts server/src/env.ts pnpm-lock.yaml
git commit -m "build: server container (tsx runtime) + prod scripts + CORS"
```

---

### Task 2: Client image (nginx)

**Files:** create `docker/client.Dockerfile`, `docker/nginx.conf`.

- [ ] **Step 1: nginx config (serve SPA + proxy /api)**

Create `docker/nginx.conf`:

```nginx
server {
  listen 80;
  server_name _;
  root /usr/share/nginx/html;

  # API proxy (same-origin) — used when VITE_API_BASE is left as /api
  location /api/ {
    proxy_pass ${API_UPSTREAM}/;
    proxy_set_header Host $host;
  }

  location / {
    try_files $uri /index.html;
  }
}
```

- [ ] **Step 2: Client Dockerfile (multi-stage)**

Create `docker/client.Dockerfile`:

```dockerfile
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/
RUN pnpm install --frozen-lockfile
COPY shared ./shared
COPY client ./client
# unset → client uses "/api" (nginx proxy); set → direct cross-origin calls to the API
ARG VITE_API_BASE=""
ENV VITE_API_BASE=$VITE_API_BASE
RUN pnpm --filter @panteon/client build

FROM nginx:alpine
ENV API_UPSTREAM=http://api:3000
COPY docker/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
```

(The `nginx:alpine` image renders `/etc/nginx/templates/*.template` with env vars at start, so `${API_UPSTREAM}` is substituted — point it at `api:3000` locally or the API's internal URL on PaaS.)

- [ ] **Step 3: Build the image**

```bash
docker build -f docker/client.Dockerfile -t panteon-client .
```
Expected: the image builds (Vite build succeeds).

- [ ] **Step 4: Commit**

```bash
git add docker/client.Dockerfile docker/nginx.conf
git commit -m "build: client container (vite build + nginx static/api proxy)"
```

---

### Task 3: Full-stack docker-compose

**Files:** create `docker-compose.full.yml`.

- [ ] **Step 1: Compose the whole system**

Create `docker-compose.full.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: panteon, POSTGRES_PASSWORD: panteon, POSTGRES_DB: leaderboard }
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U panteon -d leaderboard"], interval: 2s, timeout: 3s, retries: 20 }
  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 2s, timeout: 3s, retries: 20 }
  mongo:
    image: mongo:7
    healthcheck: { test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"], interval: 2s, timeout: 3s, retries: 20 }

  migrate:
    build: { context: ., dockerfile: docker/server.Dockerfile }
    command: sh -c "pnpm --filter @panteon/server migrate:prod && pnpm --filter @panteon/server seed:prod"
    environment: &appenv
      DATABASE_URL: postgres://panteon:panteon@postgres:5432/leaderboard
      REDIS_URL: redis://redis:6379
      MONGO_URL: mongodb://mongo:27017
      MONGO_DB: leaderboard
      PORT: "3000"
      CORS_ORIGIN: "*"
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      mongo: { condition: service_healthy }

  api:
    build: { context: ., dockerfile: docker/server.Dockerfile }
    command: pnpm --filter @panteon/server start:prod
    environment: *appenv
    ports: ["3000:3000"]
    depends_on:
      migrate: { condition: service_completed_successfully }

  worker:
    build: { context: ., dockerfile: docker/server.Dockerfile }
    command: pnpm --filter @panteon/server worker:prod
    environment: *appenv
    depends_on:
      migrate: { condition: service_completed_successfully }

  client:
    build: { context: ., dockerfile: docker/client.Dockerfile }
    environment: { API_UPSTREAM: http://api:3000 }
    ports: ["8080:80"]
    depends_on: [api]
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.full.yml
git commit -m "build: full-stack docker-compose (stores + migrate + api + worker + client)"
```

---

### Task 4: Verify the whole stack in Docker

- [ ] **Step 1: Bring everything up (containers only)**

```bash
# stop the host-run dev processes + the stores-only compose first
docker compose down 2>/dev/null
docker compose -f docker-compose.full.yml up --build -d
docker compose -f docker-compose.full.yml ps
```
Expected: `postgres/redis/mongo` healthy, `migrate` exited 0, `api`/`worker`/`client` running.

- [ ] **Step 2: Hit it**

```bash
curl -s localhost:3000/health                      # {"status":"ok"} (API container)
curl -s localhost:8080/api/leaderboard/status      # proxied through the client's nginx
curl -s localhost:8080/ | grep -o '<title>.*</title>'
```
Open **http://localhost:8080** — the full app, served entirely from containers. (Optionally run the mock against `localhost:3000` to see it move.)

- [ ] **Step 3: Tear down**

```bash
docker compose -f docker-compose.full.yml down
```

- [ ] **Step 4: No commit (verification only).**

---

### Task 5: PaaS deploy (Render Blueprint) — owner runs this

**Files:** create `render.yaml`.

- [ ] **Step 1: Render Blueprint**

Create `render.yaml`:

```yaml
databases:
  - name: panteon-pg
    databaseName: leaderboard
    plan: free

services:
  - type: keyvalue            # managed Redis
    name: panteon-redis
    plan: free
    ipAllowList: []

  - type: web
    name: panteon-api
    runtime: docker
    dockerfilePath: ./docker/server.Dockerfile
    dockerCommand: pnpm --filter @panteon/server start:prod
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        fromDatabase: { name: panteon-pg, property: connectionString }
      - key: REDIS_URL
        fromService: { name: panteon-redis, type: keyvalue, property: connectionString }
      - key: MONGO_URL
        sync: false           # set to the Atlas SRV URL in the dashboard
      - key: MONGO_DB
        value: leaderboard
      - key: CORS_ORIGIN
        sync: false           # set to the client's URL
      - key: PORT
        value: "3000"

  - type: worker
    name: panteon-worker
    runtime: docker
    dockerfilePath: ./docker/server.Dockerfile
    dockerCommand: pnpm --filter @panteon/server worker:prod
    envVars:
      - { key: DATABASE_URL, fromDatabase: { name: panteon-pg, property: connectionString } }
      - { key: REDIS_URL, fromService: { name: panteon-redis, type: keyvalue, property: connectionString } }
      - { key: MONGO_URL, sync: false }
      - { key: MONGO_DB, value: leaderboard }

  - type: web
    name: panteon-client
    runtime: docker
    dockerfilePath: ./docker/client.Dockerfile
    dockerContext: .
    envVars:
      - key: VITE_API_BASE
        sync: false           # build arg: the panteon-api public URL
      - key: API_UPSTREAM
        sync: false           # or the api internal URL for the nginx proxy
```

- [ ] **Step 2: Deploy steps (documented)**

1. Create a free **MongoDB Atlas** cluster; copy the SRV connection string.
2. Run the one-off migration+seed once (Render Job or locally against the managed DBs): `migrate:prod` then `seed:prod` with the production env.
3. Push the repo; in Render, **New → Blueprint** from `render.yaml`.
4. Set the `sync:false` secrets: `MONGO_URL` (Atlas), `CORS_ORIGIN` (the client URL), and the client's `VITE_API_BASE` (the api URL).
5. The client web service gives the **accessible domain**; the API is reachable too. Email the link.

- [ ] **Step 3: Commit**

```bash
git add render.yaml
git commit -m "build: render blueprint for api/worker/client + managed pg/redis"
```

---

### Task 6: README deploy section

- [ ] **Step 1: Document run + deploy**

Add to `README.md`: "Run locally (dev)", "Run the whole stack in Docker" (`docker-compose.full.yml`), and "Deploy to Render" (Blueprint + Atlas + the one-off migrate/seed), plus the live URL once deployed.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: deployment + run instructions"
```

---

## Self-Review

**Spec coverage (the brief's delivery requirements):**
- A **production build on an accessible domain** → client image + Render web service (Task 2, 5). ✓
- **Stateless / horizontally scalable** → API and worker are stateless containers; PaaS scales replicas (worker via the consumer group, closer via the leader lock). ✓
- **Cloud usage** → managed Postgres + Redis + Atlas Mongo; declarative Blueprint. ✓
- **Sample data** → the `migrate` service seeds (Task 3). ✓
- Whole system **in Docker, one command** → `docker-compose.full.yml` (Task 3, 4). ✓

**Known trade-offs:** server runs via `tsx` (not a precompiled `dist`) — fine for this scale, a bundling step (tsup/esbuild) would shave cold-start at extreme scale; the demo `seed` runs on deploy (idempotent per week) and would be removed for a real production cut-over; free PaaS tiers sleep on idle (fine for a take-home, note it in the email).
