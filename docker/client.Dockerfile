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
