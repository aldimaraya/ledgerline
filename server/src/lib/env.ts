/**
 * Configuration, read once at startup.
 *
 * Everything is validated here rather than at the point of use, so a misconfigured
 * deployment fails immediately and loudly instead of halfway through a sync.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in — see docs/SETUP.md.`
    );
  }
  return v.trim();
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${v}`);
  return n;
}

export const config = {
  databasePath: process.env.DATABASE_PATH?.trim() || './data/ledgerline.db',
  cacheTtlHours: int('CACHE_TTL_HOURS', 12),
  /** Self-imposed ceiling. SimpleFIN's hard limit is 24 and exceeding it disables the token. */
  maxDailyRequests: int('MAX_DAILY_REQUESTS', 20),
  /** Deadline for one upstream request. See DEFAULT_TIMEOUT_MS in the SimpleFIN client. */
  simplefinTimeoutMs: int('SIMPLEFIN_TIMEOUT_MS', 45_000),
  port: int('PORT', 3000),
  get encryptionKey(): string {
    return required('ENCRYPTION_KEY');
  },
};
