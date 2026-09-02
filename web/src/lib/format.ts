/**
 * Formatting. Whole dollars everywhere in the UI — cents are noise at this scale and
 * stay in the database.
 */

export function usd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`;
}

/** Compact form for the ledger-line label, where there is room for about six glyphs. */
export function usdCompact(cents: number): string {
  const dollars = Math.abs(Math.round(cents / 100));
  const sign = cents < 0 ? '-' : '';
  if (dollars >= 1_000_000) return `${sign}${(dollars / 1_000_000).toFixed(2)}m`;
  if (dollars >= 1_000) return `${sign}${(dollars / 1_000).toFixed(1)}k`;
  return `${sign}${dollars}`;
}

export function signed(cents: number): string {
  const arrow = cents >= 0 ? '▲' : '▼';
  return `${arrow} ${usd(Math.abs(cents))}`;
}

/**
 * SQLite datetimes have no zone marker but are UTC. Without the marker every timestamp
 * reads hours off, and "synced 2h ago" quietly becomes "synced in 3 hours".
 */
export function parseServerDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeAge(value: string | null, now = new Date()): string {
  const then = parseServerDate(value);
  if (!then) return 'never synced';

  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return 'synced just now';
  if (minutes < 60) return `synced ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `synced ${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `synced ${days}d ago`;
}

/** Per-account age. Institutions report at different times, so this is never one value. */
export function accountAge(days: number | null): string {
  if (days === null) return 'no date';
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}
