/**
 * SimpleFIN Bridge client.
 *
 * Protocol: https://www.simplefin.org/protocol-v1.html
 *
 * Two things happen here:
 *   1. claimSetupToken — one time, exchanges a base64 setup token for an access URL
 *   2. fetchAccounts   — every sync, GETs balances using that URL's embedded Basic auth
 *
 * The access URL is a bearer credential in URL form. Never log it.
 */

export interface SimpleFinOrg {
  id?: string;
  name?: string;
  domain?: string;
  url?: string;
  'sfin-url'?: string;
}

export interface SimpleFinHolding {
  id: string;
  created: number;
  currency?: string;
  symbol?: string;
  description?: string;
  shares?: string;
  market_value?: string;
  cost_basis?: string;
  purchase_price?: string;
}

export interface SimpleFinAccount {
  org: SimpleFinOrg;
  id: string;
  name: string;
  currency: string;
  /** Decimal string, e.g. "1234.56". Negative for amounts owed. */
  balance: string;
  'available-balance'?: string;
  /** Unix seconds — the institution's as-of, not our fetch time. */
  'balance-date': number;
  holdings?: SimpleFinHolding[];
}

export interface SimpleFinAccountSet {
  errors: string[];
  accounts: SimpleFinAccount[];
}

/**
 * Exchange a one-time setup token for a long-lived access URL.
 * The token is single-use — a failure here means generating a fresh one at the Bridge.
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8');

  if (!claimUrl.startsWith('https://')) {
    throw new Error('Setup token did not decode to an HTTPS URL. Check you copied all of it.');
  }

  const res = await fetch(claimUrl, { method: 'POST' });

  if (!res.ok) {
    throw new Error(
      `Could not claim setup token (HTTP ${res.status}). ` +
        `Tokens are single-use — generate a new one at the SimpleFIN Bridge.`
    );
  }

  return (await res.text()).trim();
}

export interface FetchOptions {
  /** Omit both dates to fetch balances only — cheaper and all net worth needs. */
  startDate?: Date;
  endDate?: Date;
  /** Ask for investment positions. Brokerages populate these; banks do not. */
  includeHoldings?: boolean;
}

export async function fetchAccounts(
  accessUrl: string,
  opts: FetchOptions = {}
): Promise<SimpleFinAccountSet> {
  const url = new URL(`${accessUrl.replace(/\/$/, '')}/accounts`);

  if (opts.startDate) {
    url.searchParams.set('start-date', String(Math.floor(opts.startDate.getTime() / 1000)));
  }
  if (opts.endDate) {
    url.searchParams.set('end-date', String(Math.floor(opts.endDate.getTime() / 1000)));
  }
  // Balances-only keeps responses small. We never need transactions.
  if (!opts.startDate && !opts.endDate) {
    url.searchParams.set('balances-only', '1');
  }

  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (res.status === 403) {
    throw new Error('SimpleFIN rejected the access URL. The connection may have been revoked.');
  }
  if (!res.ok) {
    throw new Error(`SimpleFIN returned HTTP ${res.status}.`);
  }

  const body = (await res.json()) as SimpleFinAccountSet;

  // `errors` is per-institution and non-fatal: other accounts still return data.
  // Surface these in the UI rather than throwing — partial data beats no data.
  return { errors: body.errors ?? [], accounts: body.accounts ?? [] };
}

/** Decimal string to integer cents. Avoids float drift on sums. */
export function toCents(decimal: string): number {
  const n = Number.parseFloat(decimal);
  if (!Number.isFinite(n)) throw new Error(`Unparseable balance: ${decimal}`);
  return Math.round(n * 100);
}
