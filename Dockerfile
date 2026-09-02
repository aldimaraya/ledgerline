# Node 24, not 22: the server uses node:sqlite, which is only usable without flags from
# Node 22.5 and is stable in 24. Pinning the major matters more than usual here — there
# is no compiled artifact to catch an incompatibility at build time.

# --- build the PWA ---
FROM node:24-alpine AS web
WORKDIR /build
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- runtime ---
FROM node:24-alpine
ENV NODE_ENV=production

# Node strips TypeScript at runtime, so the server ships as source. There is no build
# step and therefore no dist/ — the previous Dockerfile copied one that is never
# produced, and the image could not start.
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server/src ./src

# The server resolves the web build relative to itself, so the layout here has to match
# the repository's. WEB_DIST overrides it if that ever stops being true.
COPY --from=web /build/dist /app/web/dist

# Bind inside the container, not on the host. The published port is what limits exposure
# (see docker-compose.yml) — a container that listens only on its own loopback is simply
# unreachable.
ENV HOST=0.0.0.0
ENV PORT=3000
# Absolute, so it does not depend on the working directory. This is the volume mount.
ENV DATABASE_PATH=/data/ledgerline.db

# node:alpine ships an unprivileged `node` user. The database is the only thing written
# at runtime, so that is the only thing it needs to own.
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3000

# busybox wget, already present in the base image.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "src/index.ts"]
