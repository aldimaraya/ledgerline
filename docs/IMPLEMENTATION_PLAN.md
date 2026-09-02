# Implementation plan

Seven phases. Each one ends somewhere you could stop and still have something that works.
That's deliberate — the risk with a personal project is a half-finished thing that never
gets used, so every phase produces a usable artifact.

Rough total: **12–16 hours**, comfortably spread across a few evenings.

---

## Phase 0 — Prove the data exists (~45 min)

Do this before writing any application code. Everything downstream assumes your four
institutions work.

- [ ] Subscribe to SimpleFIN Bridge ($15/yr)
- [ ] Search and connect every institution you want tracked
- [ ] Create an app connection, generate a setup token
- [ ] Exchange it manually and dump the raw response:
      ```bash
      CLAIM=$(echo "$SETUP_TOKEN" | base64 -d)
      ACCESS_URL=$(curl -s -X POST "$CLAIM")
      curl -s "$ACCESS_URL/accounts" | jq . > docs/sample-response.json
      ```
- [ ] Read the JSON. Confirm every account you expect is present, note the sign convention
      on any credit or loan account, and check which brokerages return `holdings`

**Exit criteria:** a real `sample-response.json` on disk. This file is now your fixture
for every test you write. If an institution is missing or broken, you find out here for
the cost of an hour — not after building a UI around data that doesn't arrive.

---

## Phase 1 — Data layer (~2h)

- [ ] Scaffold the Fastify + TypeScript server
- [ ] SQLite schema and migration runner (see `server/src/db/schema.sql`)
- [ ] Typed SimpleFIN client: claim token, fetch accounts, parse response
- [ ] Ingest logic: upsert accounts, normalize signs, record `last_synced_at`
- [ ] AES-256-GCM encryption for the stored access URL
- [ ] CLI command `npm run sync` that pulls and prints your net worth to the terminal

**Exit criteria:** running one command prints your correct net worth. At this point the
project already does its job — everything after this is ergonomics.

---

## Phase 2 — API and caching (~2h)

- [ ] `GET /api/networth` — current total, per-account breakdown, staleness per connection
- [ ] `GET /api/history?range=1y` — snapshot series for charting
- [ ] `POST /api/sync` — force refresh, respecting the rate limiter
- [ ] Stale-while-revalidate: always serve cached, revalidate in background past TTL
- [ ] Request budget guard — hard cap at 20 SimpleFIN calls/day, well under the limit of 24
- [ ] Daily snapshot job at 23:55 via `node-cron`

**Exit criteria:** `curl localhost:3000/api/networth` returns correct JSON instantly, and
hammering it doesn't produce more than a couple of upstream requests.

---

## Phase 3 — The phone app (~4h)

The screen you'll actually look at. Design it for the five seconds you'll give it.

- [ ] Vite + React + TypeScript, built to static files the server hosts
- [ ] **Main view:** total net worth, large. Liquid and retirement side by side beneath it.
      Change since yesterday and since a month ago. History chart below. Nothing else above
      the fold.
- [ ] Chart toggles between total / liquid / retirement, or stacks all three
- [ ] **Accounts view:** grouped by bucket, then institution — each with balance and
      last-updated
- [ ] Pull-to-refresh triggering `POST /api/sync`
- [ ] Stale and error states rendered inline, not hidden in a settings screen
- [ ] PWA manifest + service worker: standalone display, app icon, last-known number cached
      so a cold open on bad signal still shows something

**Exit criteria:** the app is on your home screen and opens to your net worth in under a
second.

---

## Phase 4 — Setup and configuration (~2h)

Everything that currently only works because you did it by hand in Phase 0.

- [ ] Onboarding flow: paste setup token → claim → discover accounts
- [ ] Classify each account: asset / liability / excluded, and liquid / retirement /
      illiquid. Pre-filled by `guessBucket()` so it's a review, not a form.
