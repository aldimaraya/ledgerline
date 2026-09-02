/**
 * Every SQL statement in the app lives here. Callers deal in plain objects.
 */

import type { Db } from './index.ts';
import { seal, open } from '../lib/crypto.ts';
import { config } from '../lib/env.ts';
import type { AccountRow, Bucket, Classification } from '../lib/networth.ts';

// ---------------------------------------------------------------- connections

export function saveConnection(db: Db, label: string, accessUrl: string): number {
  const { ciphertext, iv, tag } = seal(accessUrl, config.encryptionKey);
  const row = db
    .prepare(
      `INSERT INTO connections (label, access_url_enc, access_url_iv, access_url_tag)
       VALUES (?, ?, ?, ?) RETURNING id`
    )
    .get(label, ciphertext, iv, tag) as { id: number };
  return row.id;
}

export function getAccessUrl(db: Db, connectionId: number): string | null {
  const row = db
    .prepare(
      `SELECT access_url_enc AS ciphertext, access_url_iv AS iv, access_url_tag AS tag
       FROM connections WHERE id = ?`
    )
    .get(connectionId) as
    | { ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }
    | undefined;
  if (!row) return null;
  // node:sqlite hands back Uint8Array for BLOB columns; node:crypto wants Buffers.
  return open(
    {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      tag: Buffer.from(row.tag),
    },
    config.encryptionKey
  );
}

/**
 * The connection to sync with: the most recently stored one.
 *
 * Newest rather than oldest, deliberately. Re-running onboarding is what you do when a
 * connection has broken, so the new row is the fix — picking the oldest would keep
 * using the credential you just replaced and fail identically forever.
 */
