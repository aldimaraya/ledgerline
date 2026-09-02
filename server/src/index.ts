/**
 * Server entry point.
 *
 * Binds to localhost by default. Access is over Tailscale, which reaches the host and
 * then connects locally — there is no reason for this process to be listening on a
 * public interface, and defaulting to 0.0.0.0 is how single-user apps end up exposed.
 */

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import cron from 'node-cron';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb, closeDb } from './db/index.ts';
import { writeSnapshots } from './db/repo.ts';
import { registerApi } from './routes/api.ts';
import { config } from './lib/env.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(here, '../../web/dist');

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // The access URL must never reach a log line, so redaction is set up before the
    // first request rather than relied on case by case.
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  },
});

const db = getDb();

/**
 * Discard request bodies on anything that is not JSON.
 *
 * No endpoint in this API reads a body — POST /api/sync is a verb, not a payload. By
 * default Fastify answers 415 for any content type it has no parser for, so a bodyless
 * POST from a client that still sets a Content-Type (PowerShell does, and so do several
 * HTTP clients) fails before the route runs. Fastify's built-in JSON parser still takes
 * precedence for application/json, so Phase 4's onboarding POSTs are unaffected.
 */
app.addContentTypeParser('*', (_req, payload, done) => {
  payload.resume(); // drain it, otherwise the socket stays open waiting to be read
  done(null, undefined);
});

registerApi(app, db);

// The PWA is served by this same process — one container, one origin, no CORS.
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  // Client-side routing: anything that is not an API call falls through to the app shell.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`No web build at ${WEB_DIST} — API only. Build it in Phase 3.`);
}

/**
 * Daily snapshot at 23:55 local time.
 *
 * Writes whatever the cache already holds rather than forcing a fetch: the point is to
 * record the day's closing position, and a bank that has not reported since morning will
 * not report differently at 23:55. It just spends a request.
 */
const snapshotJob = cron.schedule(
  '55 23 * * *',
  () => {
    try {
      const written = writeSnapshots(db, new Date().toISOString().slice(0, 10));
      app.log.info({ written }, 'daily snapshot written');
    } catch (err) {
      app.log.error({ err }, 'daily snapshot failed');
    }
  },
  { timezone: process.env.TZ ?? 'UTC' }
);

const host = process.env.HOST ?? '127.0.0.1';

try {
  await app.listen({ port: config.port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    snapshotJob.stop();
    void app.close().then(() => {
      closeDb();
      process.exit(0);
    });
  });
}
