/**
 * npm run import-history -- --map <file> [--apply]
 *
 * Backfills `snapshots` from a previous provider's export.
 *
 * Dry-run by default. It prints what it would write, the daily totals either side of the
 * splice, and any day where the total steps by more than a threshold — because an import
 * that is subtly wrong produces a chart that looks fine and is not.
 *
 * Everything specific to one person's accounts lives in the map file, which is
 * gitignored. This file knows only the shape.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { openDb, withTransaction, type Db } from '../db/index.ts';
import { config } from '../lib/env.ts';
import {
  applyCorrections,
  dailyTotals,
  interpolate,
  seriesByAccount,
  suspiciousJumps,
  trimLeadingEmptyDays,
  type Correction,
  type ExportDay,
  type SyntheticSeries,
} from '../lib/history-import.ts';

interface AccountMapping {
  /** Match an existing account by its SimpleFIN id. */
  simplefinId?: string;
  /**
   * Create an archived account instead. For accounts that were real and held real money
   * during the imported period, but are closed now and so never arrive from SimpleFIN.
   * Omitting them does not leave a small hole — it removes their entire balance from
   * every day of history.
   */
  create?: {
    orgName: string;
    name: string;
    classification: 'asset' | 'liability' | 'excluded';
    bucket: 'liquid' | 'retirement' | 'illiquid';
  };
  /** Skip deliberately, with a reason recorded here rather than in someone's memory. */
  ignore?: string;
}

interface ImportMap {
  source: string;
  /** Everything before this is the provider's zero-padding. */
  startDate: string;
  endDate?: string;
  accounts: Record<string, AccountMapping>;
  corrections?: Correction[];
  synthetic?: (SyntheticSeries & { simplefinId: string })[];
  /** Flag a step larger than this in the dry run. Defaults to $20,000. */
  jumpThresholdCents?: number;
}

const argv = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
};
const apply = argv.includes('--apply');

const usd = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`;

function accountIdFor(db: Db, providerId: string, mapping: AccountMapping): number | null {
  if (mapping.ignore) return null;

  if (mapping.simplefinId) {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE simplefin_id = ?`)
      .get(mapping.simplefinId) as { id: number } | undefined;
    if (!row) throw new Error(`No account with simplefin_id ${mapping.simplefinId} (map key ${providerId})`);
    return row.id;
  }

  if (mapping.create) {
    const c = mapping.create;
    // Keyed on a synthetic id so re-running matches the same row instead of creating
    // a second one. Archived, so it never shows in the current-balances UI.
    const syntheticId = `imported:${providerId}`;
    const existing = db.prepare(`SELECT id FROM accounts WHERE simplefin_id = ?`).get(syntheticId) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;

    const row = db
      .prepare(
        `INSERT INTO accounts (simplefin_id, org_name, name, classification, bucket,
                               balance_cents, archived)
         VALUES (?, ?, ?, ?, ?, 0, 1) RETURNING id`
      )
      .get(syntheticId, c.orgName, c.name, c.classification, c.bucket) as { id: number };
    console.log(`  created archived account #${row.id}: ${c.orgName} · ${c.name}`);
    return row.id;
  }

  throw new Error(`Mapping for ${providerId} needs one of simplefinId, create, or ignore.`);
}