- [ ] Reconnect flow for expired connections — OAuth-based institutions will need it
- [ ] Passcode gate with signed httpOnly session cookie

**Exit criteria:** you could wipe the database and set the whole thing back up from the UI
without touching a terminal.

---

## Phase 5 — Deploy (~1.5h)

- [ ] Multi-stage Dockerfile: build web, build server, slim runtime image
- [ ] `docker-compose.yml` with a volume for `./data`
- [ ] Bind to localhost + Tailscale interface only
- [ ] Tailscale Serve for HTTPS on the tailnet, so the PWA gets a valid cert
- [ ] Nightly `sqlite3 .backup` to your existing self-hosted storage
- [ ] Health endpoint that reports last successful sync per connection

**Exit criteria:** it survives a reboot of the host and you can reach it from cellular
data with Tailscale on.

---

## Phase 6 — Worth having, not urgent (open-ended)

Pick from these only once you've used the thing for a few weeks and know what you miss.

- [ ] Asset allocation view from the `holdings` data
- [ ] Milestone alerts via ntfy or Pushover
- [ ] CSV export
- [ ] **CSV history import** — backfill `snapshots` from an Empower export, or any
      `date,account,balance` file. A ~40-line script, not a UI. Do it before you cancel
      Empower; after that the data is gone.
- [ ] **Manual accounts** — only if you find something worth tracking by hand. See below.
- [ ] Face ID unlock via WebAuthn

---

## On illiquid assets and the car

Short answer: **omit it.** There's no free real-time valuation API to hang it on.

- **Kelley Blue Book** has no public API at all
- **Edmunds'** public vehicle API was shut down; Edmunds is CarMax-owned now and the data
  is partner-gated
- Commercial alternatives (Vehicle Databases and similar) sell valuation endpoints, but
  they're paid — which defeats the point of a $15/year stack
- **NHTSA's vPIC API** is genuinely free and open, but it only decodes a VIN into specs.
  No pricing data.

The fallback would be modelling a depreciation curve from your purchase price. That's not
real-time; it's a formula pretending to be data, and it would drift from reality in a
direction you can't see. A confidently wrong number is the thing this app is specifically
built not to produce.

**What this changes in the plan:** manual accounts drop out of Phase 4 entirely and move
to Phase 6. That's about an hour saved and a whole CRUD surface you don't build.

**What stays:** the `bucket` column and its `illiquid` value remain in the schema. It's one
column with a default, it costs nothing to carry, and if you take on a mortgage or want to
track a property later, the snapshot history will already have the shape for it. Adding it
after two years of snapshots exist is the expensive version.

The v1 UI shows liquid and retirement. Illiquid renders only if an account is tagged that
way, which nothing will be.

---

## On expense tracking

You're right that it balloons scope — but the reason is worth being specific about,
because it changes what the right answer is.

Net worth tracking is a **read-only, once-daily, four-number problem**. Expense tracking is
a **continuous data-quality problem**: transaction dedup across re-fetches, pending →
posted transitions that change amounts and IDs, merchant name normalization, split
transactions, transfers between your own accounts appearing twice with opposite signs, and
a categorization rule engine you tune forever. One person running a comparable setup
described needing 65+ categorization rules before it was useful.

That's not a phase. That's a second project roughly 3–4× the size of this one, and it
requires a daily review habit or the data silently rots.

**The alternative worth considering first:** the SimpleFIN Bridge lets you connect
<https://beta-bridge.simplefin.org/> to **up to 25 apps** on one subscription. So you can
point Actual Budget at the same Bridge account, for no additional cost, and get a mature
expense tracker with a real rule engine that someone else maintains. Two apps, one $15/year
subscription, each doing the thing it's good at.

Ledgerline stays the five-second glance. Actual is where you sit down and categorize.

**If you still want it in-house later**, v1 is already built so it isn't a rewrite:

- `balances-only=1` is a flag on one call — dropping it returns transactions
- Transactions *can* be backfilled, unlike holdings — SimpleFIN serves history in 90-day
  windows, though how far back varies by institution
