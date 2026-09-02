/**
 * Database bootstrap.
 *
 * Uses node:sqlite — SQLite is built into Node, so there is no native module to compile
 * and no toolchain requirement on the host or in the Docker image. The API is
 * synchronous, which is correct here: every query in this app is a single-row or
 * few-row read against a local file, and there is exactly one user.
 *
 * schema.sql is written entirely with CREATE TABLE IF NOT EXISTS, so applying it to an
 * existing database is a no-op. That is the whole migration story for now, and it is
 * honest: nothing is deployed, so there are no databases in the wild to migrate. The
 * moment a column needs changing rather than adding, this needs a real versioned runner.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../lib/env.ts';

export type Db = DatabaseSync;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, 'schema.sql');

let instance: Db | null = null;

export function openDb(path = config.databasePath): Db {
  const inMemory = path === ':memory:';
  const resolved = inMemory ? path : resolve(process.cwd(), path);
  if (!inMemory) mkdirSync(dirname(resolved), { recursive: true });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(resolved);
  } catch (err) {
    // SQLITE_CANTOPEN says nothing about why, and the usual why is a permission
    // problem on a mounted volume. State the path, who we are, and the one fix —
    // the raw error sends people looking at the database instead of the mount.
    if (err instanceof Error && /unable to open database file/i.test(err.message)) {
      const who =
        typeof process.getuid === 'function'
          ? `uid ${process.getuid()}:${process.getgid?.() ?? '?'}`
          : 'this user';
      throw new Error(
        `Cannot open the database at ${resolved} (running as ${who}).\n` +
          `The directory is usually owned by root while the container runs unprivileged. ` +
          `On the host: chown -R 1000:1000 <the directory bind-mounted to ${dirname(resolved)}>\n` +
          `If the filesystem uses ACLs (TrueNAS does by default), set the owner to uid 1000 ` +
          `in the dataset's permissions editor instead — ACLs override mode bits.`,
        { cause: err }
      );
    }
    throw err;
  }
  // WAL survives the process dying mid-write and lets a read happen during a sync.
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/**
 * Run fn inside a transaction, rolling back if it throws.
 *
 * node:sqlite has no transaction() wrapper, and a half-applied sync is worse than a
 * failed one: it would leave some accounts updated and others stale, then snapshot that
 * mixture as if it were a real moment in time.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Process-wide handle. Tests open their own in-memory instances instead. */
export function getDb(): Db {
  if (!instance) instance = openDb();
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}
