/**
 * Types mirror the server's responses. Money is integer cents everywhere, including
 * across the wire — the UI divides by 100 only at the moment of rendering.
 */

export type Classification = 'asset' | 'liability' | 'excluded';
export type Bucket = 'liquid' | 'retirement' | 'illiquid';
export type Range = '1m' | '3m' | '6m' | '1y' | 'all';

export interface BucketTotals {
  assetsCents: number;
  liabilitiesCents: number;
  netCents: number;
}

export interface Account {
  id: number;
  name: string;
  orgName: string;
  classification: Classification;
  bucket: Bucket;
  balanceCents: number;
  balanceDate: string | null;
  stalenessDays: number | null;
}

export interface Connection {
  id: number;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  consecutiveErrors: number;
}

export interface NetWorth {
  netWorthCents: number;
  assetsCents: number;
  liabilitiesCents: number;
  byBucket: Record<Bucket, BucketTotals>;
  accounts: Account[];
  asOf: string | null;
  cacheAgeHours: number | null;
  stale: boolean;
  syncing: boolean;
  complete: boolean;
  missingOrgs: string[];
  errors: string[];
  connections: Connection[];
}

export interface HistoryPoint {
  takenOn: string;
  netCents: number;
  liquidCents: number;
  retirementCents: number;
}

export interface History {
  range: Range;
  points: HistoryPoint[];
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

export const fetchNetWorth = () => get<NetWorth>('/api/networth');
export const fetchHistory = (range: Range) => get<History>(`/api/history?range=${range}`);

export type SyncResult =
  | { ok: true; accountsSeen: number; missingOrgs: string[]; errors: string[] }
  | { ok: false; reason: 'rate-limited'; used: number; cap: number; message: string }
  | { ok: false; reason: 'no-connection' | 'failed'; message?: string };

/**
 * Pull-to-refresh. Never throws: "we are rate limited" is a state the UI renders, not an
 * error it swallows. Exceeding the upstream quota disables the token, so the cap being
 * hit is normal, expected, and worth saying out loud.
 */
export async function requestSync(): Promise<SyncResult> {
  try {
    // A backstop above the server's own upstream deadline, so the button always resolves
    // even if the server itself stops answering mid-request. Without it the spinner is
    // the only thing the user ever sees.
    const res = await fetch('/api/sync', {
      method: 'POST',
      signal: AbortSignal.timeout(75_000),
    });
    return (await res.json()) as SyncResult;
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return {
      ok: false,
      reason: 'failed',
      message: timedOut ? 'The server stopped responding.' : 'Could not reach the server.',
    };
  }
}