export function latestConnectionId(db: Db): number | null {
  const row = db.prepare(`SELECT id FROM connections ORDER BY id DESC LIMIT 1`).get() as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export interface ConnectionStatus {
  id: number;
  label: string;
  created_at: string;
  last_synced_at: string | null;
  last_sync_error: string | null;
  consecutive_errors: number;
}

/** Never includes the access URL. */
export function listConnections(db: Db): ConnectionStatus[] {
  return db
    .prepare(
      `SELECT id, label, created_at, last_synced_at, last_sync_error, consecutive_errors
       FROM connections ORDER BY id`
    )
    .all() as unknown as ConnectionStatus[];
}

export function deleteConnection(db: Db, id: number): boolean {
  return Number(db.prepare(`DELETE FROM connections WHERE id = ?`).run(id).changes) > 0;
}

export function recordSyncSuccess(db: Db, connectionId: number): void {
  db.prepare(
    `UPDATE connections
     SET last_synced_at = datetime('now'), last_sync_error = NULL, consecutive_errors = 0
     WHERE id = ?`
  ).run(connectionId);
}

export function recordSyncFailure(db: Db, connectionId: number, message: string): void {
  db.prepare(
    `UPDATE connections
     SET last_sync_error = ?, consecutive_errors = consecutive_errors + 1
     WHERE id = ?`
  ).run(message, connectionId);
}

// ------------------------------------------------------------------- accounts

export interface UpsertAccount {
  connectionId: number | null;
  simplefinId: string;
  orgName: string;
  orgDomain: string | null;
  name: string;
  currency: string;
  classification: Classification;
  bucket: Bucket;
  balanceCents: number;
  rawBalance: string;
  balanceDate: string | null;
}

/**
 * Insert or update by `simplefin_id`.
 *
 * Note what is deliberately NOT overwritten on conflict: classification, bucket and
 * nickname. Those are the user's decisions. An institution renaming an account must
 * never silently re-guess a bucket the user already corrected.
 */
export function upsertAccount(db: Db, a: UpsertAccount): number {
  const row = db
    .prepare(
      `INSERT INTO accounts (
         connection_id, simplefin_id, org_name, org_domain, name, currency,
         classification, bucket, balance_cents, raw_balance, balance_date, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(simplefin_id) DO UPDATE SET
         org_name      = excluded.org_name,
         org_domain    = excluded.org_domain,
         name          = excluded.name,
         currency      = excluded.currency,
         balance_cents = excluded.balance_cents,
         raw_balance   = excluded.raw_balance,
         balance_date  = excluded.balance_date,
         updated_at    = datetime('now')
       RETURNING id`
    )
    .get(
      a.connectionId,
      a.simplefinId,
      a.orgName,
      a.orgDomain,
      a.name,
      a.currency,
      a.classification,
      a.bucket,
      a.balanceCents,
      a.rawBalance,
      a.balanceDate
    ) as { id: number };
  return row.id;
}

export function activeAccounts(db: Db): AccountRow[] {
  return db
    .prepare(
      `SELECT id, name, org_name AS orgName, classification, bucket,
              balance_cents AS balanceCents, balance_date AS balanceDate
       FROM accounts WHERE archived = 0 ORDER BY bucket, org_name, name`
    )
    .all() as unknown as AccountRow[];
}

// ------------------------------------------------------------------- holdings

export interface UpsertHolding {
  accountId: number;
  simplefinId: string | null;
  symbol: string | null;
  description: string | null;
  shares: string | null;
  marketValueCents: number | null;
  costBasisCents: number | null;
  asOf: string | null;
}

export function upsertHolding(db: Db, h: UpsertHolding): void {
  db.prepare(
    `INSERT INTO holdings (
       account_id, simplefin_id, symbol, description, shares,
       market_value_cents, cost_basis_cents, as_of
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, simplefin_id) DO UPDATE SET
       symbol             = excluded.symbol,
       description        = excluded.description,
       shares             = excluded.shares,
       market_value_cents = excluded.market_value_cents,
       cost_basis_cents   = excluded.cost_basis_cents,
       as_of              = excluded.as_of`
  ).run(
    h.accountId,
    h.simplefinId,
    h.symbol,
    h.description,
    h.shares,
    h.marketValueCents,
    h.costBasisCents,
    h.asOf
  );
}

// -------------------------------------------------------------- expected orgs

export function rememberOrg(db: Db, orgName: string, orgDomain: string | null): void {
  db.prepare(
    `INSERT INTO expected_orgs (org_name, org_domain, last_seen_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(org_name) DO UPDATE SET
       org_domain   = excluded.org_domain,
       last_seen_at = datetime('now'),
       retired      = 0`
  ).run(orgName, orgDomain);
}

/**
 * Institutions we have seen before that did not appear in this response.
 *
 * This is the whole point of the expected_orgs table. A missing institution produces no
 * error and no empty account list — it produces nothing at all, and the total quietly
 * drops by however much that institution held.
 */
export function missingOrgs(db: Db, seen: Set<string>): string[] {
  const known = db
    .prepare(`SELECT org_name FROM expected_orgs WHERE retired = 0`)
    .all() as { org_name: string }[];
  return known.map((r) => r.org_name).filter((name) => !seen.has(name));
}

// ------------------------------------------------------------------ snapshots

/**
 * Freeze today's balances. classification and bucket are copied in rather than joined
 * later, so reclassifying an account never rewrites history.
 */
export function writeSnapshots(db: Db, takenOn: string): number {
  const result = db
    .prepare(
      `INSERT INTO snapshots (account_id, taken_on, balance_cents, classification, bucket)
       SELECT id, ?, balance_cents, classification, bucket FROM accounts WHERE archived = 0
       ON CONFLICT(account_id, taken_on) DO UPDATE SET
         balance_cents  = excluded.balance_cents,
         classification = excluded.classification,
         bucket         = excluded.bucket`
    )
    .run(takenOn);
  // node:sqlite widens row counts to bigint; this one is bounded by the account count.
  return Number(result.changes);
}

// ---------------------------------------------------------------- request log

export function logRequest(db: Db, endpoint: string, status: number | null, note?: string): void {
  db.prepare(`INSERT INTO request_log (endpoint, status, note) VALUES (?, ?, ?)`).run(
    endpoint,
    status,
    note ?? null
  );
}

/** Requests in the last 24 hours, for the self-imposed cap. */
export function requestsToday(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM request_log WHERE requested_at > datetime('now', '-1 day')`)
    .get() as { n: number };
  return row.n;
}
