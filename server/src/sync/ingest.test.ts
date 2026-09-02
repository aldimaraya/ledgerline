/**
 * Ingest tests, against an in-memory database.
 *
 * The important one here is the missing-institution case. When an institution returns
 * nothing, SimpleFIN omits its accounts and leaves `errors` empty — the response is
 * indistinguishable from a healthy one that simply has fewer accounts, and the total
 * silently shrinks. Everything else in this file is scaffolding around that test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../db/index.ts';
import { activeAccounts } from '../db/repo.ts';
import { computeNetWorth } from '../lib/networth.ts';
import { ingest } from './ingest.ts';
import type { SimpleFinAccount, SimpleFinAccountSet } from '../simplefin/client.ts';

function account(over: Partial<SimpleFinAccount> & { id: string }): SimpleFinAccount {
  return {
    org: { name: 'Bank A', domain: 'bank-a.example' },
    name: 'Checking',
    currency: 'USD',
    balance: '100.00',
    'balance-date': Math.floor(Date.now() / 1000),
    ...over,
  } as SimpleFinAccount;
}

const set = (accounts: SimpleFinAccount[], errors: string[] = []): SimpleFinAccountSet => ({
  accounts,
  errors,
});

describe('ingest', () => {
  test('stores accounts and computes a total', () => {
    const db = openDb(':memory:');
    ingest(db, set([account({ id: 'a', balance: '1000.00' })]), null);
    assert.equal(computeNetWorth(activeAccounts(db)).netWorthCents, 100_000);
    db.close();
  });

  test('is idempotent — syncing twice does not double anything', () => {
    const db = openDb(':memory:');
    const payload = set([account({ id: 'a', balance: '1000.00' })]);
    ingest(db, payload, null);
    const second = ingest(db, payload, null);
    assert.equal(second.accountsSeen, 1);
    assert.equal(activeAccounts(db).length, 1);
    assert.equal(computeNetWorth(activeAccounts(db)).netWorthCents, 100_000);
    db.close();
  });

  test('a changed balance updates in place', () => {
    const db = openDb(':memory:');
    ingest(db, set([account({ id: 'a', balance: '1000.00' })]), null);
    ingest(db, set([account({ id: 'a', balance: '1500.00' })]), null);
    assert.equal(computeNetWorth(activeAccounts(db)).netWorthCents, 150_000);
    db.close();
  });

  test('a user-corrected bucket survives the next sync', () => {
    // The institution's name never changes the user's decision. If this regresses,
    // every sync silently re-guesses and the split drifts back to wrong.
    const db = openDb(':memory:');
    ingest(db, set([account({ id: 'a', name: 'Mystery Account' })]), null);
    db.exec(`UPDATE accounts SET bucket = 'retirement' WHERE simplefin_id = 'a'`);
    ingest(db, set([account({ id: 'a', name: 'Mystery Account', balance: '200.00' })]), null);
    assert.equal(activeAccounts(db)[0]!.bucket, 'retirement');
    db.close();
  });

  test('records holdings but never totals them', () => {
    const db = openDb(':memory:');
    const result = ingest(
      db,
      set([
        account({
          id: 'a',
          balance: '1000.00',
          holdings: [
            // Deliberately short of the balance, and with the untrustworthy shares field.
            { id: 'h1', created: 0, symbol: 'ABC', shares: '0.00', market_value: '400.00' },
          ],
        }),
      ]),
      null
    );
    assert.equal(result.holdingsSeen, 1);
    // Balance wins. If holdings ever drive the total this becomes 40_000.
    assert.equal(computeNetWorth(activeAccounts(db)).netWorthCents, 100_000);
    db.close();
  });

  describe('a vanished institution', () => {
    test('is detected even though the response looks completely healthy', () => {
      const db = openDb(':memory:');

      const both = set([
        account({ id: 'a', org: { name: 'Bank A' }, balance: '1000.00' }),
        account({ id: 'b', org: { name: 'Bank B' }, balance: '5000.00' }),
      ]);
      const first = ingest(db, both, null);
      assert.deepEqual(first.missing, []);
      assert.equal(computeNetWorth(activeAccounts(db)).netWorthCents, 600_000);

      // Bank B stops responding. No error, no empty list — it is simply absent.
      const onlyA = set([account({ id: 'a', org: { name: 'Bank A' }, balance: '1000.00' })]);
      const second = ingest(db, onlyA, null);

      assert.deepEqual(second.errors, [], 'SimpleFIN reports nothing — that is the problem');
      assert.deepEqual(second.missing, ['Bank B'], 'the diff is the only thing that notices');
    });

    test('leaves the stale balance in place rather than zeroing it', () => {
      // Deleting or zeroing the account would make the total look confidently correct
      // while being wrong. The number stays, flagged stale, and the caller decides.
      const db = openDb(':memory:');
      ingest(
        db,
        set([
          account({ id: 'a', org: { name: 'Bank A' }, balance: '1000.00' }),
          account({ id: 'b', org: { name: 'Bank B' }, balance: '5000.00' }),
        ]),
        null
      );
      ingest(db, set([account({ id: 'a', org: { name: 'Bank A' }, balance: '1000.00' })]), null);
      assert.equal(activeAccounts(db).length, 2);
      db.close();
    });

    test('stops reporting missing once the institution comes back', () => {
      const db = openDb(':memory:');
      const both = set([
        account({ id: 'a', org: { name: 'Bank A' } }),
        account({ id: 'b', org: { name: 'Bank B' } }),
      ]);
      ingest(db, both, null);
      ingest(db, set([account({ id: 'a', org: { name: 'Bank A' } })]), null);
      assert.deepEqual(ingest(db, both, null).missing, []);
      db.close();
    });
  });

  test('surfaces per-institution errors without discarding the accounts that arrived', () => {
    const db = openDb(':memory:');
    const result = ingest(db, set([account({ id: 'a' })], ['Bank B: connection expired']), null);
    assert.equal(result.errors.length, 1);
    assert.equal(result.accountsSeen, 1);
    db.close();
  });

  test('snapshots freeze bucket and classification at write time', () => {
    const db = openDb(':memory:');
    ingest(db, set([account({ id: 'a', name: 'Roth IRA', balance: '1000.00' })]), null);

    const frozen = db.prepare(`SELECT bucket FROM snapshots`).get() as { bucket: string };
    assert.equal(frozen.bucket, 'retirement');

    // Reclassify today. History must still show what was true when it was written.
    db.exec(`UPDATE accounts SET bucket = 'liquid' WHERE simplefin_id = 'a'`);
    const stillFrozen = db.prepare(`SELECT bucket FROM snapshots`).get() as { bucket: string };
    assert.equal(stillFrozen.bucket, 'retirement');
    db.close();
  });

  test('a null balance-date stays null rather than becoming now', () => {
    const db = openDb(':memory:');
    ingest(db, set([account({ id: 'a', 'balance-date': undefined as never })]), null);
    assert.equal(activeAccounts(db)[0]!.balanceDate, null);
    db.close();
  });
});
