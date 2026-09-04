/**
 * The nightly job's one job: never write a data point that was not measured.
 *
 * Left unattended the app fetches nothing, so before this existed the snapshot job
 * recorded the same cached balances night after night. That produces a flat chart, which
 * is indistinguishable from a genuinely flat week and cannot be corrected afterwards.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb, type Db } from '../db/index.ts';
import { historySeries, upsertAccount } from '../db/repo.ts';
import { localDate } from '../lib/range.ts';
import { snapshotIfFresh } from './daily.ts';

/** A connection row with a chosen last-successful-sync age, in hours. */
function connectionSyncedHoursAgo(db: Db, hours: number | null): void {
  db.prepare(
    `INSERT INTO connections (id, label, access_url_enc, access_url_iv, access_url_tag,
                              last_synced_at)
     VALUES (1, 'test', 'x', 'x', 'x', ?)`
  ).run(hours === null ? null : `datetime('now')`);

  if (hours !== null) {
    db.prepare(`UPDATE connections SET last_synced_at = datetime('now', ?) WHERE id = 1`).run(
      `-${hours} hours`
    );
  }
}

function withAccount(db: Db): void {
  upsertAccount(db, {
    connectionId: null,
    simplefinId: 'a',
    orgName: 'Bank A',
    orgDomain: null,
    name: 'Checking',
    currency: 'USD',
    classification: 'asset',
    bucket: 'liquid',
    balanceCents: 100_000,
    rawBalance: '1000.00',
    balanceDate: null,
  });
}

describe('snapshotIfFresh', () => {
  test('records the close when the cache was refreshed today', () => {
    const db = openDb(':memory:');
    withAccount(db);
    connectionSyncedHoursAgo(db, 1);

    const out = snapshotIfFresh(db);
    assert.equal(out.status, 'written');
    assert.equal(historySeries(db, null).length, 1);
    db.close();
  });

  test('leaves a gap rather than repeating a week-old balance', () => {
    const db = openDb(':memory:');
    withAccount(db);
    connectionSyncedHoursAgo(db, 24 * 7);

    const out = snapshotIfFresh(db);
    assert.equal(out.status, 'skipped');
    // A gap, not a zero: historySeries groups by date, so the day is simply absent.
    // A fabricated point here would be permanent and undetectable.
    assert.deepEqual(historySeries(db, null), []);
    db.close();
  });

  test('records nothing when there has never been a successful sync', () => {
    const db = openDb(':memory:');
    withAccount(db);
    connectionSyncedHoursAgo(db, null);

    assert.equal(snapshotIfFresh(db).status, 'skipped');
    assert.deepEqual(historySeries(db, null), []);
    db.close();
  });

  test('files the snapshot under the local date, not the UTC one', () => {
    const db = openDb(':memory:');
    withAccount(db);
    connectionSyncedHoursAgo(db, 1);

    // 23:45 local on the 5th. Anywhere west of Greenwich that is already the 6th in UTC,
    // and filing the day's close under tomorrow means the next morning's first sync
    // overwrites it.
    const out = snapshotIfFresh(db, new Date(2026, 0, 5, 23, 45));
    assert.equal(out.status, 'written');
    assert.equal(out.takenOn, '2026-01-05');
    db.close();
  });
});

describe('localDate', () => {
  test('reads local calendar fields', () => {
    assert.equal(localDate(new Date(2026, 0, 5, 23, 45)), '2026-01-05');
    assert.equal(localDate(new Date(2026, 8, 4, 0, 5)), '2026-09-04');
  });
});
