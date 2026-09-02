/**
 * Accounts, grouped by bucket then institution.
 *
 * Every row carries its own age. Institutions report at different times — the spread is
 * more than a day — so a single "as of" at the top would be a lie about most of them.
 */

import type { Account, NetWorth } from '../lib/api.ts';
import { accountAge, usd } from '../lib/format.ts';

/** Anything this old is called out in rust rather than left to be read as current. */
const STALE_DAYS = 3;

interface Group {
  key: string;
  label: string;
  className: string;
  accounts: Account[];
  sumCents: number;
}

function groupsOf(accounts: Account[]): Group[] {
  const liabilities = accounts.filter((a) => a.classification === 'liability');
  const assets = accounts.filter((a) => a.classification === 'asset');

  const byBucket = (bucket: string) => assets.filter((a) => a.bucket === bucket);
  const sum = (rows: Account[]) => rows.reduce((n, a) => n + a.balanceCents, 0);

  const sortRows = (rows: Account[]) =>
    [...rows].sort(
      (a, b) => a.orgName.localeCompare(b.orgName) || Math.abs(b.balanceCents) - Math.abs(a.balanceCents)
    );

  const candidates: Group[] = [
    { key: 'liquid', label: 'Liquid', className: 'liquid', accounts: sortRows(byBucket('liquid')), sumCents: 0 },
    { key: 'retirement', label: 'Retirement', className: 'retire', accounts: sortRows(byBucket('retirement')), sumCents: 0 },
    // Styled but never rendered in v1 — nothing is tagged illiquid. It appears only if
    // something actually is, rather than sitting there as an empty heading.
    { key: 'illiquid', label: 'Illiquid', className: 'retire', accounts: sortRows(byBucket('illiquid')), sumCents: 0 },
    { key: 'owed', label: 'Owed', className: 'owed', accounts: sortRows(liabilities), sumCents: 0 },
  ];

  return candidates
    .filter((g) => g.accounts.length > 0)
    .map((g) => ({ ...g, sumCents: sum(g.accounts) }));
}

export function AccountsView({ data }: { data: NetWorth }) {
  const groups = groupsOf(data.accounts.filter((a) => a.classification !== 'excluded'));
  const orgs = new Set(data.accounts.map((a) => a.orgName)).size;

  return (
    <div className="scroll">
      {groups.map((g) => (
        <section key={g.key}>
          <div className={`group ${g.className}`}>
            <h2 className="group-name">{g.label}</h2>
            <div className="group-sum">{usd(g.sumCents)}</div>
          </div>

          {g.accounts.map((a) => {
            const stale = a.stalenessDays !== null && a.stalenessDays >= STALE_DAYS;
            return (
              <div className="row" key={a.id}>
                <div className="row-id">
                  <div className="row-name">{a.name}</div>
                  <div className="row-org">{a.orgName}</div>
                </div>
                <div>
                  <div className={`row-amt${a.classification === 'liability' ? ' owed' : ''}`}>
                    {usd(a.balanceCents)}
                  </div>
                  <div className={`row-age${stale ? ' is-stale' : ''}`}>
                    {accountAge(a.stalenessDays)}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      ))}

      <div className="group">
        <div className="group-sum">
          {data.accounts.length} accounts across {orgs} institutions
        </div>
      </div>
    </div>
  );
}
