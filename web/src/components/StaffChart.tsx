/**
 * The chart is a staff.
 *
 * Five evenly spaced hairlines, the series drawn across them, and where the current value
 * lands a short brass rule extends past the plot into the right margin carrying the
 * figure — a note above the staff needing a ledger line to hold it.
 *
 * One idea, used once, in the place the eye lands after the hero number.
 */

import { useMemo } from 'react';
import type { HistoryPoint } from '../lib/api.ts';
import { usdCompact } from '../lib/format.ts';

export type Series = 'net' | 'liquid' | 'retirement';

const VIEW_W = 300;
const VIEW_H = 118;
/** The plot stops short of the right edge; the ledger line and its label live past it. */
const PLOT_W = 258;
const STAFF_LINES = 5;

function valueOf(p: HistoryPoint, series: Series): number {
  if (series === 'liquid') return p.liquidCents;
  if (series === 'retirement') return p.retirementCents;
  return p.netCents;
}

export function StaffChart({
  points,
  series = 'net',
  reducedMotion = false,
}: {
  points: HistoryPoint[];
  series?: Series;
  reducedMotion?: boolean;
}) {
  const geometry = useMemo(() => {
    if (points.length < 2) return null;

    const values = points.map((p) => valueOf(p, series));
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series would divide by zero; give it a nominal band so the line sits
    // mid-staff rather than collapsing onto an edge.
    const span = max - min || Math.max(Math.abs(max), 1);

    const x = (i: number) => (i / (values.length - 1)) * PLOT_W;
    // SVG y grows downward, so the larger value gets the smaller y.
    const y = (v: number) => VIEW_H - ((v - min) / span) * VIEW_H;

    const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const lastY = y(values[values.length - 1]!);

    return { d, lastY, last: values[values.length - 1]! };
  }, [points, series]);

  if (!geometry) {
    return (
      <div className="plot">
        <p className="plot-empty">
          Not enough history yet.
          <br />
          The chart fills in as daily snapshots accumulate.
        </p>
      </div>
    );
  }

  const staffGap = VIEW_H / (STAFF_LINES - 1);
  // Keep the label inside the viewBox when the line ends near the top or bottom.
  const labelY = Math.min(Math.max(geometry.lastY + 3.3, 9), VIEW_H - 2);

  return (
    <div className="plot">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${series} over time, currently ${usdCompact(geometry.last)}`}
      >
        <g className="staffline">
          {Array.from({ length: STAFF_LINES }, (_, i) => {
            const y = i * staffGap;
            return <line key={i} x1="0" y1={y} x2={PLOT_W} y2={y} />;
          })}
        </g>

        <path
          className={`trace${series === 'retirement' ? ' is-retire' : ''}${reducedMotion ? '' : ' draw'}`}
          d={geometry.d}
        />

        <line className="ledger" x1={PLOT_W - 8} y1={geometry.lastY} x2={PLOT_W + 14} y2={geometry.lastY} />
        <circle className="ledger-dot" cx={PLOT_W} cy={geometry.lastY} r="2.6" />
        <text className="ledger-value" x={PLOT_W + 18} y={labelY}>
          {usdCompact(geometry.last)}
        </text>
      </svg>
    </div>
  );
}
