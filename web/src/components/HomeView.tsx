/**
 * The main screen. The whole answer above the fold: the total, its two components, and
 * the shape of the year. Nothing to dismiss.
 */

import { useMemo, useState } from 'react';
import type { History, NetWorth, Range } from '../lib/api.ts';
import { signed, usd } from '../lib/format.ts';
import { StaffChart, type Series } from './StaffChart.tsx';
import { Alarms } from './Alarm.tsx';

const RANGES: { key: Range; label: string }[] = [
  { key: '1m', label: '1M' },
  { key: '6m', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: 'all', label: 'ALL' },
];

const SERIES: { key: Series; label: string }[] = [
  { key: 'net', label: 'TOTAL' },
  { key: 'liquid', label: 'LIQUID' },
  { key: 'retirement', label: 'RETIRE' },
];

/**
 * Change since the previous snapshot, and since roughly a month back.
 *
 * Returns null rather than zero when there is nothing to compare against. "▲ $0 today"
 * on a fresh install reads as a real, unchanging balance; absence reads as absence.
 */
function deltas(history: History | null, currentCents: number) {
  const points = history?.points ?? [];
  if (points.length < 2) return { since: null as number | null, month: null as number | null };

  const previous = points[points.length - 2]!.netCents;
  const monthAgo = points[Math.max(0, points.length - 31)]!.netCents;

  return {
    since: currentCents - previous,
    month: points.length >= 3 ? currentCents - monthAgo : null,
  };
}

export function HomeView({
  data,
  history,
  range,
  onRange,
  onOpenAccounts,
  onRetry,
  busy,
  reducedMotion,
}: {
  data: NetWorth;
  history: History | null;
  range: Range;
  onRange: (r: Range) => void;
  onOpenAccounts: () => void;
  onRetry: () => void;
  busy: boolean;
  reducedMotion: boolean;
}) {
  const [series, setSeries] = useState<Series>('net');

  const { since, month } = useMemo(
    () => deltas(history, data.netWorthCents),
    [history, data.netWorthCents]
  );

  const counts = useMemo(() => {
    const active = data.accounts.filter((a) => a.classification !== 'excluded');
    return {
      liquid: active.filter((a) => a.bucket === 'liquid').length,
      retirement: active.filter((a) => a.bucket === 'retirement').length,
      orgs: new Set(active.map((a) => a.orgName)).size,
      total: active.length,
    };
  }, [data.accounts]);

  return (
    <>
      <div className="hero">
        <div className="eyebrow">Net worth</div>
        {/* Greyed when an institution is missing: still a number, no longer authoritative. */}
        <div className={`total${data.complete ? '' : ' is-uncertain'}`}>
          {usd(data.netWorthCents)}
        </div>

        {since !== null ? (
          <div className={`delta${since < 0 ? ' is-down' : ''}`}>
            {signed(since)} <em>since last</em>
            {month !== null && (
              <>
                <span aria-hidden="true">·</span>
                {signed(month)} <em>30d</em>
              </>
            )}
          </div>
        ) : (
          <div className="delta">
            <em>no history yet — snapshots build it daily</em>
          </div>
        )}
      </div>

      <div className="staff-rule" />

      <div className="buckets">
        <div className="bucket liquid">
          <div className="bucket-name">Liquid</div>
          <div className="bucket-figure">{usd(data.byBucket.liquid.netCents)}</div>
          <div className="bucket-sub">{counts.liquid} accounts</div>
        </div>
        <div className="bucket retire">
          <div className="bucket-name">Retirement</div>
          <div className="bucket-figure">{usd(data.byBucket.retirement.netCents)}</div>
          <div className="bucket-sub">{counts.retirement} accounts</div>
        </div>
      </div>

      <StaffChart points={history?.points ?? []} series={series} reducedMotion={reducedMotion} />

      {/* Two rows rather than one: seven controls do not fit across a phone, and the
          two questions they answer — how far back, and which series — are different. */}
      <div className="ranges" role="group" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`range${r.key === range ? ' is-on' : ''}`}
            onClick={() => onRange(r.key)}
            aria-pressed={r.key === range}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="ranges is-series" role="group" aria-label="Series">
        {SERIES.map((s) => (
          <button
            key={s.key}
            className={`range${s.key === series ? ' is-on' : ''}`}
            onClick={() => setSeries(s.key)}
            aria-pressed={s.key === series}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Alarms data={data} onRetry={onRetry} busy={busy} />

      <div className="spacer" />

      <button className="jump" onClick={onOpenAccounts}>
        <span className="jump-title">Accounts</span>
        <span className="jump-meta">
          {counts.total} across {counts.orgs} institutions ›
        </span>
      </button>
    </>
  );
}
