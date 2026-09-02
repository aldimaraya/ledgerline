/**
 * Turn a SimpleFIN response into rows.
 *
 * Every rule here was learned from a real response rather than the protocol docs, and
 * each one has a comment saying why, because they all look like mistakes otherwise.
 */

import { withTransaction, type Db } from '../db/index.ts';
import {
  missingOrgs,
  rememberOrg,
  setMeta,
  upsertAccount,
  upsertHolding,
  writeSnapshots,
} from '../db/repo.ts';
import { toCents, type SimpleFinAccount, type SimpleFinAccountSet } from '../simplefin/client.ts';
import { guessBucket, guessClassification, normalizeBalance } from '../lib/networth.ts';

export interface IngestResult {
  accountsSeen: number;
  holdingsSeen: number;
  /** Institutions we have seen before that sent nothing this time. */
  missing: string[];
  /** Per-institution errors SimpleFIN reported. Non-fatal: other accounts still arrive. */
  errors: string[];
  snapshotsWritten: number;
}

function orgNameOf(a: SimpleFinAccount): string {
  return a.org.name ?? a.org.domain ?? 'Unknown institution';
}

/** Unix seconds to an ISO string, or null. Never fall back to "now" — see below. */
function balanceDateOf(a: SimpleFinAccount): string | null {
  const raw = a['balance-date'];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return new Date(raw * 1000).toISOString();
}

export function ingest(db: Db, set: SimpleFinAccountSet, connectionId: number | null): IngestResult {
  let holdingsSeen = 0;
  const seenOrgs = new Set<string>();

  withTransaction(db, () => {
    for (const a of set.accounts) {
      const orgName = orgNameOf(a);
      seenOrgs.add(orgName);
      rememberOrg(db, orgName, a.org.domain ?? null);

      // `balance` is authoritative. `available-balance` is reported as 0.00 on most
      // accounts regardless of what they hold, so reading it would silently zero them.
      const rawCents = toCents(a.balance);
      const classification = guessClassification(a.name, orgName, rawCents);

      const accountId = upsertAccount(db, {
        connectionId,
        simplefinId: a.id,
        orgName,
        orgDomain: a.org.domain ?? null,
        name: a.name,
        currency: a.currency ?? 'USD',
        classification,
        bucket: guessBucket(a.name, orgName),
        // Idempotent guard. Institutions send liabilities already negative.
        balanceCents: normalizeBalance(rawCents, classification),
        // Kept verbatim so a disputed number can be traced back to what arrived.
        rawBalance: a.balance,
        // The institution's own as-of, not our fetch time. Null stays null: pretending
        // stale data is fresh is the specific failure this app must not have.
        balanceDate: balanceDateOf(a),
      });

      for (const h of a.holdings ?? []) {
        holdingsSeen++;
        upsertHolding(db, {
          accountId,
          simplefinId: h.id ?? null,
          symbol: h.symbol ?? null,
          description: h.description ?? null,
          // Recorded but not trusted: accounts exist that report "0.00" shares against a
          // real market value. Never compute from this field.
          shares: h.shares ?? null,
          marketValueCents: h.market_value ? toCents(h.market_value) : null,
          costBasisCents: h.cost_basis ? toCents(h.cost_basis) : null,
          asOf: h.created ? new Date(h.created * 1000).toISOString() : null,
        });
      }
    }
  });

  const missing = missingOrgs(db, seenOrgs);

  // Persisted so /api/networth can report an incomplete total without syncing. A cached
  // number served without its "this is missing an institution" flag is exactly the
  // confidently-wrong answer this app exists to avoid.
  setMeta(db, 'last_missing_orgs', JSON.stringify(missing));
  setMeta(db, 'last_errors', JSON.stringify(set.errors));

  return {
    accountsSeen: set.accounts.length,
    holdingsSeen,
    missing,
    errors: set.errors,
    snapshotsWritten: writeSnapshots(db, new Date().toISOString().slice(0, 10)),
  };
}
