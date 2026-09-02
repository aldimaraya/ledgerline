/**
 * npm run backup -- [--out <dir>] [--keep <n>]
 *
 * Uses `VACUUM INTO`, not a file copy. Copying a live SQLite file is the classic way to
 * produce a backup that restores into a corrupt database: with WAL enabled the .db is
 * only part of the story, and a copy taken mid-write captures a torn page. VACUUM INTO
 * is transactional, safe while the app is running, and compacts as it goes.
 *
 * The whole application state is this one file, so this is the entire backup story.
 */

import { readdirSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDb } from '../db/index.ts';
import { config } from '../lib/env.ts';

const argv = process.argv.slice(2);
const valueOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : undefined;
};

const outDir = resolve(valueOf('--out') ?? process.env.BACKUP_DIR ?? './backups');
const keep = Number.parseInt(valueOf('--keep') ?? process.env.BACKUP_KEEP ?? '14', 10);

function main(): number {
  mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().slice(0, 10);
  const target = join(outDir, `ledgerline-${stamp}.db`);

  const db = openDb(config.databasePath);
  try {
    // VACUUM INTO refuses to overwrite, so a same-day re-run needs the old one gone.
    try {
      unlinkSync(target);
    } catch {
      /* first run today */
    }
    // The path is interpolated rather than bound: VACUUM INTO does not accept a
    // parameter. It comes from argv or env on this host, never from user input.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const size = statSync(target).size;
  console.log(`${target} (${(size / 1024).toFixed(0)} KB)`);

  // Prune, oldest first. Named by date, so lexical order is chronological.
  const existing = readdirSync(outDir)
    .filter((f) => /^ledgerline-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) {
    unlinkSync(join(outDir, old));
    console.log(`pruned ${old}`);
  }

  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`Backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
