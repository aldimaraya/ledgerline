import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isRange, sinceDate } from './range.ts';

describe('range parsing', () => {
  test('accepts the known ranges and rejects anything else', () => {
    for (const r of ['1m', '3m', '6m', '1y', 'all']) assert.ok(isRange(r));
    // Rejected rather than silently defaulted: a typo that quietly returns a year of
    // data looks like working software.
    for (const r of ['2y', '', 'week', '1M', 'DROP TABLE']) assert.ok(!isRange(r));
  });

  test('"all" has no lower bound', () => {
    assert.equal(sinceDate('all'), null);
  });

  test('counts calendar months, not fixed day counts', () => {
    const now = new Date('2026-09-02T12:00:00Z');
    assert.equal(sinceDate('1m', now), '2026-08-02');
    assert.equal(sinceDate('3m', now), '2026-06-02');
    assert.equal(sinceDate('6m', now), '2026-03-02');
  });

  test('crosses the year boundary', () => {
    assert.equal(sinceDate('3m', new Date('2026-02-15T12:00:00Z')), '2025-11-15');
    assert.equal(sinceDate('1y', new Date('2026-09-02T12:00:00Z')), '2025-09-02');
  });

  test('does not throw on a short month', () => {
    // 31 March minus one month is not a real date; it clamps forward rather than
    // producing Invalid Date.
    const got = sinceDate('1m', new Date('2026-03-31T12:00:00Z'));
    assert.match(got!, /^\d{4}-\d{2}-\d{2}$/);
  });
});
