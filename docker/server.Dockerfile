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
# default = API; the worker/migrate services override `command`
CMD ["pnpm", "--filter", "@panteon/server", "start:prod"]
