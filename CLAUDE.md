# Ledgerline

Self-hosted personal net worth tracker. Single user. Replaces a commercial tracker.

Read `docs/IMPLEMENTATION_PLAN.md` before starting work — it has the phase breakdown,
every decision already made and why, and the Phase 0 findings from real data.
`docs/ARCHITECTURE.md` has the system design. `design/DESIGN.md` has the visual language
and `design/mockups.html` has four rendered screens that are the spec for Phase 3.

## Stack

Fastify + TypeScript, SQLite, React + Vite PWA served statically by the same Node process.
One Docker container. Tailscale-only access, no public ingress. Data from SimpleFIN Bridge
(read-only protocol, ~$15/yr).

## Current state

Phase 0 is complete. Phases 1–5 are unstarted.

Written and reviewed: `server/src/db/schema.sql`, `server/src/simplefin/client.ts`,
`server/src/lib/networth.ts`. Nothing is wired together yet — there is no entry point,
no server, no migrations runner, no tests.

`docs/sample-response.json` is a real, unredacted-shape response from the user's own
accounts. Use it as the fixture for every test. Do not invent mock data when this exists.

## Rules that came from real data, not assumptions

These were learned in Phase 0 by reading an actual response. Violating them produces a
silently wrong number, which is the one failure mode this app must not have.

- **Balance signs arrive correct.** Credit cards arrive negative.
  `normalizeBalance` is idempotent and stays as a guard, but do not add sign-flipping.
- **Never read `available-balance`.** Institutions report it as `0.00` on most accounts,
  including ones whose `balance` is non-zero. It carries no usable information.
- **`balance` is authoritative; holdings are not.** Holdings can sum short of the account
  balance, because uninvested cash is not a position. Holdings drive the allocation view
  only. Never total them.
- **`market_value` is the only trustworthy holdings field.** Some accounts report
  `shares: "0.00"` next to a non-zero `market_value`.
- **A missing institution produces an empty `errors` array.** Absence is silent. The app
  must persist the list of expected orgs and diff against what arrives, or the total
  quietly shrinks. This drives the "incomplete" state in mockup 04.
- **`guessBucket()` under-detects retirement accounts.** Institutions spell things out
  ("Health Savings Account", not "HSA") and employer plans often never say "401k".
  On real data this misfiled an entire account into `liquid`. The total is unaffected but
  the headline split is badly wrong, so treat the guess as a low-confidence suggestion and
  make Phase 4's review step mandatory for large balances.
- **`balance-date` spans more than a day across institutions.** Per-account staleness in
  the UI is required. There is no single "as of" time.
- **Money is integer cents everywhere.** No floats.

## Conventions

- Two orthogonal axes per account: `classification` (asset/liability/excluded) and
  `bucket` (liquid/retirement/illiquid). Snapshots denormalize both at write time so
  reclassifying an account later does not rewrite chart history.
- `illiquid` exists in the schema but nothing is tagged it and the UI does not render it.
- UI shows whole dollars, no cents. Cents stay in the database.
- Self-cap at 20 SimpleFIN requests/day. The hard limit is 24 and exceeding it disables
  the access token.
- The access URL is a live credential. AES-256-GCM at rest, never logged, never in the
  client bundle.

## Working style

Each phase must end somewhere usable. Do not scaffold all five phases at once — Phase 1
exits when `npm run sync` prints the correct net worth in a terminal, and that number
must match the baseline recorded in `docs/BASELINE.local.md` against the fixture. That file
is gitignored: real balances stay off GitHub, so figures live there and never in tracked
docs.
