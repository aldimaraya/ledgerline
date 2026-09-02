/**
 * Tests run against docs/sample-response.json — a real, unmodified SimpleFIN response.
 * Do not substitute invented data: every rule asserted here was learned by reading that
 * file, and a hand-written fixture would encode the assumptions rather than test them.
 *
 * The fixture is gitignored, so these tests skip when it is absent rather than fail.
 * Expected totals live in docs/BASELINE.local.md, also gitignored — they are read from
 * the fixture at runtime instead of being hardcoded, so no balance appears in this file.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { toCents, type SimpleFinAccountSet } from '../simplefin/client.ts';
import {
  computeNetWorth,
  guessBucket,
  guessClassification,
  normalizeBalance,
  stalenessDays,
  type AccountRow,
} from './networth.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, '../../../docs/sample-response.json');
const hasFixture = existsSync(FIXTURE) && readFileSync(FIXTURE, 'utf8').trim().length > 0;

let fixture: SimpleFinAccountSet;
let rows: AccountRow[];

before(() => {
  if (!hasFixture) return;
  fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SimpleFinAccountSet;
  rows = fixture.accounts.map((a, i) => {
    const cents = toCents(a.balance);
    const orgName = a.org.name ?? a.org.domain ?? '';
    const classification = guessClassification(a.name, orgName, cents);
    return {
      id: i + 1,
      name: a.name,
      orgName,
      classification,
      bucket: guessBucket(a.name, orgName),
      balanceCents: normalizeBalance(cents, classification),
      balanceDate: new Date(a['balance-date'] * 1000).toISOString(),
    };
  });
});

describe('normalizeBalance', () => {
  test('leaves an already-negative liability alone', () => {
    assert.equal(normalizeBalance(-1_234_56, 'liability'), -1_234_56);
  });

  test('is idempotent', () => {
    const once = normalizeBalance(-500, 'liability');
    assert.equal(normalizeBalance(once, 'liability'), once);
  });

  test('does not flip a negative asset — an overdraft is not a debt', () => {
    assert.equal(normalizeBalance(-2_500, 'asset'), -2_500);
  });
});

describe('guessBucket', () => {
  test('matches abbreviated plan types', () => {
    assert.equal(guessBucket('Roth Contributory IRA', 'Broker'), 'retirement');
    assert.equal(guessBucket('401(k) Plan', 'Broker'), 'retirement');
  });

  // These two are the regression cases: both fell through to `liquid` before the
  // patterns were widened, misfiling a large balance into the wrong half of the split.
  test('matches a spelled-out health savings account', () => {
    assert.equal(guessBucket('Health Savings Account', 'Broker'), 'retirement');
  });

  test('matches an employer plan that never says "401k"', () => {
    assert.equal(guessBucket('ACME CORPORATION EMPLOYEE SAVINGS PLAN', 'Broker'), 'retirement');
  });

  test('does not mistake a plain savings account for a retirement plan', () => {
    assert.equal(guessBucket('High-Yield Savings', 'Bank'), 'liquid');
    assert.equal(guessBucket('Performance Savings', 'Bank'), 'liquid');
  });

  test('defaults to liquid', () => {
    assert.equal(guessBucket('Individual Brokerage', 'Broker'), 'liquid');
    assert.equal(guessBucket('Checking', 'Bank'), 'liquid');
  });
});

describe('guessClassification', () => {
  test('names a card as a liability regardless of sign', () => {
    assert.equal(guessClassification('Rewards Card', 'Bank', 0), 'liability');
  });

  test('treats an unrecognised negative balance as a liability', () => {
    assert.equal(guessClassification('Mystery Account', 'Bank', -100), 'liability');
  });

  test('treats a positive balance as an asset', () => {
    assert.equal(guessClassification('Checking', 'Bank', 100), 'asset');
  });
});

describe('computeNetWorth', () => {
  test('subtracts liabilities and reports them positive', () => {
    const r = computeNetWorth([
      { id: 1, name: 'Checking', orgName: 'B', classification: 'asset', bucket: 'liquid', balanceCents: 10_000, balanceDate: null },
      { id: 2, name: 'Card', orgName: 'B', classification: 'liability', bucket: 'liquid', balanceCents: -2_500, balanceDate: null },
    ]);
    assert.equal(r.netWorthCents, 7_500);
    assert.equal(r.assetsCents, 10_000);
    assert.equal(r.liabilitiesCents, 2_500);
  });

  test('ignores excluded accounts but counts them', () => {
    const r = computeNetWorth([
      { id: 1, name: 'A', orgName: 'B', classification: 'asset', bucket: 'liquid', balanceCents: 10_000, balanceDate: null },
      { id: 2, name: 'B', orgName: 'B', classification: 'excluded', bucket: 'liquid', balanceCents: 99_999, balanceDate: null },
    ]);
    assert.equal(r.netWorthCents, 10_000);
    assert.equal(r.excludedCount, 1);
  });

  test('bucket totals sum to the overall net worth', () => {
    const r = computeNetWorth([
      { id: 1, name: 'A', orgName: 'B', classification: 'asset', bucket: 'liquid', balanceCents: 10_000, balanceDate: null },
      { id: 2, name: 'B', orgName: 'B', classification: 'asset', bucket: 'retirement', balanceCents: 40_000, balanceDate: null },
      { id: 3, name: 'C', orgName: 'B', classification: 'liability', bucket: 'liquid', balanceCents: -2_500, balanceDate: null },
    ]);
    const summed = r.byBucket.liquid.netCents + r.byBucket.retirement.netCents + r.byBucket.illiquid.netCents;
    assert.equal(summed, r.netWorthCents);
  });
});

describe('the real response', { skip: hasFixture ? false : 'docs/sample-response.json is empty or absent' }, () => {
  test('every balance parses to integer cents', () => {
    for (const a of fixture.accounts) {
      const c = toCents(a.balance);
      assert.ok(Number.isInteger(c), `${a.name} did not parse to an integer`);
    }
  });

  test('net worth equals the sum of signed balances, however accounts are classified', () => {
    // The invariant that makes the total trustworthy: classification moves money between
    // the assets and liabilities figures but must never change the total.
    const raw = fixture.accounts.reduce((sum, a) => sum + toCents(a.balance), 0);
    assert.equal(computeNetWorth(rows).netWorthCents, raw);
  });

  test('assets minus liabilities reconciles', () => {
    const r = computeNetWorth(rows);
    assert.equal(r.assetsCents - r.liabilitiesCents, r.netWorthCents);
  });

  test('bucket splits sum to the total — a bucketing bug hides from the total alone', () => {
    const r = computeNetWorth(rows);
    const summed = r.byBucket.liquid.netCents + r.byBucket.retirement.netCents + r.byBucket.illiquid.netCents;
    assert.equal(summed, r.netWorthCents);
  });

  test('no account lands in illiquid — nothing should be tagged it in v1', () => {
    assert.equal(computeNetWorth(rows).byBucket.illiquid.netCents, 0);
  });

  test('every retirement-looking account is actually bucketed retirement', () => {
    // Guards the widened patterns against regressing on this specific response.
    const looksRetirement = /ira|roth|401|health savings|savings plan|hsa/i;
    for (const r of rows) {
      if (looksRetirement.test(`${r.orgName} ${r.name}`)) {
        assert.equal(r.bucket, 'retirement', `${r.name} should be retirement`);
      }
    }
  });

  test('available-balance is unusable — never read it', () => {
    // Documented as a rule; asserted so nobody "fixes" the ingest to prefer it.
    const zeroed = fixture.accounts.filter(
      (a) => a['available-balance'] !== undefined && toCents(a['available-balance']) === 0
    );
    const nonZeroBalance = zeroed.filter((a) => toCents(a.balance) !== 0);
    assert.ok(
      nonZeroBalance.length > 0,
      'expected at least one account reporting available-balance 0.00 against a real balance'
    );
  });

  test('holdings never sum to the account balance — uninvested cash is not a position', () => {
    const withHoldings = fixture.accounts.filter((a) => (a.holdings ?? []).length > 0);
    assert.ok(withHoldings.length > 0, 'fixture has no holdings — refetch without balances-only=1');

    const anyShort = withHoldings.some((a) => {
      const summed = (a.holdings ?? []).reduce((s, h) => s + toCents(h.market_value ?? '0'), 0);
      return summed !== toCents(a.balance);
    });
    assert.ok(anyShort, 'expected at least one account whose holdings do not sum to its balance');
  });

  test('market_value is trustworthy where shares is not', () => {
    const bogusShares = fixture.accounts
      .flatMap((a) => a.holdings ?? [])
      .filter((h) => h.shares !== undefined && Number.parseFloat(h.shares) === 0);
    for (const h of bogusShares) {
      assert.ok(
        toCents(h.market_value ?? '0') > 0,
        'a holding reported zero shares AND zero market value — the fixture assumption changed'
      );
    }
  });

  test('balance-date spans more than a day, so per-account staleness is required', () => {
    const dates = fixture.accounts.map((a) => a['balance-date']);
    const spanHours = (Math.max(...dates) - Math.min(...dates)) / 3600;
    assert.ok(spanHours > 12, `expected a meaningful spread, got ${spanHours.toFixed(1)}h`);
  });

  test('stalenessDays measures from the institution date, not our fetch', () => {
    const then = new Date('2026-09-01T00:00:00Z').toISOString();
    const now = new Date('2026-09-06T00:00:00Z');
    assert.equal(stalenessDays(then, now), 5);
  });
});
