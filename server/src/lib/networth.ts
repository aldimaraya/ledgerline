/**
 * Net worth calculation.
 *
 * The only genuinely subtle part of this app is sign convention, so it lives alone here
 * with tests. SimpleFIN reports what the institution reports, and institutions disagree:
 * a credit card may arrive as -1200 (you owe) or 1200 (balance owed, stated positive).
 *
 * Internal convention, applied at ingest and assumed everywhere after:
 *   positive = you own it
 *   negative = you owe it
 */

export type Classification = 'asset' | 'liability' | 'excluded';

/**
 * How reachable the money is. Orthogonal to classification — the two axes answer
 * different questions and a 401(k) loan needs both (liability + retirement).
 */
export type Bucket = 'liquid' | 'retirement' | 'illiquid';

export interface AccountRow {
  id: number;
  name: string;
  orgName: string;
  classification: Classification;
  bucket: Bucket;
  balanceCents: number;
  balanceDate: string | null;
}

/**
 * Normalize an institution-reported balance to the internal convention.
 *
 * A liability is stored negative. If the institution already sent it negative we keep the
 * sign; if it sent a positive "amount owed" we flip it. Assets are taken as-is — a
 * negative asset is a real thing (an overdrawn checking account) and must not be flipped.
 */
export function normalizeBalance(rawCents: number, classification: Classification): number {
  if (classification === 'liability') {
    return rawCents > 0 ? -rawCents : rawCents;
  }
  return rawCents;
}

export interface BucketTotals {
  assetsCents: number;
  liabilitiesCents: number;
  netCents: number;
}

export interface NetWorthBreakdown {
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  excludedCount: number;
  byBucket: Record<Bucket, BucketTotals>;
}

const emptyBucket = (): BucketTotals => ({
  assetsCents: 0,
  liabilitiesCents: 0,
  netCents: 0,
});

export function computeNetWorth(accounts: AccountRow[]): NetWorthBreakdown {
  let assets = 0;
  let liabilities = 0;
  let excluded = 0;

  const byBucket: Record<Bucket, BucketTotals> = {
    liquid: emptyBucket(),
    retirement: emptyBucket(),
    illiquid: emptyBucket(),
  };

  for (const a of accounts) {
    if (a.classification === 'excluded') {
      excluded++;
      continue;
    }

    const b = byBucket[a.bucket];

    if (a.classification === 'liability') {
      const owed = Math.abs(a.balanceCents);
      liabilities += owed;
      b.liabilitiesCents += owed;
      b.netCents -= owed;
    } else {
      assets += a.balanceCents;
      b.assetsCents += a.balanceCents;
      b.netCents += a.balanceCents;
    }
  }

  return {
    netWorthCents: assets - liabilities,
    assetsCents: assets,
    liabilitiesCents: liabilities,
    excludedCount: excluded,
    byBucket,
  };
}

/**
 * Sensible default bucket for a newly discovered account, so onboarding is
 * confirm-not-configure. Guesses from the institution's own account naming.
 * Always user-overridable — this is a starting point, not a decision.
 */
export function guessBucket(accountName: string, orgName: string): Bucket {
  const s = `${orgName} ${accountName}`.toLowerCase();

  if (/\b(401\s?k|403\s?b|457|ira|roth|sep|simple\s?ira|pension|hsa|tsp)\b/.test(s)) {
    return 'retirement';
  }
  if (/\b(mortgage|property|home|real\s?estate|vehicle|auto\s?loan)\b/.test(s)) {
    return 'illiquid';
  }
  return 'liquid';
}

/**
 * How stale is this data, in whole days?
 *
 * Measured against the institution's own balance date, not our last fetch. Fetching
 * successfully from a Bridge that itself hasn't heard from an institution in five days is
 * not fresh data, and the UI must not imply otherwise.
 */
export function stalenessDays(balanceDate: string | null, now = new Date()): number | null {
  if (!balanceDate) return null;
  const then = new Date(balanceDate);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}