function main(): number {
  const mapPath = valueOf('--map');
  if (!mapPath) {
    console.error('Usage: npm run import-history -- --map <file.json> [--apply]');
    return 1;
  }

  const mapFile = resolve(mapPath);
  const map = JSON.parse(readFileSync(mapFile, 'utf8')) as ImportMap;
  // Relative to the map file, not the working directory: the two travel together and
  // the command gets run from wherever npm happens to put you.
  const raw = JSON.parse(readFileSync(resolve(dirname(mapFile), map.source), 'utf8')) as {
    spData: { histories: ExportDay[] };
  };

  let days = trimLeadingEmptyDays(raw.spData.histories);
  days = days.filter((d) => d.date >= map.startDate && (!map.endDate || d.date <= map.endDate));
  console.log(`${days.length} days, ${days[0]?.date} → ${days[days.length - 1]?.date}\n`);

  const series = seriesByAccount(days);

  const { applied, missed } = applyCorrections(series, map.corrections ?? []);
  for (const c of applied) console.log(`  corrected ${c.accountId} on ${c.date} → ${usd(c.valueCents)}  (${c.why})`);
  for (const c of missed) console.log(`  ! correction did not match anything: ${c.accountId} ${c.date}`);
  if (applied.length || missed.length) console.log('');

  const db = openDb(valueOf('--db') ?? config.databasePath);

  // Provider account -> our account id.
  const resolved = new Map<string, number>();
  const unmapped: string[] = [];
  for (const providerId of series.keys()) {
    const mapping = map.accounts[providerId];
    if (!mapping) {
      unmapped.push(providerId);
      continue;
    }
    const id = accountIdFor(db, providerId, mapping);
    if (id !== null) resolved.set(providerId, id);
    else console.log(`  ignoring ${providerId}: ${mapping.ignore}`);
  }

  if (unmapped.length) {
    // Refuse rather than silently importing a smaller net worth for every day.
    console.error(`\nUnmapped accounts present in the export: ${unmapped.join(', ')}`);
    console.error('Add them to the map with simplefinId, create, or ignore.');
    db.close();
    return 1;
  }

  // Rows to write, keyed by our account id.
  const toWrite = new Map<number, Map<string, number>>();
  for (const [providerId, accountId] of resolved) {
    const existing = toWrite.get(accountId) ?? new Map<string, number>();
    for (const [date, cents] of series.get(providerId)!) {
      // Two provider accounts can map to one of ours; sum rather than overwrite.
      existing.set(date, (existing.get(date) ?? 0) + cents);
    }
    toWrite.set(accountId, existing);
  }

  for (const s of map.synthetic ?? []) {
    const row = db.prepare(`SELECT id FROM accounts WHERE simplefin_id = ?`).get(s.simplefinId) as
      | { id: number }
      | undefined;
    if (!row) throw new Error(`Synthetic series references unknown account ${s.simplefinId}`);
    const filled = interpolate(s);
    const existing = toWrite.get(row.id) ?? new Map<string, number>();
    for (const [date, cents] of filled) existing.set(date, cents);
    toWrite.set(row.id, existing);
    console.log(
      `  synthetic: account #${row.id}, ${s.fromDate} → ${s.toDate}, ` +
        `${usd(s.fromCents)} → ${usd(s.toCents)} (${s.why})`
    );
  }

  // What the chart will show.
  const totals = dailyTotals(toWrite);
  const dates = [...totals.keys()];
  console.log('\nDaily totals (first, last five imported):');
  console.log(`  ${dates[0]}  ${usd(totals.get(dates[0]!)!)}`);
  for (const d of dates.slice(-5)) console.log(`  ${d}  ${usd(totals.get(d)!)}`);

  const threshold = map.jumpThresholdCents ?? 2_000_000;
  const jumps = suspiciousJumps(totals, threshold);
  console.log(`\nDays stepping more than ${usd(threshold)}: ${jumps.length}`);
  for (const j of jumps) console.log(`  ! ${j.date}  ${j.deltaCents > 0 ? '+' : ''}${usd(j.deltaCents)}`);

  const rows = [...toWrite.values()].reduce((n, m) => n + m.size, 0);
  console.log(`\n${rows} snapshot rows across ${toWrite.size} accounts.`);

  if (!apply) {
    console.log('\nDry run. Nothing written. Re-run with --apply once the numbers look right.');
    db.close();
    return 0;
  }

  withTransaction(db, () => {
    const insert = db.prepare(
      `INSERT INTO snapshots (account_id, taken_on, balance_cents, classification, bucket)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, taken_on) DO UPDATE SET balance_cents = excluded.balance_cents`
    );
    for (const [accountId, byDate] of toWrite) {
      // Freeze the account's classification and bucket as they are now. Imperfect for
      // history -- we do not know what they were -- but consistent with how live
      // snapshots are written, and it never changes retroactively afterwards.
      const a = db.prepare(`SELECT classification, bucket FROM accounts WHERE id = ?`).get(accountId) as {
        classification: string;
        bucket: string;
      };
      for (const [date, cents] of byDate) insert.run(accountId, date, cents, a.classification, a.bucket);
    }
  });

  const total = db.prepare(`SELECT COUNT(*) n, MIN(taken_on) a, MAX(taken_on) b FROM snapshots`).get() as {
    n: number;
    a: string;
    b: string;
  };
  console.log(`\nWritten. snapshots now: ${total.n} rows, ${total.a} → ${total.b}`);
  db.close();
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`\nImport failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
