/**
 * The only place that talks to SimpleFIN on a schedule.
 *
 * The CLI, POST /api/sync and the background revalidation all call through here, so the
 * request cap and the error bookkeeping cannot drift apart between them. Exceeding
 * SimpleFIN's 24/day disables the access token, which is a manual recovery — a duplicated
 * guard that one caller forgets is the realistic way that happens.
 */

import type { Db } from '../db/index.ts';
import {
  cacheAgeHours,
  getAccessUrl,
  latestConnectionId,
  logRequest,
  recordSyncFailure,
  recordSyncSuccess,
  requestsToday,
} from '../db/repo.ts';
import { fetchAccounts } from '../simplefin/client.ts';
import { config } from '../lib/env.ts';
import { ingest, type IngestResult } from './ingest.ts';

export type SyncOutcome =
  | { status: 'ok'; result: IngestResult }
  | { status: 'no-connection' }
  | { status: 'rate-limited'; used: number; cap: number }
  | { status: 'failed'; message: string };

/**
 * In-flight fetch, if any.
 *
 * Without this, opening the app in three tabs while the cache is stale fires three
 * identical upstream requests and burns a sixth of the daily budget on one glance.
 * Everyone waiting joins the request that is already running.
 */
let inFlight: Promise<SyncOutcome> | null = null;
let inFlightSince = 0;

/**
 * Slack allowed on top of the upstream deadline before a stuck sync is abandoned.
 *
 * Deduplication is only ever a saving, so it must never be load-bearing. Held
 * unconditionally it turns one wedged request into a permanently unsyncable app:
 * `revalidateInBackground` skips while `isSyncing()` is true, and every later `syncNow`
 * attaches to the same promise that is never going to settle. With the client's own
 * timeout in place this ceiling should never be reached.
 */
const IN_FLIGHT_SLACK_MS = 15_000;

async function performSync(db: Db): Promise<SyncOutcome> {
  const connectionId = latestConnectionId(db);
  if (connectionId === null) return { status: 'no-connection' };

  const used = requestsToday(db);
  if (used >= config.maxDailyRequests) {
    return { status: 'rate-limited', used, cap: config.maxDailyRequests };
  }

  const accessUrl = getAccessUrl(db, connectionId);
  if (!accessUrl) return { status: 'failed', message: 'Stored connection has no access URL.' };

  try {
    const set = await fetchAccounts(accessUrl, {
      includeHoldings: true,
      timeoutMs: config.simplefinTimeoutMs,
    });
    logRequest(db, '/accounts', 200);
    recordSyncSuccess(db, connectionId);
    return { status: 'ok', result: ingest(db, set, connectionId) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logRequest(db, '/accounts', null, message);
    recordSyncFailure(db, connectionId, message);
    return { status: 'failed', message };
  }
}

export function syncNow(db: Db): Promise<SyncOutcome> {
  const ceiling = config.simplefinTimeoutMs + IN_FLIGHT_SLACK_MS;
  if (inFlight && Date.now() - inFlightSince < ceiling) return inFlight;

  inFlightSince = Date.now();
  const run: Promise<SyncOutcome> = performSync(db).finally(() => {
    // Only release the slot if this is still the current attempt. An abandoned sync
    // settling late must not clear a newer one that has taken its place.
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}

export function isSyncing(): boolean {
  return inFlight !== null;
}

/** Older than the TTL, or never synced at all. */
export function isStale(db: Db, now = new Date()): boolean {
  const age = cacheAgeHours(db, now);
  return age === null || age >= config.cacheTtlHours;
}

/**
 * Stale-while-revalidate: never block a read on the network.
 *
 * The caller has already served whatever the database holds. This kicks off a refresh
 * if the cache is past TTL and returns immediately. A failure here is deliberately
 * swallowed — it is recorded against the connection and surfaced through
 * /api/networth's staleness fields, and there is no request left to fail.
 */
export function revalidateInBackground(db: Db, onDone?: (o: SyncOutcome) => void): void {
  if (!isStale(db) || isSyncing()) return;
  void syncNow(db).then(
    (outcome) => onDone?.(outcome),
    () => {
      /* recorded against the connection; nothing is waiting on this */
    }
  );
}
