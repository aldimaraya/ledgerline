/**
 * The JSON API.
 *
 * Every endpoint serves from SQLite. Nothing here blocks on SimpleFIN, including
 * POST /api/sync, which reports what happened rather than waiting on a bank.
 */

import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/index.ts';
import {
  activeAccounts,
  cacheAgeHours,
  getMeta,
  historySeries,
  lastSyncedAt,
  listConnections,
  requestsToday,
} from '../db/repo.ts';
import { computeNetWorth, stalenessDays } from '../lib/networth.ts';
import { isRange, sinceDate, RANGES } from '../lib/range.ts';
import { config } from '../lib/env.ts';
import { isStale, isSyncing, revalidateInBackground, syncNow } from '../sync/service.ts';

function jsonList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function registerApi(app: FastifyInstance, db: Db): void {
  /**
   * The main screen's payload. Always served from cache, always instant.
   */
  app.get('/api/networth', async () => {
    const accounts = activeAccounts(db);
    const nw = computeNetWorth(accounts);
    const missing = jsonList(getMeta(db, 'last_missing_orgs'));

    // Serve first, then refresh. The client gets a number immediately and picks up the
    // corrected one on its next poll or reconnect.
    revalidateInBackground(db);

    return {
      netWorthCents: nw.netWorthCents,
      assetsCents: nw.assetsCents,
      liabilitiesCents: nw.liabilitiesCents,
      byBucket: nw.byBucket,

      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        orgName: a.orgName,
        classification: a.classification,
        bucket: a.bucket,
        balanceCents: a.balanceCents,
        balanceDate: a.balanceDate,
        // Per-account, because balance dates span more than a day across institutions
        // and a single "as of" would be a lie about most of them.
        stalenessDays: stalenessDays(a.balanceDate),
      })),

      // Everything below is what stops a cached number from being confidently wrong.
      asOf: lastSyncedAt(db),
      cacheAgeHours: cacheAgeHours(db),
      stale: isStale(db),
      syncing: isSyncing(),
      complete: missing.length === 0,
      missingOrgs: missing,
      errors: jsonList(getMeta(db, 'last_errors')),
      connections: listConnections(db).map((c) => ({
        id: c.id,
        lastSyncedAt: c.last_synced_at,
        lastSyncError: c.last_sync_error,
        consecutiveErrors: c.consecutive_errors,
      })),
    };
  });

  /**
   * The chart series. Snapshot rows only — this never triggers a fetch, because history
   * is by definition already written.
   */
  app.get('/api/history', async (req, reply) => {
    const raw = (req.query as { range?: string }).range ?? '1y';
    if (!isRange(raw)) {
      return reply.code(400).send({ error: `range must be one of: ${RANGES.join(', ')}` });
    }
    return { range: raw, points: historySeries(db, sinceDate(raw)) };
  });

  /**
   * Pull-to-refresh. Returns the outcome rather than throwing, because "we are rate
   * limited" is a normal state the UI needs to render, not an error.
   */
  app.post('/api/sync', async (_req, reply) => {
    const outcome = await syncNow(db);

    switch (outcome.status) {
      case 'ok':
        return {
          ok: true,
          accountsSeen: outcome.result.accountsSeen,
          holdingsSeen: outcome.result.holdingsSeen,
          missingOrgs: outcome.result.missing,
          errors: outcome.result.errors,
          requestsToday: requestsToday(db),
        };
      case 'rate-limited':
        // 429 with the numbers, so the UI can say when it will work again.
        return reply.code(429).send({
          ok: false,
          reason: 'rate-limited',
          used: outcome.used,
          cap: outcome.cap,
          message: `Self-imposed cap of ${outcome.cap} requests/day reached.`,
        });
      case 'no-connection':
        return reply.code(409).send({ ok: false, reason: 'no-connection' });
      case 'failed':
        return reply.code(502).send({ ok: false, reason: 'failed', message: outcome.message });
    }
  });

  /** Liveness plus enough detail to tell whether the data behind it is any good. */
  app.get('/api/health', async () => ({
    ok: true,
    asOf: lastSyncedAt(db),
    cacheAgeHours: cacheAgeHours(db),
    ttlHours: config.cacheTtlHours,
    stale: isStale(db),
    requestsToday: requestsToday(db),
    requestCap: config.maxDailyRequests,
    connections: listConnections(db).map((c) => ({
      id: c.id,
      lastSyncedAt: c.last_synced_at,
      consecutiveErrors: c.consecutive_errors,
    })),
  }));
}
