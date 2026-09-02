/**
 * Error and incomplete states, rendered inline on the main screen rather than hidden in
 * a settings screen.
 *
 * Every one states what broke and the single action that fixes it. No apology, no vague
 * "something went wrong" — a number without an explanation for why it might be wrong is
 * the failure mode this whole app is built to avoid.
 */

import type { NetWorth } from '../lib/api.ts';

export function Alarms({
  data,
  onRetry,
  busy,
}: {
  data: NetWorth;
  onRetry: () => void;
  busy: boolean;
}) {
  const broken = data.connections.filter((c) => c.consecutiveErrors > 0);

  return (
    <>
      {/*
        The silent failure: an institution returns nothing, SimpleFIN reports no error,
        and the total simply shrinks. This is the only thing that surfaces it.
      */}
      {data.missingOrgs.length > 0 && (
        <div className="alarm" role="status">
          <div className="alarm-head">Incomplete</div>
          <p className="alarm-body">
            {data.missingOrgs.join(', ')} {data.missingOrgs.length === 1 ? 'returned' : 'returned'}{' '}
            nothing on the last sync, so the total above is missing whatever{' '}
            {data.missingOrgs.length === 1 ? 'it holds' : 'they hold'}.
          </p>
          <button className="alarm-act" onClick={onRetry} disabled={busy}>
            {busy ? 'Syncing…' : 'Try again'}
          </button>
        </div>
      )}

      {broken.map((c) => (
        <div className="alarm" key={c.id} role="status">
          <div className="alarm-head">Connection failing</div>
          <p className="alarm-body">
            {c.lastSyncError ?? 'The last sync failed.'}
            {c.consecutiveErrors > 1 && ` Failed ${c.consecutiveErrors} times in a row.`}
          </p>
          <button className="alarm-act" onClick={onRetry} disabled={busy}>
            {busy ? 'Syncing…' : 'Retry now'}
          </button>
        </div>
      ))}

      {data.errors.map((e, i) => (
        <div className="alarm" key={`e${i}`} role="status">
          <div className="alarm-head">Institution error</div>
          <p className="alarm-body">{e}</p>
        </div>
      ))}
    </>
  );
}
