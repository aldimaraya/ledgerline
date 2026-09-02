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
 * Observed behaviour: institutions send liabilities already negative. This is a guard
 * against one that does not, and it is idempotent — an already-negative liability passes
 * through unchanged. Do not extend it into unconditional sign-flipping.
 *
 * Assets are taken as-is. A negative asset is a real thing (an overdrawn checking
 * account) and must not be flipped.
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

const RETIREMENT_PATTERNS = [
  // Plan types, as an institution might abbreviate them. The parentheses are optional
  // because both "401k" and "401(k)" occur, and the latter is more common in practice.
  /\b(401|403)\s?\(?[kb]\)?/,
  /\b(457|ira|roth|sep|simple\s?ira|pension|hsa|tsp)\b/,
  // Institutions usually spell them out instead. A Health Savings Account is rarely
  // labelled "HSA", and an employer plan is often named after the employer with no
  // plan-type word anywhere in it.
  /\bhealth\s?savings\b/,
  /\bsavings\s?plan\b/,
  /\b(retirement|thrift|annuity|profit\s?sharing)\b/,
];

const ILLIQUID_PATTERNS = [/\b(mortgage|property|home|real\s?estate|vehicle|auto\s?loan)\b/];

/**
 * Sensible default bucket for a newly discovered account, so onboarding is
 * confirm-not-configure. Guesses from the institution's own account naming.
 * Always user-overridable — this is a starting point, not a decision.
 *
 * It reads a human-written account name, so it is wrong often enough that the review
 * step is required rather than optional.
 *
 * Note what a wrong bucket does and does not do: it never changes net worth, because the
 * total sums every account regardless of bucket. It changes only the liquid/retirement
 * split. No assertion on the total will ever catch a bucketing bug — test the split.
 */
export function guessBucket(accountName: string, orgName: string): Bucket {
  const s = `${orgName} ${accountName}`.toLowerCase();

  if (RETIREMENT_PATTERNS.some((re) => re.test(s))) return 'retirement';
  if (ILLIQUID_PATTERNS.some((re) => re.test(s))) return 'illiquid';
  return 'liquid';
}

const LIABILITY_PATTERNS = [
  /\b(credit\s?card|card|visa|mastercard|amex)\b/,
  /\b(loan|mortgage|heloc|line\s?of\s?credit)\b/,
];

/**
 * Guess whether an account is something you own or something you owe.
 *
 * SimpleFIN has no account-type field, so this reads the name and the sign together.
 * A negative balance alone is not enough: an overdrawn checking account is still an
 * asset, and a paid-off card sits at 0.00.
 *
 * Getting this wrong does not change net worth — the total sums signed balances either
 * way — but it does move money between the displayed "assets" and "liabilities" figures.
 */
export function guessClassification(
  accountName: string,
  orgName: string,
  balanceCents: number
): Classification {
  const s = `${orgName} ${accountName}`.toLowerCase();

  if (LIABILITY_PATTERNS.some((re) => re.test(s))) return 'liability';
  // An unrecognised name carrying a negative balance is more likely a debt we failed to
  // name-match than an overdraft. Weak signal, but it surfaces the account for review.
  if (balanceCents < 0) return 'liability';
  return 'asset';
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