- The `accounts` table needs no changes; a `transactions` table hangs off it

The one thing to do now: when you first connect, note in `docs/sample-response.json` how
much transaction history each institution actually returns. If one only gives 90 days,
that's a reason to start capturing sooner even if you don't build the UI for a year.

**Suggested sequencing:** ship Phases 0–5, run Actual alongside it for two months, then
decide. You'll either find Actual does the job, or you'll know exactly which three things
it doesn't do — which is a far better spec than anything you'd write today.

---

## Decisions already made

| Question | Answer | Why |
| --- | --- | --- |
| Real-time sync? | No, ~daily | SimpleFIN refreshes daily; net worth doesn't move meaningfully faster |
| Cache TTL | 12h | Comfortably inside the 24 req/day quota with room for manual refreshes |
| Native app? | No, PWA | Avoids App Store, certs, and annual resigning for a single-user app |
| Multi-user? | No | Single user. Adding auth complexity buys nothing. |
| Store transactions? | Not initially | Net worth needs balances. Transactions are a whole other product — see below. |
| Split retirement vs liquid? | Yes, in v1 | Two-axis tagging; cheap now, awkward to retrofit into snapshot history later |
| Track the car / illiquid assets? | No | No free real-time valuation API exists. Schema keeps the bucket; the UI doesn't. |
| Backfill Empower history? | Optional, Phase 6 | Nice to have. Export before cancelling — it's unrecoverable after. |
| Store holdings? | Yes, from day one | Free to capture, expensive to backfill |
| Display cents? | No — whole dollars in the UI | Noise at this scale; cents stay in the DB as integers |

## Open questions for you

1. Before cancelling Empower, check what its export actually contains — if there's a
   net worth or balance history in there, keep the file. The importer is trivial to write
   later; regenerating the data is impossible.
2. Any accounts SimpleFIN can't reach at all? Phase 0 will tell you. If the answer is
   "none," manual accounts stay cut and the scope holds.

---

## Phase 0 findings (from `docs/sample-response.json`)

These came from reading two real responses, not from assumptions. Violating any of them
produces a silently wrong number, which is the one failure mode this app must not have.

Real balances are deliberately not in this file. The current baseline, per-account figures
and the Phase 1 target total live in `docs/BASELINE.local.md`, which is gitignored.

The first capture returned 8 accounts across 3 orgs with one institution missing entirely.
The second returned 10 across 4, with everything connected.

| Finding | Consequence |
| --- | --- |
| Liabilities already arrive negative | `normalizeBalance` must NOT flip signs. Sum raw balances. |
| `available-balance` is `0.00` on most accounts | Unusable. Never read it. `balance` only. |
| Holdings don't sum to balance (uninvested cash is not a position) | Balance is authoritative. Holdings are for allocation only, never for totals. |
| A stock plan reports `shares: "0.00"` with a real `market_value` | `market_value` is the only trustworthy holdings field. |
| `balance-date` spans more than a day across orgs | Per-account staleness in the UI is required, not a nicety. |
| A missing institution produced an **empty** `errors` array | Absence is silent. Must track expected orgs to detect it. |
| `guessBucket()` misfiled an employer retirement plan as `liquid` | Total is unaffected; the liquid/retirement split is not. Widen the pattern and make Phase 4 review mandatory. |
| `x-api-message` asks for `start-date` for older transactions | Default window is yesterday-onward. |

### On the bucket guess

`guessBucket()` matches `hsa` and `401k` as tokens, but institutions don't write them that
way — an HSA may be named "Health Savings Account" and an employer 401(k) can be named
after the company with no plan-type word at all. Both fell through to `liquid`.

Two consequences worth carrying into Phase 3 and 4:

- Widen the pattern (`health savings`, `savings plan`, `retirement`, `thrift`).
- A wrong bucket doesn't change the total, so no test on net worth will catch it. Assert on
  the *split*, not just the sum.
