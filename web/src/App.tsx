import { useCallback, useEffect, useState } from 'react';

import {
  fetchHistory,
  fetchNetWorth,
  requestSync,
  type History,
  type NetWorth,
  type Range,
} from './lib/api.ts';
import { relativeAge } from './lib/format.ts';
import { usePullToRefresh } from './hooks/usePullToRefresh.ts';
import { HomeView } from './components/HomeView.tsx';
import { AccountsView } from './components/AccountsView.tsx';

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function App() {
  const [data, setData] = useState<NetWorth | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [range, setRange] = useState<Range>('1y');
  const [view, setView] = useState<'home' | 'accounts'>('home');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await fetchNetWorth());
      setFailed(false);
    } catch {
      // Keep whatever is on screen. The service worker may have served a cached figure,
      // and replacing it with an error would be strictly worse than a stale number that
      // is labelled as stale.
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    fetchHistory(range)
      .then((h) => !cancelled && setHistory(h))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [range]);

  /**
   * Force a refresh. The server owns the request budget, so this asks and reports —
   * it never decides for itself whether a fetch is allowed.
   */
  const sync = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await requestSync();

    if (result.ok) {
      await load();
      const h = await fetchHistory(range).catch(() => null);
      if (h) setHistory(h);
    } else if (result.reason === 'rate-limited') {
      // Not an error: the cap exists so the upstream token is never disabled.
      setNotice(`Refresh limit reached (${result.used}/${result.cap} today). Try later.`);
    } else if (result.reason === 'no-connection') {
      setNotice('No connection set up yet.');
    } else {
      setNotice(result.message ?? 'Sync failed.');
    }
    setBusy(false);
  }, [busy, load, range]);

  const { ref, pull, armed } = usePullToRefresh(sync);

  if (!data) {
    return (
      <div className="app">
        <div className="bar">
          <span className="wordmark">ledgerline</span>
        </div>
        <p className="skeleton">{failed ? 'Could not reach the server.' : 'Loading…'}</p>
      </div>
    );
  }

  const stale = data.stale || failed;

  return (
    <div className="app">
      <div className="bar">
        <button className="wordmark" onClick={() => setView('home')}>
          {view === 'accounts' ? '‹ ledgerline' : 'ledgerline'}
        </button>
        <button
          className={`sync${stale ? ' is-stale' : ''}${busy || data.syncing ? ' is-syncing' : ''}`}
          onClick={sync}
          disabled={busy}
          title="Refresh now"
        >
          {busy ? 'syncing…' : relativeAge(data.asOf)}
        </button>
      </div>

      {notice && (
        <div className="alarm" role="status">
          <div className="alarm-head">Not refreshed</div>
          <p className="alarm-body">{notice}</p>
        </div>
      )}

      <div className="shell">
        <div
          className="pull"
          style={{ height: pull, opacity: pull > 8 ? 1 : 0 }}
          aria-hidden="true"
        >
          {armed ? 'release to refresh' : 'pull to refresh'}
        </div>

        <div ref={ref} className="scroll" style={{ transform: `translateY(${pull}px)` }}>
          {view === 'home' ? (
            <HomeView
              data={data}
              history={history}
              range={range}
              onRange={setRange}
              onOpenAccounts={() => setView('accounts')}
              onRetry={sync}
              busy={busy}
              reducedMotion={prefersReducedMotion()}
            />
          ) : (
            <AccountsView data={data} />
          )}
        </div>
      </div>
    </div>
  );
}
