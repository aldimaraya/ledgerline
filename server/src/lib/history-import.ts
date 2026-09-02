/**
 * Pure transforms for importing a provider's balance-history export.
 *
 * Kept separate from the CLI because every one of these silently changes what the chart
 * says. An import that is subtly wrong looks exactly like an import that worked.
 */

export interface ExportDay {
  date: string;
  /** Keyed by the provider's account id. Annotation keys are mixed in and skipped. */
  balances: Record<string, number | string>;
}

export interface Correction {
  /** Provider account id whose value on `date` is wrong. */
  accountId: string;
  date: string;
  valueCents: number;
  why: string;
}

export interface SyntheticSeries {
  /** Straight line between two known endpoints, inclusive. */
  fromDate: string;
  toDate: string;
  fromCents: number;
  toCents: number;
  why: string;
}

const isAnnotation = (key: string) => key.endsWith('Annotation');

export function toCents(value: number): number {
  return Math.round(value * 100);
}

/**
 * Drop the provider's leading zero-padding.
 *
 * Exports pad backwards to a fixed window with `0` balances for days before the accounts
 * were ever linked. Imported literally the chart opens with a cliff from nothing, which
 * reads as a real collapse in net worth rather than an absence of data.
 */
export function trimLeadingEmptyDays(days: ExportDay[]): ExportDay[] {
  const firstReal = days.findIndex((d) =>
    Object.entries(d.balances).some(([k, v]) => !isAnnotation(k) && typeof v === 'number' && v !== 0)
  );
  return firstReal === -1 ? [] : days.slice(firstReal);
}

/** Per-account daily series, in cents, with annotations stripped. */
export function seriesByAccount(days: ExportDay[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const day of days) {
    for (const [key, value] of Object.entries(day.balances)) {
      if (isAnnotation(key) || typeof value !== 'number') continue;
      if (!out.has(key)) out.set(key, new Map());
      out.get(key)!.set(day.date, toCents(value));
    }
  }
  return out;
}

/**
 * Apply hand-checked corrections.
 *
 * The case this exists for: money in flight between institutions appears in both for a
 * day, so the total spikes by the transfer amount and comes back down. Every correction
 * carries a `why`, because a magic number in an import script is indistinguishable from
 * a mistake six months later.
 */
export function applyCorrections(
  series: Map<string, Map<string, number>>,
  corrections: Correction[]
): { applied: Correction[]; missed: Correction[] } {
  const applied: Correction[] = [];
  const missed: Correction[] = [];

  for (const c of corrections) {
    const account = series.get(c.accountId);
    if (!account || !account.has(c.date)) {
      missed.push(c);
      continue;
    }
    account.set(c.date, c.valueCents);
    applied.push(c);
  }
  return { applied, missed };
}

export function eachDate(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const d = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Fill a gap the old provider never covered, as a straight line between two balances
 * that are actually known.
 *
 * This is a placeholder and should only ever span a period where the real shape is
 * uninteresting — a savings balance drifting with interest, not a market-exposed one.
 * Interpolating between known endpoints bounds the error at both ends; picking a flat
 * number that looks plausible does not.
 */
export function interpolate(s: SyntheticSeries): Map<string, number> {
  const dates = eachDate(s.fromDate, s.toDate);
  const out = new Map<string, number>();
  const steps = dates.length - 1;

  dates.forEach((date, i) => {
    const t = steps === 0 ? 0 : i / steps;
    out.set(date, Math.round(s.fromCents + (s.toCents - s.fromCents) * t));
  });
  return out;
}

/**
 * Daily totals, for eyeballing the splice before anything is written.
 *
 * Generic in the key so it works both before mapping (keyed by the provider's account
 * ids) and after (keyed by ours) — it only ever reads the values.
 */
export function dailyTotals<K>(series: Map<K, Map<string, number>>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const account of series.values()) {
    for (const [date, cents] of account) {
      totals.set(date, (totals.get(date) ?? 0) + cents);
    }
  }
  return new Map([...totals].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Days where the total moves by more than `thresholdCents` against the previous day.
 *
 * Run over the finished series, this is the check that catches an unfixed double count
 * or a mapping that dropped an account: both show up as a step no market produces.
 */
export function suspiciousJumps(
  totals: Map<string, number>,
  thresholdCents: number
): { date: string; deltaCents: number }[] {
  const out: { date: string; deltaCents: number }[] = [];
  let previous: number | null = null;

  for (const [date, cents] of totals) {
    if (previous !== null && Math.abs(cents - previous) >= thresholdCents) {
      out.push({ date, deltaCents: cents - previous });
    }
    previous = cents;
  }
  return out;
}
