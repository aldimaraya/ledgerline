# Architecture

## Shape of the thing

```
  iPhone (PWA)
      │
      │  HTTPS over Tailscale — never exposed to the public internet
      ▼
  ┌─────────────────────────────────────────┐
  │  Docker container                       │
  │                                         │
  │  Fastify server (TypeScript)            │
  │    ├── /api/*        JSON API           │
  │    ├── static        built React PWA    │
  │    └── sync engine   cache + fetch      │
  │                │                        │
  │                ▼                        │
  │  SQLite (./data/ledgerline.db)          │
  │    accounts, snapshots, connections     │
  └────────────────┬────────────────────────┘
                   │  read-only access URL (HTTP Basic)
                   ▼
          SimpleFIN Bridge  ──▶  MX  ──▶  your banks
```

One container. One SQLite file. No message queue, no Redis, no separate frontend host.
Everything that matters lives in a single file you can back up with `cp`.

## Why these pieces

**SimpleFIN over Plaid.** Read-only by protocol design, $15/year instead of enterprise
pricing, and the access URL is revocable from the Bridge dashboard with one click. Your
bank credentials go to SimpleFIN, never to this app.

**SQLite over Postgres.** Single user, single writer, tiny dataset — a decade of daily
snapshots across a dozen accounts is a few megabytes. Backing up is copying a file.

**Fastify + TypeScript.** Small, fast, and the SimpleFIN response shape is worth having
types for. The whole server is a few hundred lines.

**PWA over native iOS.** No App Store, no signing certificate to renew annually, no
TestFlight expiry. Add to Home Screen gives you an icon and a full-screen app. If you
later want widgets or Face ID unlock, that's the moment to reach for native — not before.

**Tailscale over a public reverse proxy.** The threat model for a net worth app is "don't
be on the internet." Tailscale means there's no login page for anyone to find, no TLS
cert to manage, and no port forwarded on your router.

## The sync model

You asked for fetch-on-open rather than a daily cron, which is the right call — here's how
it resolves against SimpleFIN's constraints.

SimpleFIN allows **24 requests per day** against `/accounts`. Exceeding it produces
warnings, then disables your token. But the Bridge only refreshes from your banks roughly
once daily anyway, so requesting more often returns the same numbers.

So the rule is:

```
on app open:
  if cache age < TTL (default 12h):
      serve from SQLite, render instantly
  else:
      serve from SQLite immediately (stale-while-revalidate)
      fire background fetch
      push updated numbers to the client when they land
```

The app never blocks on the network. You open it, you see a number, and if that number is
stale it quietly corrects itself a second later. Practically this means 1–3 requests per
day even if you check it obsessively.

A **daily snapshot job** runs separately at 23:55 local time and writes one row per
account to `snapshots`. This is what builds your history — without it you'd only ever have
"right now" and the chart would be empty. It's the one piece of scheduled work in the
system, and it uses whatever the cache already holds rather than forcing a fresh pull.

## Net worth math

Accounts are tagged on **two independent axes**, because they answer different questions
and collapsing them into one enum breaks on real accounts.

**Axis 1 — `classification`: does it count, and which way?**

| Classification | Effect on net worth |
| --- | --- |
| `asset` | added |
| `liability` | subtracted (SimpleFIN reports credit card balances as negative already — normalize on ingest) |
| `excluded` | ignored (e.g. a business account, or a joint account you don't want counted) |

**Axis 2 — `bucket`: how reachable is it?**

| Bucket | Contents |
| --- | --- |
| `liquid` | Spendable this week — checking, savings, taxable brokerage |
| `retirement` | Penalty or age-gated — 401(k), IRA, Roth, HSA |
| `illiquid` | Real but slow — property, vehicles, private equity |

Keeping these separate is what makes a 401(k) loan (liability + retirement) and a HELOC
(liability + illiquid) both representable. One combined enum would need a row per
combination and would still be wrong the first time you hit an edge case.

The headline number stays your total net worth. Underneath it, the liquid and retirement
figures sit side by side — because "I have $X I could actually touch" and "I have $Y that
compounds until I'm 60" are decisions you make differently, and averaging them into one
number hides both.

Snapshots freeze `bucket` and `classification` at write time rather than joining to
`accounts`. If you roll a 401(k) into an IRA next year, your history should still show what
was true then, not retroactively rewrite three years of charts.

`guessBucket()` seeds a default from the account name on discovery (`Roth IRA` →
retirement) so onboarding is confirming rather than configuring. Always overridable.

Sign handling is the single most likely source of a wrong number. The ingest layer
normalizes everything to "positive means you own it, negative means you owe it" and stores
the raw value alongside it so you can audit.

**Manual accounts** are first-class: your car, a property, a loan from a family member,
cash under the mattress. These are rows with no `connection_id` and a value you set by
hand, with an `as_of` date. Without them the number is wrong, and a net worth tracker with
a wrong number is worse than no tracker.

## Security

| Concern | Handling |
| --- | --- |
| Bank credentials | Never touch this app. They live at SimpleFIN/MX. |
| SimpleFIN access URL | Encrypted at rest with AES-256-GCM using a key from `ENCRYPTION_KEY`. The key lives in the environment, not the database. |
| Network exposure | Bound to `127.0.0.1` and the Tailscale interface only. No public ingress. |
| App access | A passcode gate with a signed httpOnly session cookie. Thin by design — Tailscale is the real perimeter, this is defense in depth for when your phone is unlocked on a table. |
| Setup token | One-time use. Exchanged for the access URL on submit and never persisted. |
| Backups | The SQLite file is encrypted-at-rest only for the access URL, not wholesale. If you sync backups off-box, encrypt them there. |

## Handling your four institutions

All four are large MX-supported institutions and should connect through the Bridge. Worth
knowing before you start:

- Some brokerages return a `holdings` array with per-position symbol, shares, and market
  value. Store it — it costs nothing now and enables an allocation view later.
- Others likewise report brokerage positions. Multiple account types (brokerage, IRA,
  checking) arrive as separate accounts under one connection.
- Some institutions use an OAuth-style consent flow at the Bridge rather than credential
  entry. Reconnection is periodically required when consent expires — the app should
  surface a clear per-institution "reconnect" state rather than silently showing stale numbers.
- Brokerages that have been acquired may appear under the parent company's name in the Bridge
  institution search.

**Verify before you write code.** Search each one at
<https://beta-bridge.simplefin.org/search-institutions> and, ideally, connect all four and
inspect the raw `/accounts` JSON. Step 0 of the plan exists for exactly this reason — if
one of them doesn't work, you want to know on day one, not after building the UI.

## Staleness is a first-class UI concern

Every account displays when it last updated. If a connection has been failing for four
days, the app says so on the main screen. A number that is confidently wrong is the worst
outcome this app can produce.
