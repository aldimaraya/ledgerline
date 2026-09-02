/**
 * npm run sync — fetch, ingest, print.
 *
 * This is the Phase 1 exit criterion: one command that prints the correct net worth.
 *
 * Flags:
 *   --fixture [path]  read docs/sample-response.json instead of calling SimpleFIN.
 *                     Costs nothing against the daily quota. Use it for everything
 *                     except confirming that live fetching still works.
 *   --setup-token     claim a one-time setup token and store the access URL, then sync.
 *   --db <path>       override DATABASE_PATH.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { openDb } from '../db/index.ts';
import {
  activeAccounts,
  firstConnectionId,
  getAccessUrl,
  logRequest,
  recordSyncFailure,
  recordSyncSuccess,
  requestsToday,
  saveConnection,
} from '../db/repo.ts';
import { claimSetupToken, fetchAccounts, type SimpleFinAccountSet } from '../simplefin/client.ts';
import { computeNetWorth, stalenessDays, type Bucket } from '../lib/networth.ts';
import { config } from '../lib/env.ts';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
};

const usd = (cents: number): string =>
  (cents < 0 ? '-' : '') +
  '$' +
  Math.abs(Math.round(cents / 100)).toLocaleString('en-US');

function ageOf(balanceDate: string | null): string {
  const days = stalenessDays(balanceDate);
  if (days === null) return 'no date';
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

async function loadFixture(path: string): Promise<SimpleFinAccountSet> {
  const full = resolve(process.cwd(), path);
  const body = readFileSync(full, 'utf8').trim();
  if (!body) {
    throw new Error(
      `${path} is empty. Regenerate it with the commands in docs/SETUP.md, or run a live sync.`
    );
  }
  const parsed = JSON.parse(body) as SimpleFinAccountSet;
  return { errors: parsed.errors ?? [], accounts: parsed.accounts ?? [] };
}

async function main(): Promise<number> {
  const db = openDb(valueOf('--db') ?? config.databasePath);
  const useFixture = has('--fixture');

  // Onboarding: claim a token once and store the access URL encrypted.
  if (has('--setup-token')) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const token = await rl.question('Paste your SimpleFIN setup token: ');
    rl.close();
    const accessUrl = await claimSetupToken(token);
    saveConnection(db, 'SimpleFIN', accessUrl);
    // Deliberately not printed. It is a bearer credential.
    console.error('Access URL claimed and stored, encrypted.\n');
  }

  let set: SimpleFinAccountSet;
  let connectionId: number | null = null;

  if (useFixture) {
    const path = valueOf('--fixture') ?? '../docs/sample-response.json';
    set = await loadFixture(path);
    console.error(`Reading ${path} — no request made to SimpleFIN.\n`);
  } else {
    connectionId = firstConnectionId(db);
    if (connectionId === null) {
      console.error(
        'No connection stored. Run `npm run sync -- --setup-token` first, or\n' +
          '`npm run sync -- --fixture` to work against the saved response.'
      );
      return 1;
    }

    const used = requestsToday(db);
    if (used >= config.maxDailyRequests) {
      console.error(
        `Daily request cap reached (${used}/${config.maxDailyRequests}).\n` +
          `SimpleFIN's hard limit is 24 and exceeding it disables the access token.\n` +
          `Use --fixture, or wait.`
      );
      return 1;
    }

    const accessUrl = getAccessUrl(db, connectionId);
    if (!accessUrl) throw new Error(`Connection ${connectionId} has no stored access URL.`);

    try {
      set = await fetchAccounts(accessUrl, { includeHoldings: true });
      logRequest(db, '/accounts', 200);
      recordSyncSuccess(db, connectionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logRequest(db, '/accounts', null, message);
      recordSyncFailure(db, connectionId, message);
      throw err;
    }
  }

  const { ingest } = await import('../sync/ingest.ts');
  const result = ingest(db, set, connectionId);

  const accounts = activeAccounts(db);
  const nw = computeNetWorth(accounts);

  console.log(`Net worth   ${usd(nw.netWorthCents)}`);
  console.log(`  assets    ${usd(nw.assetsCents)}`);
  console.log(`  owed      ${usd(nw.liabilitiesCents)}`);
  console.log('');

  const buckets: Bucket[] = ['liquid', 'retirement', 'illiquid'];
  for (const b of buckets) {
    // illiquid renders only if something is actually tagged it. Nothing is, in v1.
    if (b === 'illiquid' && nw.byBucket[b].netCents === 0) continue;
    console.log(`  ${b.padEnd(10)} ${usd(nw.byBucket[b].netCents)}`);
  }
  console.log('');

  for (const a of accounts) {
    const label = `${a.orgName} · ${a.name}`;
    console.log(
      `  ${label.slice(0, 46).padEnd(48)}${usd(a.balanceCents).padStart(12)}   ${ageOf(a.balanceDate)}`
    );
  }

  console.log('');
  console.log(
    `${result.accountsSeen} accounts, ${result.holdingsSeen} holdings, ` +
      `${result.snapshotsWritten} snapshots written.`
  );

  // Both of these are the difference between a number you can trust and one you cannot.
  if (result.errors.length > 0) {
    console.log('');
    for (const e of result.errors) console.log(`  ! ${e}`);
  }

  if (result.missing.length > 0) {
    console.log('');
    console.log('  ! INCOMPLETE — these institutions returned nothing this sync:');
    for (const m of result.missing) console.log(`      ${m}`);
    console.log('    The total above is missing whatever they hold. SimpleFIN reports');
    console.log('    no error for this, which is why it is checked here.');
    return 2;
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\nSync failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
