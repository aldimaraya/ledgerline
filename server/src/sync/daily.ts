/**
 * The unattended path.
 *
 * Everything else in this app is driven by someone opening it: `revalidateInBackground`
 * needs a request to hang off, and POST /api/sync needs a thumb. Left alone, the database
 * would never learn anything new — while the snapshot job kept faithfully recording the
 * same stale balances every night as if they were each day's close.
 *
 * So this does the two things in order, once a night: fetch, then record what was
 * fetched. The ordering is the point, which is why it is one job rather than two crons a
 * few minutes apart.
 */

import type { Db } from '../db/index.ts';
import { cacheAgeHours, writeSnapshots } from '../db/repo.ts';
import { config } from '../lib/env.ts';
import { localDate } from '../lib/range.ts';
import { syncNow, type SyncOutcome } from './service.ts';

export type SnapshotOutcome =
  | { status: 'written'; takenOn: string; rows: number }
  | { status: 'skipped'; takenOn: string; ageHours: number | null };

export interface DailyOutcome {
  sync: SyncOutcome;
  snapshot: SnapshotOutcome;
}

/**
 * Record the day's close, but only if there is something worth recording.
 *
 * A snapshot is a claim that this is what the balances were on this date. Writing one
 * from a cache that has not been refreshed in days turns a gap in the data into a flat
 * line on the chart, which reads as "nothing moved" rather than "nothing was measured" —
 * and there is no way to tell the two apart afterwards. Skipping leaves a hole, and
 * `historySeries` groups by date, so a missing day simply does not appear as a point
 * rather than appearing as a zero.
 *
 * The freshness test is deliberately about the last successful sync, not about
 * per-account `balance-date`. Those legitimately span days across institutions, and
 * dropping just the stale accounts would subtract them from that day's total — a cliff,
 * which is far worse than a slightly old balance. It is all of the day's accounts or
 * none of them.
 */
export function snapshotIfFresh(db: Db, now = new Date()): SnapshotOutcome {
  const takenOn = localDate(now);
  const ageHours = cacheAgeHours(db, now);

  if (ageHours === null || ageHours > config.snapshotMaxAgeHours) {
    return { status: 'skipped', takenOn, ageHours };
  }
  return { status: 'written', takenOn, rows: writeSnapshots(db, takenOn) };
}

/**
 * Sync, then snapshot. Never throws — a nightly job that dies takes the scheduler's next
 * run with it on some hosts, and there is nobody watching at 23:45 either way.
 */
export async function runDaily(db: Db, now = new Date()): Promise<DailyOutcome> {
  const sync = await syncNow(db);
  return { sync, snapshot: snapshotIfFresh(db, now) };
}
