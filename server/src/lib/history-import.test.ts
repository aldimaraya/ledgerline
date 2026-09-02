/**
 * Every transform here changes what the chart says without changing whether the import
 * succeeds. A wrong one produces a plausible curve, which is why they are tested
 * individually rather than only through the CLI.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCorrections,
  dailyTotals,
  eachDate,
  interpolate,
  seriesByAccount,
  suspiciousJumps,
  trimLeadingEmptyDays,
  type ExportDay,
} from './history-import.ts';

const day = (date: string, balances: Record<string, number | string>): ExportDay => ({
  date,
  balances,
});

describe('trimLeadingEmptyDays', () => {
  test('drops the provider zero-padding before accounts were linked', () => {
    const days = [
      day('2025-01-01', { a: 0, b: 0 }),
      day('2025-01-02', { a: 0, b: 0 }),
      day('2025-01-03', { a: 100, b: 0 }),
      day('2025-01-04', { a: 110, b: 5 }),
    ];
    const kept = trimLeadingEmptyDays(days);
    assert.equal(kept.length, 2);
    assert.equal(kept[0]!.date, '2025-01-03');
  });

  test('ignores annotation keys when deciding a day is empty', () => {
    const days = [
      day('2025-01-01', { a: 0, aAnnotation: 'Accurate data unavailable' }),
      day('2025-01-02', { a: 50 }),
    ];
    assert.equal(trimLeadingEmptyDays(days)[0]!.date, '2025-01-02');
  });

  test('returns nothing when every day is empty', () => {
    assert.deepEqual(trimLeadingEmptyDays([day('2025-01-01', { a: 0 })]), []);
  });
});

describe('seriesByAccount', () => {
  test('converts to cents and strips annotations', () => {
    const s = seriesByAccount([day('2025-01-01', { a: 12.34, aAnnotation: 'x', b: 5 })]);
    assert.equal(s.get('a')!.get('2025-01-01'), 1_234);
    assert.equal(s.get('b')!.get('2025-01-01'), 500);
    assert.ok(!s.has('aAnnotation'));
  });

  test('rounds rather than truncating', () => {
    const s = seriesByAccount([day('2025-01-01', { a: 0.005 })]);
    assert.equal(s.get('a')!.get('2025-01-01'), 1);
  });
});

describe('applyCorrections', () => {
  // The case this exists for: money in flight appears in two institutions on one day.
  test('overwrites a double-counted day', () => {
    const s = seriesByAccount([day('2025-01-01', { a: 1000 }), day('2025-01-02', { a: 1000 })]);
    const { applied } = applyCorrections(s, [
      { accountId: 'a', date: '2025-01-02', valueCents: 0, why: 'in flight' },
    ]);
    assert.equal(applied.length, 1);
    assert.equal(s.get('a')!.get('2025-01-02'), 0);
    assert.equal(s.get('a')!.get('2025-01-01'), 100_000, 'other days untouched');
  });

  test('reports a correction that matched nothing rather than silently passing', () => {
    // A typo in a date would otherwise leave the artifact in place and look like success.
    const s = seriesByAccount([day('2025-01-01', { a: 1 })]);
    const { applied, missed } = applyCorrections(s, [
      { accountId: 'a', date: '2099-01-01', valueCents: 0, why: 'typo' },
    ]);
    assert.equal(applied.length, 0);
    assert.equal(missed.length, 1);
  });
});

describe('eachDate', () => {
  test('is inclusive at both ends', () => {
    assert.deepEqual(eachDate('2025-01-01', '2025-01-03'), ['2025-01-01', '2025-01-02', '2025-01-03']);
  });

  test('crosses a month boundary', () => {
    assert.deepEqual(eachDate('2025-01-30', '2025-02-01'), ['2025-01-30', '2025-01-31', '2025-02-01']);
  });

  test('a single day is one entry, not zero', () => {
    assert.deepEqual(eachDate('2025-01-01', '2025-01-01'), ['2025-01-01']);
  });
});

describe('interpolate', () => {
  test('hits both known endpoints exactly', () => {
    const s = interpolate({
      fromDate: '2025-01-01',
      toDate: '2025-01-05',
      fromCents: 10_000,
      toCents: 20_000,
      why: 'test',
    });
    assert.equal(s.get('2025-01-01'), 10_000);
    assert.equal(s.get('2025-01-05'), 20_000);
    assert.equal(s.get('2025-01-03'), 15_000, 'midpoint');
  });

  test('does not divide by zero on a single-day span', () => {
    const s = interpolate({
      fromDate: '2025-01-01',
      toDate: '2025-01-01',
      fromCents: 500,
      toCents: 900,
      why: 'test',
    });
    assert.equal(s.get('2025-01-01'), 500);
  });
});

describe('suspiciousJumps', () => {
  // This is the check that catches an unfixed double count or a dropped account —
  // both appear as a step no market produces.
  test('flags a step over the threshold in either direction', () => {
    const totals = new Map([
      ['2025-01-01', 100_000],
      ['2025-01-02', 101_000],
      ['2025-01-03', 300_000],
      ['2025-01-04', 100_000],
    ]);
    const jumps = suspiciousJumps(totals, 50_000);
    assert.deepEqual(
      jumps.map((j) => j.date),
      ['2025-01-03', '2025-01-04']
    );
    assert.ok(jumps[1]!.deltaCents < 0, 'sign is preserved');
  });

  test('is quiet on a smooth series', () => {
    const totals = new Map([
      ['2025-01-01', 100_000],
      ['2025-01-02', 101_000],
    ]);
    assert.deepEqual(suspiciousJumps(totals, 50_000), []);
  });
});

describe('dailyTotals', () => {
  test('sums across accounts and sorts by date', () => {
    const totals = dailyTotals(
      new Map([
        [1, new Map([['2025-01-02', 200], ['2025-01-01', 100]])],
        [2, new Map([['2025-01-01', 50]])],
      ])
    );
    assert.deepEqual([...totals], [
      ['2025-01-01', 150],
      ['2025-01-02', 200],
    ]);
  });
});
