/**
 * History aggregation, against an in-memory database.
 *
 * The behaviour worth protecting here is that the series reads the classification and
 * bucket frozen into each snapshot row. Joining to `accounts` instead would silently
 * rewrite years of chart history the first time an account is reclassified.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from './index.ts';
import { historySeries, cacheAgeHours } from './repo.ts';

function seed(db: ReturnType<typeof openDb>) {
  db.exec(`
    INSERT INTO accounts (id, org_name, name, classification, bucket, balance_cents)
    VALUES (1, 'Bank', 'Checking',  'asset',     'liquid',     10000),
           (2, 'Bank', 'Retirement','asset',     'retirement', 40000),
           (3, 'Bank', 'Card',      'liability', 'liquid',     -2500),
           (4, 'Bank', 'Ignored',   'excluded',  'liquid',     99999);
  `);
  const add = (accountId: number, date: string, cents: number, cls: string, bucket: string) =>
    db
      .prepare(
        `INSERT INTO snapshots (account_id, taken_on, balance_cents, classification, bucket)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(accountId, date, cents, cls, bucket);

  for (const date of ['2026-08-01', '2026-09-01']) {
    add(1, date, 10_000, 'asset', 'liquid');
    add(2, date, 40_000, 'asset', 'retirement');
    add(3, date, -2_500, 'liability', 'liquid');
    add(4, date, 99_999, 'excluded', 'liquid');
  }
  return db;
}

describe('historySeries', () => {
  test('sums each day into a net, with liabilities subtracting', () => {
    const db = seed(openDb(':memory:'));
    const points = historySeries(db, null);
    assert.equal(points.length, 2);
    assert.equal(points[0]!.netCents, 47_500); // 10000 + 40000 - 2500
    db.close();
  });

  test('excluded accounts contribute nothing', () => {
    const db = seed(openDb(':memory:'));
    const [first] = historySeries(db, null);
    // 99_999 sits in the snapshot rows but must not reach any total.
    assert.equal(first!.liquidCents, 7_500);
    db.close();
  });

  test('bucket series sum to the net', () => {
    const db = seed(openDb(':memory:'));
    for (const p of historySeries(db, null)) {
      assert.equal(p.liquidCents + p.retirementCents, p.netCents);
    }
    db.close();
  });

  test('respects the since bound', () => {
    const db = seed(openDb(':memory:'));
    assert.equal(historySeries(db, '2026-09-01').length, 1);
    assert.equal(historySeries(db, '2027-01-01').length, 0);
    db.close();
  });

  test('reclassifying an account does not rewrite history', () => {
    const db = seed(openDb(':memory:'));
    const before = historySeries(db, null)[0]!;

    // Move the retirement account to liquid, as a rollover would.
    db.exec(`UPDATE accounts SET bucket = 'liquid' WHERE id = 2`);

    const after = historySeries(db, null)[0]!;
    assert.deepEqual(after, before, 'past points must be unchanged');
    assert.equal(after.retirementCents, 40_000);
    db.close();
  });
});

describe('cacheAgeHours', () => {
  test('is null when nothing has ever synced', () => {
    const db = openDb(':memory:');
    assert.equal(cacheAgeHours(db), null);
    db.close();
  });

  test('reads SQLite datetimes as UTC', () => {
    // datetime('now') has no zone marker. Parsed as local time, a machine west of
    // Greenwich reads every sync as hours in the future and never revalidates.
    const db = openDb(':memory:');
    db.exec(`
      INSERT INTO connections (id, label, access_url_enc, access_url_iv, access_url_tag, last_synced_at)
      VALUES (1, 'x', x'00', x'00', x'00', '2026-09-02 00:00:00');
    `);
    const age = cacheAgeHours(db, new Date('2026-09-02T06:00:00Z'));
    assert.equal(age, 6);
    db.close();
  });
});
