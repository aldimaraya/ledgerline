# --- build web ---
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- build server ---
FROM node:22-alpine AS server
WORKDIR /build
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

# --- runtime ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package*.json ./
RUN npm ci --omit=dev && apk add --no-cache sqlite
COPY --from=server /build/dist ./dist
COPY --from=server /build/src/db/schema.sql ./dist/db/schema.sql
COPY --from=web /build/dist ./public
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
