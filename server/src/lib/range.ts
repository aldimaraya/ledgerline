/**
 * Chart range parsing, kept separate because it is pure and worth testing directly.
 */

export const RANGES = ['1m', '3m', '6m', '1y', 'all'] as const;
export type Range = (typeof RANGES)[number];

export function isRange(v: string): v is Range {
  return (RANGES as readonly string[]).includes(v);
}

/**
 * The earliest date a range includes, as YYYY-MM-DD, or null for "all".
 *
 * Snapshots are stored as local calendar dates, so this works in calendar months rather
 * than fixed day counts — "3 months ago" should mean the same date three months back,
 * not 90 days, or the chart's left edge drifts against the month labels above it.
 */
export function sinceDate(range: Range, now = new Date()): string | null {
  if (range === 'all') return null;

  const d = new Date(now);
  if (range === '1y') {
    d.setFullYear(d.getFullYear() - 1);
  } else {
    const months = Number.parseInt(range, 10);
    // setMonth handles the year rollover, and clamps 31 May → 31 Feb to early March
    // rather than throwing. Off-by-a-day at a month boundary is invisible on a chart.
    d.setMonth(d.getMonth() - months);
  }
  return d.toISOString().slice(0, 10);
}
