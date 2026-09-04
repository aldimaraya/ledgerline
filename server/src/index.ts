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
import { registerApi } from './routes/api.ts';
import { runDaily } from './sync/daily.ts';
import { config } from './lib/env.ts';

const here = dirname(fileURLToPath(import.meta.url));
// Overridable so the container layout is not pinned to the repository's shape.
const WEB_DIST = process.env.WEB_DIST ?? resolve(here, '../../web/dist');

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
 * The nightly job, at 23:45 local time: sync, then snapshot.
 *
 * It fetches rather than recording whatever happens to be cached. The original design
 * did the latter, on the reasoning that a bank which has not reported since morning will
 * not report differently at 23:55 — true, but it quietly assumed someone had opened the
 * app that morning to trigger a refresh. Nobody had to, and on the days nobody did the
 * job recorded week-old balances as that day's close.
 *
 * One request a night against a cap of 20, so the budget is not the constraint here.
 */
const nightlyJob = cron.schedule(
  '45 23 * * *',
  () => {
    void runDaily(db).then(
      ({ sync, snapshot }) => {
        if (sync.status !== 'ok') {
          app.log.warn({ sync }, 'nightly sync did not succeed');
        }
        if (snapshot.status === 'skipped') {
          // Loud, because the visible symptom is a gap in the chart and the cause is
          // several hours upstream of it.
          app.log.warn(
            { takenOn: snapshot.takenOn, ageHours: snapshot.ageHours },
            'snapshot skipped: cache too old to record as a closing position'
          );
        } else {
          app.log.info({ takenOn: snapshot.takenOn, rows: snapshot.rows }, 'daily snapshot written');
        }
      },
      (err: unknown) => app.log.error({ err }, 'nightly job failed')
    );
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
    nightlyJob.stop();
    void app.close().then(() => {
      closeDb();
      process.exit(0);
    });
  });
}
